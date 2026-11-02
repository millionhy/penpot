// The dashboard team notification client (F5.7). The websocket subscription
// that dashboard-context.tsx has always promised but never mounted: the CLJS
// dd/initialize sends subscribe-team and its process-message refreshes the
// team slice when a remote change lands. The workspace client (F8.2,
// lib/workspace-collab.ts) routes the FILE topics and deliberately leaves out
// the dashboard subscriptions (rewrite.md 7.46); this module is the dashboard
// counterpart over the same transport.
//
// It reuses createWorkspaceSocket + workspaceSocketUri + encodeClientMessage
// verbatim (lib/workspace-socket.ts): one connection to GET
// /ws/notifications?session-id=<uuid> on config.backendOrigin, subscribe-team
// (with team-id) on open and on every reconnect, unsubscribe on stop. The
// backend complements the team topic with the organization topic on
// subscribe-team (backend http/websocket.clj), so both reach this client.
//
// The inbound routing is the dashboard slice of
// app.main.data.workspace.notifications/process-message (the file/presence
// types are not sent to a team-only subscriber but are classified anyway):
// - :file-change / :file-deleted / :file-restored / :library-change  -> the
//   project and recent-file listings shifted (a remote edit reorders
//   modified-at, a library change re-titles the shared row): refetch.
// - :team-membership-change -> a member joined or the profile was removed:
//   refetch the team list and the members (a removal drops the team from
//   get-teams, which lets the URL resolver navigate away by itself).
// - :team-role-change       -> own role changed: refetch (permissions ride the
//   team row).
// - :team-organization-change -> the team's organization projection changed:
//   refetch the teams.
// - :notification           -> a system message (the handle-notification codes:
//   :upgrade-version, :maintenance, or a plain message); the caller surfaces a
//   toast. This client does not refresh on it.
// - everything else (presence, pointer-update, a foreign topic, an unknown
//   type) is ignored; a known type with a broken payload is malformed.

import { config } from "@/lib/config";
import { ZERO_UUID } from "@/lib/file-data";
import {
  createWorkspaceSocket,
  workspaceSocketUri,
  type WorkspaceSocket,
  type WorkspaceSocketOptions,
  type WorkspaceSocketState,
} from "@/lib/workspace-socket";

// --- Notices ---------------------------------------------------------------

// The dashboard reacts to a file/library change with one action: re-pull the
// listings. It carries no ids because the team subscriber is not scoped to a
// single file — any file event in the team invalidates the view.
export type DashboardNotice =
  | { kind: "refetch-files" }
  | { kind: "membership-change"; teamId: string; teamName: string; change: "added" | "removed" }
  | { kind: "role-change"; teamId: string; role: string }
  | { kind: "organization-change"; teamId: string }
  | { kind: "system"; code: string | null; message: string | null }
  // A message this client does not act on: a file/presence type that never
  // reaches a team subscriber, a foreign topic, or an unknown type. Kept apart
  // from malformed so a caller can trace it.
  | { kind: "ignored"; reason: "type" | "topic"; type: string }
  | { kind: "malformed"; reason: string };

// The topics whose messages the client keeps: the zero uuid (system), the
// profile, the team, and the organization. The backend stamps every delivery
// with the msgbus :topic, so a message from another team or profile is
// dropped here exactly like the workspace filter drops out-of-scope files.
export interface DashboardScope {
  profileId?: string | null;
  teamId: string;
  organizationId?: string | null;
}

function stringField(map: Record<string, unknown>, key: string): string | null {
  const value = map[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableStringField(map: Record<string, unknown>, key: string): string | null {
  const value = map[key];
  return typeof value === "string" ? value : null;
}

function inScopeTopic(topic: string, scope: DashboardScope): boolean {
  if (topic === ZERO_UUID || topic === scope.teamId) return true;
  if (scope.profileId != null && topic === scope.profileId) return true;
  if (scope.organizationId != null && topic === scope.organizationId) return true;
  return false;
}

// One decoded server message, narrowed to the notice the dashboard handles.
// Everything the backend may send is tolerated: an unknown type, a foreign
// topic is ignored, and a broken payload of a known type is malformed.
export function classifyDashboardNotice(raw: unknown, scope: DashboardScope): DashboardNotice {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "malformed", reason: "the message is not a map" };
  }
  const message = raw as Record<string, unknown>;

  const type = message.type;
  if (typeof type !== "string" || type.length === 0) {
    return { kind: "malformed", reason: "the message carries no type" };
  }

  const topic = message.topic;
  if (typeof topic === "string" && !inScopeTopic(topic, scope)) {
    return { kind: "ignored", reason: "topic", type };
  }

  switch (type) {
    case "file-change":
    case "file-deleted":
    case "file-restored":
    case "library-change":
      return { kind: "refetch-files" };
    case "team-membership-change": {
      const teamId = stringField(message, "team-id");
      if (teamId === null) {
        return { kind: "malformed", reason: "team-membership-change without a team id" };
      }
      const change = stringField(message, "change");
      if (change !== "added" && change !== "removed") {
        return { kind: "malformed", reason: "team-membership-change with an unknown change" };
      }
      return {
        kind: "membership-change",
        teamId,
        teamName: nullableStringField(message, "team-name") ?? "",
        change,
      };
    }
    case "team-role-change": {
      const teamId = stringField(message, "team-id");
      const role = stringField(message, "role");
      if (teamId === null || role === null) {
        return { kind: "malformed", reason: "team-role-change without team-id or role" };
      }
      return { kind: "role-change", teamId, role };
    }
    case "team-organization-change": {
      const teamId = stringField(message, "team-id");
      if (teamId === null) {
        return { kind: "malformed", reason: "team-organization-change without a team id" };
      }
      return { kind: "organization-change", teamId };
    }
    case "notification":
      return {
        kind: "system",
        code: nullableStringField(message, "code"),
        message: nullableStringField(message, "message"),
      };
    default:
      return { kind: "ignored", reason: "type", type };
  }
}

// --- Subscriber ------------------------------------------------------------

export interface DashboardNotificationsOptions {
  scope: DashboardScope;
  backendOrigin?: string;
  sessionId?: string;
  // Forwarded to createWorkspaceSocket so the tests inject a fake socket, the
  // timers and the jitter source (the same seam as F8.1).
  socket?: Partial<Omit<WorkspaceSocketOptions, "uri">>;
}

export interface DashboardNotificationsHandlers {
  // Invoked for every notice except "ignored" (silent on purpose) and
  // "malformed" (those go to onError).
  onNotice: (notice: DashboardNotice) => void;
  onError?: (error: unknown) => void;
}

export interface DashboardNotifications {
  readonly uri: string;
  stop(): void;
  getState(): WorkspaceSocketState;
}

export function createDashboardNotifications(
  options: DashboardNotificationsOptions,
  handlers: DashboardNotificationsHandlers = { onNotice: () => undefined },
): DashboardNotifications {
  const uri = workspaceSocketUri(
    options.backendOrigin ?? config.backendOrigin,
    options.sessionId ?? config.sessionId,
  );
  const scope = options.scope;

  let socket: WorkspaceSocket | null = null;

  function subscribe(client: WorkspaceSocket): void {
    client.send({ type: "subscribe-team", teamId: scope.teamId });
  }

  function dispatch(message: unknown): void {
    const notice = classifyDashboardNotice(message, scope);
    switch (notice.kind) {
      case "ignored":
        // The file/presence types and foreign topics land here on purpose.
        break;
      case "malformed":
        handlers.onError?.(new Error(`dashboard-notifications: ${notice.reason}`));
        break;
      default:
        handlers.onNotice(notice);
    }
  }

  const created = createWorkspaceSocket(
    { uri, ...options.socket },
    {
      // A send before open is dropped, so subscribe-team rides the open
      // handler and re-sends on every reconnect (process-message re-sends the
      // init messages on ::dws/opened for the same reason).
      onOpen: () => {
        if (socket !== null) subscribe(socket);
      },
      onMessage: dispatch,
      onError: (error) => handlers.onError?.(error),
    },
  );
  socket = created;
  // A fake socket factory may open synchronously before the handler is set;
  // the DOM never does, but the tests do.
  if (created.getState() === "open") subscribe(created);

  return {
    uri,
    stop: () => created.close(),
    getState: () => created.getState(),
  };
}
