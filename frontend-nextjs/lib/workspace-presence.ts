// The presence slice of the collaboration channel (F8.3): the remote
// sessions of the open file, their cursor color and their last pointer
// update. The port of the presence half of
// data/workspace/notifications.cljs (handle-presence, handle-pointer-update,
// handle-pointer-send) plus the cursor filter of
// ui/workspace/viewport/presence.cljs (active-cursors).
//
// Semantics of the reference:
// - join-file, presence, leave-file and disconnect all arrive on the file
//   topic; the first two add or refresh a session, the last two drop it.
// - A session gets the first free color of a nine-color palette, with
//   #dee563 as the fallback once all of them are taken. The palette is a
//   set in the CLJS, so its "first" is hash order; this port keeps the
//   declared order, so the same lobby always colors the same way.
// - pointer-update only writes the pointer fields of its session: the page
//   id, the world point, the zoom and its inverse, the viewport rects and a
//   fresh updated-at. It never assigns a color, so a pointer of a session
//   this client has not seen joining yet draws with the default color.
// - A cursor draws while its point is on the open page and its updated-at
//   is at most five seconds old; the layer re-renders once per second, so a
//   silent session disappears on time. The session itself stays in the
//   slice: the reference does not expire it either, and dropping it would
//   lose its palette color to the next join.
//
// The local session is not inserted: the server filters the messages of the
// connection's own session, so no pointer of ours ever comes back, and the
// avatar stack of the right header, the other reader of the slice in the
// CLJS, is not in the shell yet. Its entry would only take a palette color
// away from the first remote session.
//
// Outbound, the canvas pushes the world point of every pointer move into a
// throttle and the sender the shell registers (F8.4) builds the wire
// message; the throttle is leading-edge 50ms, like the rxs/throttle of the
// reference, so a fast move can rest one window behind its last position.

import type { PresenceEvent, RemotePointerUpdate } from "@/lib/workspace-collab";
import type {
  WorkspacePoint,
  WorkspacePointerUpdate,
  WorkspaceRect,
} from "@/lib/workspace-socket";
import type { ViewportState } from "@/lib/workspace-viewport";

// The nine colors of presence-palette (notifications.cljs), in the declared
// order: pink, blue, gold, indigo, red, purple, orange, yellow, lemon.
export const PRESENCE_PALETTE: readonly string[] = [
  "#f49ef7",
  "#75cafc",
  "#fdcf79",
  "#a9bdfa",
  "#faa6b7",
  "#cbaaff",
  "#f9b489",
  "#dee563",
  "#b1e96f",
];

// The color of the last resort, once every palette entry is taken, and the
// color of a cursor whose session never carried a join.
export const DEFAULT_PRESENCE_COLOR = "#dee563";

// active-cursors: a cursor older than five seconds no longer draws.
export const PRESENCE_TTL_MS = 5000;

// The expiry clock of the cursor layer: one re-render per second.
export const PRESENCE_TICK_MS = 1000;

// The pointer broadcast window of notifications.cljs (rxs/throttle 50).
export const POINTER_THROTTLE_MS = 50;

// One remote session. The pointer fields stay null until the first
// pointer-update of the session.
export interface PresenceSession {
  // The session id, also the key of the slice.
  id: string;
  profileId: string | null;
  // null for a session only seen through pointer updates; the cursors fall
  // back to DEFAULT_PRESENCE_COLOR.
  color: string | null;
  // The clock of the last presence or pointer message, in epoch ms. The
  // cursor expiry reads it; the session itself does not expire.
  updatedAt: number;
  pageId: string | null;
  point: WorkspacePoint | null;
  zoom: number | null;
  zoomInverse: number | null;
  vbox: WorkspaceRect | null;
  vport: WorkspaceRect | null;
}

export type PresenceState = Readonly<Record<string, PresenceSession>>;

// The cursor layer draws these; the point and the page id are non-null, so
// the component needs no second test.
export interface PresenceCursor extends PresenceSession {
  pageId: string;
  point: WorkspacePoint;
}

function emptySession(id: string): PresenceSession {
  return {
    id,
    profileId: null,
    color: null,
    updatedAt: 0,
    pageId: null,
    point: null,
    zoom: null,
    zoomInverse: null,
    vbox: null,
    vport: null,
  };
}

// get-next-color: the first palette entry no session holds, the default
// color once they all do.
export function nextPresenceColor(state: PresenceState): string {
  const used = new Set<string>();
  for (const session of Object.values(state)) {
    if (session.color !== null) used.add(session.color);
  }
  for (const color of PRESENCE_PALETTE) {
    if (!used.has(color)) return color;
  }
  return DEFAULT_PRESENCE_COLOR;
}

// handle-presence: a join (or a presence echo) adds the session or refreshes
// its clock; a leave or a disconnect drops it. The profile id and the color
// of a known session survive a message that carries neither.
export function applyPresence(
  state: PresenceState,
  event: PresenceEvent,
  now: number,
): PresenceState {
  if (event.type === "leave-file" || event.type === "disconnect") {
    if (state[event.sessionId] === undefined) return state;
    const next: Record<string, PresenceSession> = { ...state };
    delete next[event.sessionId];
    return next;
  }
  const current = state[event.sessionId];
  const session: PresenceSession = {
    ...(current ?? emptySession(event.sessionId)),
    profileId: event.profileId ?? current?.profileId ?? null,
    color: current?.color ?? nextPresenceColor(state),
    updatedAt: now,
  };
  return { ...state, [event.sessionId]: session };
}

// handle-pointer-update: only the pointer fields move, and the clock with
// them. A session this client has not seen joins yet is created without a
// color; its profile id comes from the message.
export function applyPointerUpdate(
  state: PresenceState,
  update: RemotePointerUpdate,
  now: number,
): PresenceState {
  const current = state[update.sessionId];
  const session: PresenceSession = {
    ...(current ?? emptySession(update.sessionId)),
    profileId: current?.profileId ?? update.profileId ?? null,
    updatedAt: now,
    pageId: update.pageId,
    point: update.point,
    zoom: update.zoom,
    zoomInverse: update.zoomInverse,
    vbox: update.vbox,
    vport: update.vport,
  };
  return { ...state, [update.sessionId]: session };
}

// active-cursors: the sessions with a point on the open page whose clock is
// younger than the TTL, in a stable order (the CLJS walks the hash map).
export function visibleCursors(
  state: PresenceState,
  pageId: string,
  now: number,
  ttl: number = PRESENCE_TTL_MS,
): PresenceCursor[] {
  const cursors: PresenceCursor[] = [];
  for (const session of Object.values(state)) {
    if (session.point === null || session.pageId !== pageId) continue;
    if (now - session.updatedAt > ttl) continue;
    cursors.push({ ...session, pageId, point: session.point });
  }
  cursors.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return cursors;
}

// Whether some cursor is still fresh. The layer runs its expiry clock only
// while this holds: at the tick that crosses the TTL every cursor is stale,
// so the layer stops the timer instead of spinning without work.
export function hasFreshCursors(
  state: PresenceState,
  now: number,
  ttl: number = PRESENCE_TTL_MS,
): boolean {
  for (const session of Object.values(state)) {
    if (session.point === null) continue;
    if (now - session.updatedAt <= ttl) return true;
  }
  return false;
}

// --- Outbound pointer -------------------------------------------------------

// The viewport slice handle-pointer-send reads from workspace-local, plus
// the ids of the open file.
export interface PresencePointerContext {
  fileId: string | null;
  pageId: string | null;
  viewport: ViewportState | null;
}

// handle-pointer-send: the wire message of a pointer move, or null while
// the canvas has no viewport or page yet.
export function pointerUpdate(
  context: PresencePointerContext,
  point: WorkspacePoint,
): WorkspacePointerUpdate | null {
  const { fileId, pageId, viewport } = context;
  if (fileId === null || pageId === null || viewport === null) return null;
  return {
    fileId,
    pageId,
    zoom: viewport.zoom,
    zoomInverse: 1 / viewport.zoom,
    vbox: viewport.vbox,
    // The CLJS vport is a size; the wire rect carries the origin at zero.
    vport: { x: 0, y: 0, width: viewport.vport.width, height: viewport.vport.height },
    position: point,
  };
}

// The shell registers this (F8.4): it owns the collaboration client and the
// viewport slice, so it is the only place that can turn a point into a
// message. Without a sender every push is a no-op, which keeps the canvas
// free of the channel.
export type PresencePointerSender = (point: WorkspacePoint) => boolean;

let pointerSender: PresencePointerSender | null = null;

export function registerPresencePointerSender(next: PresencePointerSender | null): void {
  pointerSender = next;
}

export function sendPresencePointer(point: WorkspacePoint): boolean {
  return pointerSender === null ? false : pointerSender(point);
}

export interface PointerThrottle {
  // Sends the point unless the previous send is younger than the interval;
  // answers whether it went out.
  push(point: WorkspacePoint): boolean;
  // Drops the window, so the next push always sends.
  reset(): void;
}

// A leading-edge throttle: the first point of a window goes out, the rest
// are dropped. The reference pipe is rxs/throttle, which behaves the same.
export function createPointerThrottle(options: {
  interval?: number;
  now?: () => number;
  send: (point: WorkspacePoint) => void;
}): PointerThrottle {
  const interval = options.interval ?? POINTER_THROTTLE_MS;
  const now = options.now ?? (() => Date.now());
  let last: number | null = null;
  return {
    push(point) {
      const stamp = now();
      if (last !== null && stamp - last < interval) return false;
      last = stamp;
      options.send(point);
      return true;
    },
    reset() {
      last = null;
    },
  };
}
