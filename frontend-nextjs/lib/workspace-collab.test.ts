// Unit tests for the collaboration client (F8.2): message classification, the
// page filter of a remote change, and the subscription lifecycle. The socket
// and the timers are fakes, so a reconnect runs on controlled time.
//
// The reference behavior under test: the subscriptions go out on every open
// (a send before open is dropped), stop unsubscribes before closing, a remote
// change of the open page is planned and one of another page is skipped, and
// a malformed payload reports an error without closing the socket.

import { describe, expect, it } from "vitest";

import { encodeParams } from "@/lib/transit";
import type { UpdateFileChange } from "@/lib/transit";
import {
  classifyMessage,
  createWorkspaceCollab,
  planRemoteChanges,
  type CollabScope,
} from "@/lib/workspace-collab";
import type {
  WorkspaceSocketOptions,
  WorkspaceWebSocket,
} from "@/lib/workspace-socket";

const SESSION_ID = "00000000-0000-0000-0000-000000000001";
const FILE_ID = "11111111-2222-3333-4444-555555555555";
const TEAM_ID = "66666666-7777-8888-9999-000000000000";
const PAGE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_PAGE = "aaaaaaaa-bbbb-cccc-dddd-ffffffffffff";
const OTHER_FILE = "22222222-3333-4444-5555-666666666666";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const SHAPE_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

const SCOPE: CollabScope = { fileId: FILE_ID, teamId: TEAM_ID };

function encode(message: Record<string, unknown>): string {
  return encodeParams(message);
}

class FakeSocket implements WorkspaceWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  closes = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; wasClean?: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closes += 1;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(data: string): void {
    this.onmessage?.({ data });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, wasClean: false });
  }
}

interface CollabHarness {
  collab: ReturnType<typeof createWorkspaceCollab>;
  sockets: FakeSocket[];
  timers: { callback: () => void; delayMs: number }[];
  events: string[];
  errors: unknown[];
  pointers: unknown[];
  presences: unknown[];
}

function createHarness(
  overrides: Partial<WorkspaceSocketOptions> = {},
  withTeam = true,
): CollabHarness {
  const sockets: FakeSocket[] = [];
  const timers: { callback: () => void; delayMs: number }[] = [];
  const events: string[] = [];
  const errors: unknown[] = [];
  const pointers: unknown[] = [];
  const presences: unknown[] = [];
  let nextHandle = 0;

  const collab = createWorkspaceCollab(
    {
      fileId: FILE_ID,
      teamId: withTeam ? TEAM_ID : null,
      version: "2.17.0",
      backendOrigin: "http://localhost:6060",
      sessionId: SESSION_ID,
      socket: {
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
        clearTimer: () => undefined,
        random: () => 0.5,
        ...overrides,
      },
    },
    {
      onFileChange: (event) =>
        events.push(`change:${event.revn}:${event.vern}:${event.changes.length}`),
      onFileDeleted: (fileId) => events.push(`deleted:${fileId}`),
      onFileRestored: (event) => events.push(`restored:${event.vern}`),
      onPresence: (event) => presences.push(event),
      onPointerUpdate: (event) => pointers.push(event),
      onError: (error) => errors.push(error),
    },
  );

  return { collab, sockets, timers, events, errors, pointers, presences };
}

// --- classifyMessage -------------------------------------------------------

describe("classifyMessage", () => {
  it("classifies a file-change of the open file", () => {
    const changes: UpdateFileChange[] = [
      { type: "del-obj", "page-id": PAGE_ID, id: SHAPE_ID },
    ];
    const notice = classifyMessage(
      {
        type: "file-change",
        topic: FILE_ID,
        "file-id": FILE_ID,
        "profile-id": SESSION_ID,
        "session-id": SESSION_ID,
        revn: 12,
        vern: 3,
        changes,
      },
      SCOPE,
    );
    expect(notice).toEqual({
      kind: "file-change",
      event: { fileId: FILE_ID, revn: 12, vern: 3, changes },
    });
  });

  it("ignores a file-change of another file", () => {
    const notice = classifyMessage(
      { type: "file-change", topic: FILE_ID, "file-id": OTHER_FILE, revn: 1, vern: 1, changes: [] },
      SCOPE,
    );
    expect(notice).toEqual({ kind: "ignored", reason: "file", type: "file-change" });
  });

  it("ignores a message of a topic outside the subscriptions", () => {
    const notice = classifyMessage(
      {
        type: "file-change",
        topic: "cccccccc-dddd-eeee-ffff-000000000000",
        "file-id": FILE_ID,
        revn: 1,
        vern: 1,
        changes: [],
      },
      SCOPE,
    );
    expect(notice).toEqual({ kind: "ignored", reason: "topic", type: "file-change" });
  });

  it("accepts the zero uuid and the team topic", () => {
    const zero = classifyMessage(
      { type: "file-deleted", topic: ZERO_UUID, "file-id": FILE_ID },
      SCOPE,
    );
    expect(zero).toEqual({ kind: "file-deleted", fileId: FILE_ID });
    const team = classifyMessage({ type: "library-change", topic: TEAM_ID }, SCOPE);
    expect(team).toEqual({ kind: "ignored", reason: "type", type: "library-change" });
  });

  it("reports a file-change without revn or vern as malformed", () => {
    const notice = classifyMessage(
      { type: "file-change", topic: FILE_ID, "file-id": FILE_ID, changes: [] },
      SCOPE,
    );
    expect(notice).toEqual({ kind: "malformed", reason: "file-change without revn or vern" });
  });

  it("reports a file-change without changes as malformed", () => {
    const notice = classifyMessage(
      { type: "file-change", topic: FILE_ID, "file-id": FILE_ID, revn: 2, vern: 1 },
      SCOPE,
    );
    expect(notice).toEqual({ kind: "malformed", reason: "file-change without changes" });
  });

  it("classifies file-deleted and file-restored", () => {
    expect(
      classifyMessage({ type: "file-deleted", topic: FILE_ID, "file-id": FILE_ID }, SCOPE),
    ).toEqual({ kind: "file-deleted", fileId: FILE_ID });
    expect(
      classifyMessage({ type: "file-restored", topic: FILE_ID, "file-id": FILE_ID, vern: 7 }, SCOPE),
    ).toEqual({ kind: "file-restored", event: { fileId: FILE_ID, vern: 7 } });
    expect(
      classifyMessage({ type: "file-restored", topic: FILE_ID, "file-id": FILE_ID }, SCOPE),
    ).toEqual({ kind: "malformed", reason: "file-restored without a vern" });
  });

  it("turns the presence family into one event", () => {
    const joined = classifyMessage(
      {
        type: "join-file",
        topic: FILE_ID,
        "file-id": FILE_ID,
        "session-id": SESSION_ID,
        "profile-id": "dddddddd-eeee-ffff-0000-111111111111",
      },
      SCOPE,
    );
    expect(joined).toEqual({
      kind: "presence",
      event: {
        type: "join-file",
        fileId: FILE_ID,
        sessionId: SESSION_ID,
        profileId: "dddddddd-eeee-ffff-0000-111111111111",
      },
    });

    // A closing socket announces :disconnect on the file topic and carries no
    // file-id of its own; the topic supplies it.
    const disconnected = classifyMessage(
      { type: "disconnect", topic: FILE_ID, "session-id": SESSION_ID },
      SCOPE,
    );
    expect(disconnected).toEqual({
      kind: "presence",
      event: { type: "disconnect", fileId: FILE_ID, sessionId: SESSION_ID, profileId: null },
    });

    expect(classifyMessage({ type: "presence", topic: FILE_ID }, SCOPE)).toEqual({
      kind: "malformed",
      reason: "presence without a session id",
    });
  });

  it("reads the pointer record fields as maps", () => {
    const notice = classifyMessage(
      {
        type: "pointer-update",
        topic: FILE_ID,
        "file-id": FILE_ID,
        "session-id": SESSION_ID,
        "profile-id": "dddddddd-eeee-ffff-0000-111111111111",
        "page-id": PAGE_ID,
        zoom: 1.5,
        "zoom-inverse": 0.6666666666666666,
        vbox: { x: 0, y: 0, width: 100, height: 80 },
        vport: { x: 10, y: 20, width: 60, height: 40 },
        position: { x: 12.5, y: 34.5 },
      },
      SCOPE,
    );
    expect(notice).toEqual({
      kind: "pointer-update",
      event: {
        fileId: FILE_ID,
        sessionId: SESSION_ID,
        profileId: "dddddddd-eeee-ffff-0000-111111111111",
        pageId: PAGE_ID,
        point: { x: 12.5, y: 34.5 },
        zoom: 1.5,
        zoomInverse: 0.6666666666666666,
        vbox: { x: 0, y: 0, width: 100, height: 80 },
        vport: { x: 10, y: 20, width: 60, height: 40 },
      },
    });
  });

  it("ignores a pointer-update of another file", () => {
    const notice = classifyMessage(
      {
        type: "pointer-update",
        topic: FILE_ID,
        "file-id": OTHER_FILE,
        "session-id": SESSION_ID,
      },
      SCOPE,
    );
    expect(notice).toEqual({ kind: "ignored", reason: "file", type: "pointer-update" });
  });

  it("ignores the types outside this slice and rejects a broken payload", () => {
    expect(classifyMessage({ type: "library-change", topic: FILE_ID }, SCOPE)).toEqual({
      kind: "ignored",
      reason: "type",
      type: "library-change",
    });
    expect(classifyMessage(null, SCOPE)).toEqual({
      kind: "malformed",
      reason: "the message is not a map",
    });
    expect(classifyMessage([], SCOPE)).toEqual({
      kind: "malformed",
      reason: "the message is not a map",
    });
    expect(classifyMessage({ topic: FILE_ID }, SCOPE)).toEqual({
      kind: "malformed",
      reason: "the message carries no type",
    });
  });
});

// --- planRemoteChanges -----------------------------------------------------

describe("planRemoteChanges", () => {
  const changes: UpdateFileChange[] = [
    { type: "mod-obj", "page-id": PAGE_ID, id: SHAPE_ID, operations: [] },
    { type: "del-obj", "page-id": OTHER_PAGE, id: "eeeeeeee-ffff-0000-1111-222222222222" },
    { type: "add-obj", "page-id": PAGE_ID, id: SHAPE_ID, obj: {}, "frame-id": SHAPE_ID, "parent-id": SHAPE_ID },
    { type: "add-page", id: "ffffffff-0000-1111-2222-333333333333", name: "Page 2" },
    { type: "mov-objects", "page-id": PAGE_ID, "parent-id": SHAPE_ID, shapes: [SHAPE_ID] },
  ];

  it("keeps the shape changes of the open page in wire order", () => {
    const plan = planRemoteChanges(changes, PAGE_ID);
    expect(plan.changes.map((change) => change.type)).toEqual([
      "mod-obj",
      "add-obj",
      "mov-objects",
    ]);
  });

  it("counts the shape changes of other pages and sets the page changes apart", () => {
    const plan = planRemoteChanges(changes, PAGE_ID);
    expect(plan.skipped).toBe(1);
    expect(plan.pageChanges).toEqual([
      { type: "add-page", id: "ffffffff-0000-1111-2222-333333333333", name: "Page 2" },
    ]);
  });

  it("plans nothing for an empty batch", () => {
    expect(planRemoteChanges([], PAGE_ID)).toEqual({
      changes: [],
      pageChanges: [],
      skipped: 0,
    });
  });
});

// --- createWorkspaceCollab -------------------------------------------------

describe("createWorkspaceCollab", () => {
  it("builds the socket uri from the backend origin and the session id", () => {
    const { collab } = createHarness();
    expect(collab.uri).toBe(
      `ws://localhost:6060/ws/notifications?session-id=${SESSION_ID}`,
    );
  });

  it("subscribes only once the socket opens", () => {
    const harness = createHarness();
    expect(harness.sockets[0].sent).toEqual([]);
    harness.sockets[0].open();
    expect(harness.sockets[0].sent).toHaveLength(2);
  });

  it("sends subscribe-file with the version and subscribe-team", () => {
    const harness = createHarness();
    harness.sockets[0].open();
    const sent = harness.sockets[0].sent;
    // The encoder is the F8.1 one; what matters here is the order and the
    // two message types.
    expect(sent[0]).toContain("subscribe-file");
    expect(sent[1]).toContain("subscribe-team");
  });

  it("skips subscribe-team when the shell has no team", () => {
    const harness = createHarness({}, false);
    harness.sockets[0].open();
    expect(harness.sockets[0].sent).toHaveLength(1);
  });

  it("subscribes again on every reconnect", () => {
    const harness = createHarness();
    harness.sockets[0].open();
    harness.sockets[0].drop();
    expect(harness.timers).toHaveLength(1);
    harness.timers[0].callback();
    expect(harness.sockets).toHaveLength(2);
    expect(harness.sockets[1].sent).toEqual([]);
    harness.sockets[1].open();
    expect(harness.sockets[1].sent).toHaveLength(2);
  });

  it("unsubscribes before closing and does not reconnect", () => {
    const harness = createHarness();
    harness.sockets[0].open();
    harness.collab.stop();
    expect(harness.sockets[0].sent).toHaveLength(3);
    expect(harness.sockets[0].sent[2]).toContain("unsubscribe-file");
    expect(harness.sockets[0].closes).toBe(1);
    expect(harness.timers).toHaveLength(0);
    expect(harness.collab.getState()).toBe("closed");
  });

  it("keeps stop idempotent", () => {
    const harness = createHarness();
    harness.sockets[0].open();
    harness.collab.stop();
    harness.collab.stop();
    expect(harness.sockets[0].closes).toBe(1);
    expect(harness.sockets[0].sent).toHaveLength(3);
  });

  it("routes a delivered file-change to the handler", () => {
    const harness = createHarness();
    harness.sockets[0].open();
    harness.sockets[0].deliver(
      encode({
        type: "file-change",
        topic: FILE_ID,
        "file-id": FILE_ID,
        "session-id": "eeeeeeee-ffff-0000-1111-222222222222",
        revn: 9,
        vern: 2,
        changes: [{ type: "del-obj", "page-id": PAGE_ID, id: SHAPE_ID }],
      }),
    );
    expect(harness.events).toEqual(["change:9:2:1"]);
  });

  it("routes the lifecycle and the presence messages", () => {
    const harness = createHarness();
    harness.sockets[0].open();
    harness.sockets[0].deliver(
      encode({ type: "file-restored", topic: FILE_ID, "file-id": FILE_ID, vern: 4 }),
    );
    harness.sockets[0].deliver(
      encode({ type: "presence", topic: FILE_ID, "file-id": FILE_ID, "session-id": SESSION_ID }),
    );
    harness.sockets[0].deliver(
      encode({
        type: "pointer-update",
        topic: FILE_ID,
        "file-id": FILE_ID,
        "session-id": SESSION_ID,
        "page-id": PAGE_ID,
        "zoom": 1,
        position: { x: 1, y: 2 },
      }),
    );
    expect(harness.events).toEqual(["restored:4"]);
    expect(harness.presences).toHaveLength(1);
    expect(harness.pointers).toEqual([
      {
        fileId: FILE_ID,
        sessionId: SESSION_ID,
        profileId: null,
        pageId: PAGE_ID,
        point: { x: 1, y: 2 },
        zoom: 1,
        zoomInverse: null,
        vbox: null,
        vport: null,
      },
    ]);
  });

  it("reports a malformed payload without closing the socket", () => {
    const harness = createHarness();
    harness.sockets[0].open();
    harness.sockets[0].deliver(encode({ type: "file-change", topic: FILE_ID }));
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]).toBeInstanceOf(Error);
    expect(String(harness.errors[0])).toContain("file-change without a file id");
    expect(harness.collab.getState()).toBe("open");
    // An unknown type is not an error: it is out of scope on purpose.
    harness.sockets[0].deliver(encode({ type: "notification", topic: ZERO_UUID }));
    expect(harness.errors).toHaveLength(1);
  });

  it("sends a pointer update only through an open socket", () => {
    const harness = createHarness();
    const update = {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      zoom: 1,
      zoomInverse: 1,
      vbox: { x: 0, y: 0, width: 10, height: 10 },
      vport: { x: 0, y: 0, width: 10, height: 10 },
      position: { x: 1, y: 2 },
    };
    expect(harness.collab.sendPointer(update)).toBe(false);
    harness.sockets[0].open();
    expect(harness.collab.sendPointer(update)).toBe(true);
    expect(harness.sockets[0].sent[2]).toContain("pointer-update");
  });
});

