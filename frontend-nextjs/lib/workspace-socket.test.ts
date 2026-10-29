// Unit tests for the collaboration transport (F8.1). The socket and the
// timers are fakes, so every reconnect sequence runs on controlled time.
//
// The reference behavior under test: the URI is the backend origin plus
// ws/notifications and the session id; a send only leaves through an open
// socket; the payload is a transit map with keyword keys and uuid ids; a
// reconnect waits 1s, 2s, 4s, ... with jitter and a ceiling; a manual close
// clears the pending retry and stops the loop.

import { describe, expect, it } from "vitest";

import { decodeTransit } from "@/lib/transit";
import {
  createWorkspaceSocket,
  encodeClientMessage,
  workspaceSocketUri,
  type WorkspaceClientMessage,
  type WorkspaceSocket,
  type WorkspaceSocketOptions,
  type WorkspaceWebSocket,
} from "@/lib/workspace-socket";

const SESSION_ID = "00000000-0000-0000-0000-000000000001";
const FILE_ID = "11111111-2222-3333-4444-555555555555";
const TEAM_ID = "66666666-7777-8888-9999-000000000000";
const PAGE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const URI = workspaceSocketUri("http://localhost:6060", SESSION_ID);

class FakeSocket implements WorkspaceWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; wasClean?: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, wasClean: false });
  }
}

interface Harness {
  socket: WorkspaceSocket;
  sockets: FakeSocket[];
  timers: { callback: () => void; delayMs: number }[];
  cleared: unknown[];
  events: string[];
  messages: unknown[];
  errors: unknown[];
}

function createHarness(overrides: Partial<WorkspaceSocketOptions> = {}): Harness {
  const sockets: FakeSocket[] = [];
  const timers: { callback: () => void; delayMs: number }[] = [];
  const cleared: unknown[] = [];
  const events: string[] = [];
  const messages: unknown[] = [];
  const errors: unknown[] = [];
  let nextHandle = 0;

  const socket = createWorkspaceSocket(
    {
      uri: URI,
      createSocket: () => {
        const fake = new FakeSocket();
        sockets.push(fake);
        return fake;
      },
      setTimer: (callback, delayMs) => {
        timers.push({ callback, delayMs });
        nextHandle += 1;
        return nextHandle;
      },
      clearTimer: (handle) => {
        cleared.push(handle);
      },
      random: () => 0.5,
      ...overrides,
    },
    {
      onOpen: () => events.push("open"),
      onMessage: (message) => messages.push(message),
      onClose: (event) => events.push(`close:${event.code}`),
      onError: (error) => errors.push(error),
    },
  );

  return { socket, sockets, timers, cleared, events, messages, errors };
}

describe("workspaceSocketUri", () => {
  it("raises http to ws and appends the channel and the session id", () => {
    expect(workspaceSocketUri("http://localhost:6060", SESSION_ID)).toBe(
      `ws://localhost:6060/ws/notifications?session-id=${SESSION_ID}`,
    );
  });

  it("raises https to wss and keeps a deployment path prefix", () => {
    expect(workspaceSocketUri("https://penpot.example/design/", SESSION_ID)).toBe(
      `wss://penpot.example/design/ws/notifications?session-id=${SESSION_ID}`,
    );
  });

  it("keeps a websocket scheme as it is", () => {
    expect(workspaceSocketUri("ws://localhost:6060", SESSION_ID)).toBe(
      `ws://localhost:6060/ws/notifications?session-id=${SESSION_ID}`,
    );
  });
});

describe("encodeClientMessage", () => {
  it("writes subscribe-file as a keyword map with a uuid file id", () => {
    const raw = encodeClientMessage({
      type: "subscribe-file",
      fileId: FILE_ID,
      version: "2.17.0",
    });
    expect(raw).toContain('"~:type"');
    expect(raw).toContain(`"~u${FILE_ID}"`);
    expect(decodeTransit(raw)).toEqual({
      type: "subscribe-file",
      "file-id": FILE_ID,
      version: "2.17.0",
    });
  });

  it("writes subscribe-team with the team id", () => {
    const raw = encodeClientMessage({ type: "subscribe-team", teamId: TEAM_ID });
    expect(decodeTransit(raw)).toEqual({ type: "subscribe-team", "team-id": TEAM_ID });
  });

  it("writes unsubscribe-file without a version", () => {
    const raw = encodeClientMessage({ type: "unsubscribe-file", fileId: FILE_ID });
    expect(decodeTransit(raw)).toEqual({ type: "unsubscribe-file", "file-id": FILE_ID });
  });

  it("writes every pointer-update field the presence handler reads", () => {
    const raw = encodeClientMessage({
      type: "pointer-update",
      fileId: FILE_ID,
      pageId: PAGE_ID,
      zoom: 2,
      zoomInverse: 0.5,
      vbox: [0, 0, 100, 100],
      vport: [10, 20, 80, 60],
      position: [12.5, 34.5],
    });
    expect(decodeTransit(raw)).toEqual({
      type: "pointer-update",
      "file-id": FILE_ID,
      "page-id": PAGE_ID,
      zoom: 2,
      "zoom-inverse": 0.5,
      vbox: [0, 0, 100, 100],
      vport: [10, 20, 80, 60],
      position: [12.5, 34.5],
    });
  });
});

describe("createWorkspaceSocket", () => {
  it("connects as soon as it is created", () => {
    const { sockets, socket } = createHarness();
    expect(sockets).toHaveLength(1);
    expect(socket.getState()).toBe("connecting");
  });

  it("drops a send before the socket opens", () => {
    const { sockets, socket } = createHarness();
    expect(socket.send({ type: "subscribe-file", fileId: FILE_ID })).toBe(false);
    expect(sockets[0].sent).toEqual([]);
  });

  it("drops a send while reconnecting", () => {
    const { sockets, timers, socket } = createHarness();
    sockets[0].open();
    sockets[0].drop();
    timers[0].callback();
    expect(socket.send({ type: "unsubscribe-file", fileId: FILE_ID })).toBe(false);
    expect(sockets[1].sent).toEqual([]);
  });

  it("sends an encoded message through an open socket", () => {
    const { sockets, socket } = createHarness();
    sockets[0].open();
    const message: WorkspaceClientMessage = {
      type: "subscribe-file",
      fileId: FILE_ID,
      version: "2.17.0",
    };
    expect(socket.send(message)).toBe(true);
    expect(sockets[0].sent).toEqual([encodeClientMessage(message)]);
  });

  it("hands a message decoded by the transit reader to the handler", () => {
    const { sockets, messages } = createHarness();
    sockets[0].open();
    sockets[0].deliver(`{"~:type":"~:presence","~:file-id":"~u${FILE_ID}"}`);
    expect(messages).toEqual([{ type: "presence", "file-id": FILE_ID }]);
  });

  it("reports a message the reader rejects and keeps the socket open", () => {
    const { sockets, errors, messages, socket } = createHarness();
    sockets[0].open();
    sockets[0].deliver("not a transit document");
    expect(errors).toHaveLength(1);
    expect(messages).toEqual([]);
    expect(socket.getState()).toBe("open");
  });

  it("ignores a binary frame", () => {
    const { sockets, errors, messages } = createHarness();
    sockets[0].open();
    sockets[0].deliver(new Uint8Array([1, 2, 3]));
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("reconnects after 1s, 2s, then the ceiling, and reports each close", () => {
    const { sockets, timers, events, socket } = createHarness({ maxDelayMs: 3000 });

    sockets[0].drop();
    expect(timers.map((timer) => timer.delayMs)).toEqual([1000]);
    expect(socket.getState()).toBe("reconnecting");

    timers[0].callback();
    sockets[1].drop();
    timers[1].callback();
    sockets[2].drop();
    timers[2].callback();
    sockets[3].drop();

    expect(timers.map((timer) => timer.delayMs)).toEqual([1000, 2000, 3000, 3000]);
    expect(sockets).toHaveLength(4);
    expect(events).toEqual(["close:1006", "close:1006", "close:1006", "close:1006"]);
  });

  it("restarts the backoff after a connection opens", () => {
    const { sockets, timers, socket } = createHarness();

    sockets[0].drop();
    timers[0].callback();
    sockets[1].open();
    expect(socket.getState()).toBe("open");

    sockets[1].drop();
    expect(timers[1].delayMs).toBe(1000);
  });

  it("adds the jitter share to the delay", () => {
    const low = createHarness({ random: () => 0 });
    low.sockets[0].drop();
    expect(low.timers[0].delayMs).toBe(800);

    const high = createHarness({ random: () => 1 });
    high.sockets[0].drop();
    expect(high.timers[0].delayMs).toBe(1200);
  });

  it("ignores the events of a socket a reconnect replaced", () => {
    const { sockets, timers, events, socket } = createHarness();

    sockets[0].open();
    sockets[0].drop();
    timers[0].callback();
    sockets[0].open();

    expect(events).toEqual(["open", "close:1006"]);
    expect(socket.getState()).toBe("reconnecting");
  });

  it("closes the live socket once and stops the reconnect loop", () => {
    const { sockets, timers, cleared, socket } = createHarness();

    sockets[0].open();
    socket.close();
    expect(sockets[0].closed).toBe(true);
    expect(socket.getState()).toBe("closed");

    socket.close();
    expect(cleared).toEqual([]);
    expect(timers).toEqual([]);
  });

  it("clears a pending retry when it closes while a reconnect waits", () => {
    const { sockets, timers, cleared, socket } = createHarness();

    sockets[0].drop();
    socket.close();

    expect(cleared).toEqual([1]);
    expect(timers).toHaveLength(1);
    expect(socket.getState()).toBe("closed");
  });
});
