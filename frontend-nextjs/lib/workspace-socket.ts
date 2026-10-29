// WebSocket transport for the workspace collaboration channel (F8.1).
//
// Port of app.util.websocket plus app.main.data.websocket. The channel is
// GET /ws/notifications?session-id=<uuid> on the backend origin itself: Next
// rewrites do not forward the HTTP upgrade, so the shell never goes through
// the same-origin proxy (config.backendOrigin carries the direct origin).
//
// The client carries no heartbeat of its own. The server pings every five
// seconds at the protocol level, closes with 8802 after three missed pongs
// and applies a sixty second idle timeout; the browser answers pings on its
// own, so this side only reacts to close and error. Reconnection mirrors
// goog.net.WebSocket's autoReconnect: a fresh socket after a backoff, every
// subscription re-sent by the caller on open (F8.2), and a send attempted
// while the socket is down is dropped, never queued.
//
// The socket implementation, the timers and the jitter source are injected so
// the state machine runs in vitest without a browser.

import { decodeTransit, encodeTransit, keyword, keywordMap, uuid } from "@/lib/transit";

// readyState value of an open WebSocket, spelled out because the tests use a
// fake socket and node has no DOM WebSocket constant.
const OPEN = 1;

const DEFAULT_MIN_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;
const DEFAULT_JITTER = 0.2;

export type WorkspaceSocketState = "connecting" | "open" | "reconnecting" | "closed";

// The subset of the DOM WebSocket this module drives. A fake in the tests
// implements the same shape.
export interface WorkspaceWebSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; wasClean?: boolean }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface WorkspaceSocketCloseEvent {
  // null when the close event carried no code (a fake or a torn connection).
  code: number | null;
  wasClean: boolean;
}

export interface WorkspaceSocketHandlers {
  onOpen?: () => void;
  onMessage?: (message: unknown) => void;
  onClose?: (event: WorkspaceSocketCloseEvent) => void;
  // Socket errors and messages the transit reader rejects both land here; the
  // socket closes on its own afterwards, which is what starts a reconnect.
  onError?: (error: unknown) => void;
}

export interface WorkspaceSocketOptions {
  uri: string;
  createSocket?: (uri: string) => WorkspaceWebSocket;
  // Injected timer pair so the backoff test runs on fake time.
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  // Returns 0..1; the default is Math.random.
  random?: () => number;
  minDelayMs?: number;
  maxDelayMs?: number;
  // Share of the delay the jitter may add or subtract (0.2 => +-20%).
  jitter?: number;
  decode?: (text: string) => unknown;
}

export interface WorkspaceSocket {
  send(message: WorkspaceClientMessage): boolean;
  close(): void;
  getState(): WorkspaceSocketState;
  readonly uri: string;
}

// --- Wire messages ---------------------------------------------------------
//
// The four messages this client sends, named the way process-message and
// handle-message name them (`:type` keywords, uuid values). data/workspace/
// notifications.cljs builds subscribe-file, subscribe-team and
// unsubscribe-file; handle-pointer-send builds pointer-update.

export interface WorkspacePointerUpdate {
  fileId: string;
  pageId: string;
  zoom: number;
  zoomInverse: number;
  vbox: readonly number[];
  vport: readonly number[];
  position: readonly [number, number];
}

export type WorkspaceClientMessage =
  | { type: "subscribe-file"; fileId: string; version?: string | null }
  | { type: "subscribe-team"; teamId: string }
  | { type: "unsubscribe-file"; fileId: string }
  | ({ type: "pointer-update" } & WorkspacePointerUpdate);

// Encodes one client message as the transit document the backend reads. Every
// map key and the type value are keywords, and the ids are transit uuids: the
// backend keys on (:type message) and hands :file-id to the database, so a
// plain string key or string id would be ignored or fail the lookup.
export function encodeClientMessage(message: WorkspaceClientMessage): string {
  switch (message.type) {
    case "subscribe-file":
      return encodeTransit(
        keywordMap({
          type: keyword(message.type),
          "file-id": uuid(message.fileId),
          version: message.version ?? null,
        }),
      );
    case "subscribe-team":
      return encodeTransit(
        keywordMap({
          type: keyword(message.type),
          "team-id": uuid(message.teamId),
        }),
      );
    case "unsubscribe-file":
      return encodeTransit(
        keywordMap({
          type: keyword(message.type),
          "file-id": uuid(message.fileId),
        }),
      );
    case "pointer-update":
      return encodeTransit(
        keywordMap({
          type: keyword(message.type),
          "file-id": uuid(message.fileId),
          "page-id": uuid(message.pageId),
          zoom: message.zoom,
          "zoom-inverse": message.zoomInverse,
          vbox: [...message.vbox],
          vport: [...message.vport],
          position: [...message.position],
        }),
      );
  }
}

// prepare-uri in data/websocket.cljs: public-uri joined with ws/notifications
// plus the session id, with the scheme raised to ws/wss. The base may carry a
// path prefix (a deployment behind a subpath); an empty base falls back to the
// browser origin, which is what an empty cf/public-uri means.
export function workspaceSocketUri(base: string, sessionId: string): string {
  const origin = base.trim().length > 0 ? base.trim() : browserOrigin();
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws/notifications`;
  url.search = `?session-id=${encodeURIComponent(sessionId)}`;
  url.hash = "";
  return url.toString();
}

function browserOrigin(): string {
  if (typeof location === "undefined") {
    throw new Error("workspace-socket: no public uri and no browser origin");
  }
  return location.origin;
}

function defaultCreateSocket(uri: string): WorkspaceWebSocket {
  return new WebSocket(uri) as unknown as WorkspaceWebSocket;
}

// --- Transport -------------------------------------------------------------

export function createWorkspaceSocket(
  options: WorkspaceSocketOptions,
  handlers: WorkspaceSocketHandlers = {},
): WorkspaceSocket {
  const createSocket = options.createSocket ?? defaultCreateSocket;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const random = options.random ?? Math.random;
  const decode = options.decode ?? decodeTransit;
  const minDelayMs = options.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
  const maxDelayMs = Math.max(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, minDelayMs);
  const jitter = options.jitter ?? DEFAULT_JITTER;

  let current: WorkspaceWebSocket | null = null;
  let retryHandle: unknown = null;
  let retries = 0;
  let state: WorkspaceSocketState = "connecting";
  let stopped = false;

  // 1s, 2s, 4s, ... capped at maxDelayMs, each with a +-jitter share. The
  // reference library picks its own pace; the shape here is the one this
  // project tests and documents.
  function retryDelayMs(): number {
    const base = Math.min(minDelayMs * 2 ** retries, maxDelayMs);
    const spread = base * jitter;
    return Math.max(0, Math.round(base + (random() * 2 - 1) * spread));
  }

  function connect(): void {
    retryHandle = null;
    if (stopped) return;
    state = retries === 0 ? "connecting" : "reconnecting";
    const socket = createSocket(options.uri);
    current = socket;

    socket.onopen = () => {
      if (socket !== current || stopped) return;
      // A healthy connection restarts the backoff sequence.
      retries = 0;
      state = "open";
      handlers.onOpen?.();
    };

    socket.onmessage = (event) => {
      if (socket !== current) return;
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = decode(event.data);
      } catch (error: unknown) {
        handlers.onError?.(error);
        return;
      }
      handlers.onMessage?.(message);
    };

    socket.onclose = (event) => {
      if (socket !== current) return;
      current = null;
      if (stopped) return;
      state = "reconnecting";
      handlers.onClose?.({
        code: typeof event?.code === "number" ? event.code : null,
        wasClean: event?.wasClean === true,
      });
      retryHandle = setTimer(connect, retryDelayMs());
      retries += 1;
    };

    socket.onerror = (error) => {
      if (socket !== current) return;
      handlers.onError?.(error);
    };
  }

  // ws/send! in util/websocket.cljs: a message only leaves through an open
  // socket, and a dropped send reports false instead of throwing.
  function send(message: WorkspaceClientMessage): boolean {
    if (stopped || current === null || state !== "open" || current.readyState !== OPEN) {
      return false;
    }
    try {
      current.send(encodeClientMessage(message));
      return true;
    } catch (error: unknown) {
      handlers.onError?.(error);
      return false;
    }
  }

  // ws/close! in util/websocket.cljs: detach first, so the close event cannot
  // schedule a reconnect, then close once. A second close is a no-op.
  function close(): void {
    if (stopped) return;
    stopped = true;
    state = "closed";
    if (retryHandle !== null) {
      clearTimer(retryHandle);
      retryHandle = null;
    }
    const socket = current;
    current = null;
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // A socket that already closed rejects close(); there is nothing to do.
    }
  }

  connect();

  return {
    uri: options.uri,
    send,
    close,
    getState: () => state,
  };
}
