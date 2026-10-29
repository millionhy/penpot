// The workspace collaboration client (F8.2): the subscription lifecycle and
// the inbound routing of app.main.data.workspace.notifications.
//
// Ported from frontend/src/app/main/data/workspace/notifications.cljs:
// - initialize sends subscribe-file (with the Penpot version) and
//   subscribe-team, and re-sends both on every reconnect, because a fresh
//   socket carries no subscriptions and a send made before open is dropped;
// - finalize sends unsubscribe-file and only then closes;
// - process-message routes by :type after a topic filter that keeps the
//   messages of the system (the zero uuid), the profile, the team and the
//   file.
//
// The server shapes the messages (backend/src/app/http/websocket.clj and
// rpc/commands/files_update.clj): every delivery carries the msgbus :topic,
// file-change carries the POST-commit revn/vern and the committed changes,
// file-restored the vern of the restored snapshot, and file-deleted only the
// id. A remote change never echoes back to its author: the server drops the
// messages whose :session-id is the connection's own.
//
// Out of scope on purpose (rewrite.md 7.46): library-change, notification
// and the team/organization events, the comment broadcast, and dashboard
// subscriptions. They classify as ignored so the caller can trace them
// without acting.

import { config } from "@/lib/config";
import { ZERO_UUID } from "@/lib/file-data";
import type { UpdateFileChange, UpdateFilePageChange } from "@/lib/transit";
import {
  createWorkspaceSocket,
  workspaceSocketUri,
  type WorkspacePoint,
  type WorkspacePointerUpdate,
  type WorkspaceRect,
  type WorkspaceSocket,
  type WorkspaceSocketOptions,
  type WorkspaceSocketState,
} from "@/lib/workspace-socket";

// --- Inbound messages ------------------------------------------------------

// {:type :file-change :profile-id .. :file-id .. :session-id .. :revn :vern
//  :changes [..]}: another client committed an update-file. revn and vern are
//  the values AFTER that commit (the HTTP response of the author carries the
//  value before it).
export interface RemoteFileChange {
  fileId: string;
  revn: number;
  vern: number;
  changes: UpdateFileChange[];
}

export interface FileRestored {
  fileId: string;
  vern: number;
}

// The presence family: join-file and leave-file (a file subscription opened
// or closed), presence (the server echoes the join/leave of the file topic)
// and disconnect (a closing socket announced on the file topic, which
// carries no file-id of its own).
export interface PresenceEvent {
  type: "join-file" | "leave-file" | "presence" | "disconnect";
  fileId: string;
  sessionId: string;
  profileId: string | null;
}

// {:type :pointer-update .. :page-id :zoom :zoom-inverse :vbox :vport
//  :position {x y}}: the cursor of another session. handle-pointer-update
//  stores the position as its :point and the presence cursor reads :x / :y,
//  so the record fields arrive as maps here.
export interface RemotePointerUpdate {
  fileId: string;
  sessionId: string;
  profileId: string | null;
  pageId: string | null;
  point: WorkspacePoint | null;
  zoom: number | null;
  zoomInverse: number | null;
  vbox: WorkspaceRect | null;
  vport: WorkspaceRect | null;
}

export type CollabNotice =
  | { kind: "file-change"; event: RemoteFileChange }
  | { kind: "file-deleted"; fileId: string }
  | { kind: "file-restored"; event: FileRestored }
  | { kind: "presence"; event: PresenceEvent }
  | { kind: "pointer-update"; event: RemotePointerUpdate }
  // A message this client does not act on: another type (the not-to-do list
  // above), another topic, or another file. Kept apart from malformed so a
  // caller can log it at trace level.
  | { kind: "ignored"; reason: "type" | "topic" | "file"; type: string }
  | { kind: "malformed"; reason: string };

export interface CollabScope {
  fileId: string;
  teamId?: string | null;
}

function stringField(map: Record<string, unknown>, key: string): string | null {
  const value = map[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(map: Record<string, unknown>, key: string): number | null {
  const value = map[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pointValue(value: unknown): WorkspacePoint | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const point = value as Record<string, unknown>;
  return typeof point.x === "number" && typeof point.y === "number"
    ? { x: point.x, y: point.y }
    : null;
}

function rectValue(value: unknown): WorkspaceRect | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rect = value as Record<string, unknown>;
  const { x, y, width, height } = rect;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return null;
  }
  return { x, y, width, height };
}

// The topic filter of notifications.cljs: the zero uuid (system), the profile,
// the team, the file and the organization. The profile and organization ids
// are not known here, so their messages fall to ignored; the types they carry
// are out of scope anyway.
function isScopeTopic(topic: string, scope: CollabScope): boolean {
  if (topic === ZERO_UUID || topic === scope.fileId) return true;
  return scope.teamId !== undefined && scope.teamId !== null && topic === scope.teamId;
}

// One decoded server message, narrowed to the notices this client handles.
// Everything the backend may send is tolerated: an unknown type, a foreign
// topic or a foreign file is ignored, and a broken payload of a known type is
// malformed, which the caller reports without closing the socket.
export function classifyMessage(raw: unknown, scope: CollabScope): CollabNotice {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "malformed", reason: "the message is not a map" };
  }
  const message = raw as Record<string, unknown>;
  const type = message.type;
  if (typeof type !== "string" || type.length === 0) {
    return { kind: "malformed", reason: "the message carries no type" };
  }

  const topic = message.topic;
  const messageTopic = typeof topic === "string" ? topic : null;
  if (messageTopic !== null && !isScopeTopic(messageTopic, scope)) {
    return { kind: "ignored", reason: "topic", type };
  }

  switch (type) {
    case "file-change": {
      const fileId = stringField(message, "file-id");
      if (fileId === null) {
        return { kind: "malformed", reason: "file-change without a file id" };
      }
      if (fileId !== scope.fileId) return { kind: "ignored", reason: "file", type };
      const revn = numberField(message, "revn");
      const vern = numberField(message, "vern");
      if (revn === null || vern === null) {
        return { kind: "malformed", reason: "file-change without revn or vern" };
      }
      const changes = message.changes;
      if (!Array.isArray(changes)) {
        return { kind: "malformed", reason: "file-change without changes" };
      }
      return {
        kind: "file-change",
        event: { fileId, revn, vern, changes: changes as UpdateFileChange[] },
      };
    }
    case "file-deleted": {
      const fileId = stringField(message, "file-id");
      if (fileId === null) {
        return { kind: "malformed", reason: "file-deleted without a file id" };
      }
      if (fileId !== scope.fileId) return { kind: "ignored", reason: "file", type };
      return { kind: "file-deleted", fileId };
    }
    case "file-restored": {
      const fileId = stringField(message, "file-id");
      if (fileId === null) {
        return { kind: "malformed", reason: "file-restored without a file id" };
      }
      if (fileId !== scope.fileId) return { kind: "ignored", reason: "file", type };
      const vern = numberField(message, "vern");
      if (vern === null) {
        return { kind: "malformed", reason: "file-restored without a vern" };
      }
      return { kind: "file-restored", event: { fileId, vern } };
    }
    case "join-file":
    case "leave-file":
    case "presence":
    case "disconnect": {
      const sessionId = stringField(message, "session-id");
      if (sessionId === null) {
        return { kind: "malformed", reason: `${type} without a session id` };
      }
      // disconnect reaches the file topic without a file-id of its own.
      const fileId = stringField(message, "file-id") ?? messageTopic ?? scope.fileId;
      return {
        kind: "presence",
        event: {
          type,
          fileId,
          sessionId,
          profileId: stringField(message, "profile-id"),
        },
      };
    }
    case "pointer-update": {
      const sessionId = stringField(message, "session-id");
      if (sessionId === null) {
        return { kind: "malformed", reason: "pointer-update without a session id" };
      }
      const fileId = stringField(message, "file-id");
      if (fileId === null) {
        return { kind: "malformed", reason: "pointer-update without a file id" };
      }
      if (fileId !== scope.fileId) return { kind: "ignored", reason: "file", type };
      return {
        kind: "pointer-update",
        event: {
          fileId,
          sessionId,
          profileId: stringField(message, "profile-id"),
          pageId: stringField(message, "page-id"),
          point: pointValue(message.position),
          zoom: numberField(message, "zoom"),
          zoomInverse: numberField(message, "zoom-inverse"),
          vbox: rectValue(message.vbox),
          vport: rectValue(message.vport),
        },
      };
    }
    default:
      return { kind: "ignored", reason: "type", type };
  }
}

// --- Remote change planning ------------------------------------------------

export interface RemoteChangePlan {
  // The shape changes of the open page, in wire order.
  changes: UpdateFileChange[];
  // The page-level changes (add-page / mod-page / del-page). The canvas holds
  // one page, so it drops them; the file slice that reacts to them is later.
  pageChanges: UpdateFilePageChange[];
  // Shape changes of other pages; a commit may carry several pages at once.
  skipped: number;
}

function isPageChange(
  change: UpdateFileChange,
): change is UpdateFilePageChange {
  return (
    change.type === "add-page" ||
    change.type === "mod-page" ||
    change.type === "del-page"
  );
}

// The page filter of dch/commit: the model of this canvas is one page, so a
// change of another page must not land here (add-obj in particular would
// insert a foreign shape). applyUpdateChanges skips ids it does not know, but
// an add-obj has no id to check.
export function planRemoteChanges(
  changes: readonly UpdateFileChange[],
  pageId: string,
): RemoteChangePlan {
  const plan: RemoteChangePlan = { changes: [], pageChanges: [], skipped: 0 };
  for (const change of changes) {
    if (isPageChange(change)) {
      plan.pageChanges.push(change);
      continue;
    }
    if (change["page-id"] === pageId) plan.changes.push(change);
    else plan.skipped += 1;
  }
  return plan;
}

// --- Client ----------------------------------------------------------------

export interface WorkspaceCollabOptions {
  fileId: string;
  teamId: string | null;
  // The Penpot version of subscribe-file; default config.version.
  version?: string | null;
  // Default config.backendOrigin / config.sessionId.
  backendOrigin?: string;
  sessionId?: string;
  // Passthrough to createWorkspaceSocket (socket factory, timers, jitter).
  socket?: Omit<WorkspaceSocketOptions, "uri">;
}

export interface WorkspaceCollabHandlers {
  onFileChange?: (event: RemoteFileChange) => void;
  onFileDeleted?: (fileId: string) => void;
  onFileRestored?: (event: FileRestored) => void;
  // F8.3 fills these; the routing exists now so the slice only adds rendering.
  onPresence?: (event: PresenceEvent) => void;
  onPointerUpdate?: (event: RemotePointerUpdate) => void;
  // Socket errors and malformed payloads. A failure never closes the socket
  // from this side: the transport owns the reconnect.
  onError?: (error: unknown) => void;
}

export interface WorkspaceCollab {
  readonly uri: string;
  // One pointer-update of the viewport source (the 50ms throttle lives in the
  // canvas, the only place that sees pointer moves).
  sendPointer(update: WorkspacePointerUpdate): boolean;
  // finalize: unsubscribe-file, then close. Idempotent.
  stop(): void;
  getState(): WorkspaceSocketState;
}

export function createWorkspaceCollab(
  options: WorkspaceCollabOptions,
  handlers: WorkspaceCollabHandlers = {},
): WorkspaceCollab {
  const scope: CollabScope = { fileId: options.fileId, teamId: options.teamId };
  const uri = workspaceSocketUri(
    options.backendOrigin ?? config.backendOrigin,
    options.sessionId ?? config.sessionId,
  );

  function subscribe(socket: WorkspaceSocket): void {
    socket.send({
      type: "subscribe-file",
      fileId: options.fileId,
      version: options.version ?? config.version,
    });
    if (options.teamId !== null) {
      socket.send({ type: "subscribe-team", teamId: options.teamId });
    }
  }

  function dispatch(message: unknown): void {
    const notice = classifyMessage(message, scope);
    switch (notice.kind) {
      case "file-change":
        handlers.onFileChange?.(notice.event);
        break;
      case "file-deleted":
        handlers.onFileDeleted?.(notice.fileId);
        break;
      case "file-restored":
        handlers.onFileRestored?.(notice.event);
        break;
      case "presence":
        handlers.onPresence?.(notice.event);
        break;
      case "pointer-update":
        handlers.onPointerUpdate?.(notice.event);
        break;
      case "ignored":
        // The not-to-do types and the foreign topics land here on purpose.
        break;
      case "malformed":
        handlers.onError?.(new Error(`workspace-collab: ${notice.reason}`));
        break;
    }
  }

  let socket: WorkspaceSocket | null = null;
  const created = createWorkspaceSocket(
    { uri, ...options.socket },
    {
      // The first open sends the subscriptions too: a send before open is
      // dropped, so opened is the only reliable place (notifications.cljs
      // re-sends on ::dws/opened for the same reason).
      onOpen: () => {
        if (socket !== null) subscribe(socket);
      },
      onMessage: dispatch,
      onError: (error) => handlers.onError?.(error),
    },
  );
  socket = created;
  // A socket factory that opens synchronously would have missed the handler
  // above; the DOM never does, but the fake in the tests may.
  if (created.getState() === "open") subscribe(created);

  return {
    uri,
    sendPointer: (update) => created.send({ type: "pointer-update", ...update }),
    stop: () => {
      // unsubscribe-file before the close, so the other sessions see the
      // leave-file the server publishes for it.
      created.send({ type: "unsubscribe-file", fileId: options.fileId });
      created.close();
    },
    getState: () => created.getState(),
  };
}
