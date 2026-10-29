// Unit tests for the presence slice (F8.3): the session bookkeeping of
// join/leave, the color palette, the cursor filter (page, TTL) and the
// outbound pointer (message shape, sender registry, 50ms throttle).
//
// The reference behavior under test is handle-presence,
// handle-pointer-update, handle-pointer-send and active-cursors of the
// CLJS workspace, with a fake clock so the TTL is exact.

import { afterEach, describe, expect, it } from "vitest";

import type { PresenceEvent, RemotePointerUpdate } from "@/lib/workspace-collab";
import {
  DEFAULT_PRESENCE_COLOR,
  POINTER_THROTTLE_MS,
  PRESENCE_PALETTE,
  PRESENCE_TTL_MS,
  applyPointerUpdate,
  applyPresence,
  createPointerThrottle,
  hasFreshCursors,
  nextPresenceColor,
  pointerUpdate,
  registerPresencePointerSender,
  sendPresencePointer,
  visibleCursors,
  type PresenceState,
} from "@/lib/workspace-presence";

const FILE_ID = "11111111-2222-3333-4444-555555555555";
const PAGE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_PAGE = "aaaaaaaa-bbbb-cccc-dddd-ffffffffffff";
const SESSION_A = "00000000-0000-0000-0000-00000000000a";
const SESSION_B = "00000000-0000-0000-0000-00000000000b";
const PROFILE_A = "dddddddd-eeee-ffff-0000-111111111111";
const PROFILE_B = "dddddddd-eeee-ffff-0000-222222222222";

function presenceEvent(
  type: PresenceEvent["type"],
  overrides: Partial<PresenceEvent> = {},
): PresenceEvent {
  return {
    type,
    fileId: FILE_ID,
    sessionId: SESSION_A,
    profileId: PROFILE_A,
    ...overrides,
  };
}

function pointerMessage(overrides: Partial<RemotePointerUpdate> = {}): RemotePointerUpdate {
  return {
    fileId: FILE_ID,
    sessionId: SESSION_A,
    profileId: PROFILE_A,
    pageId: PAGE_ID,
    point: { x: 10, y: 20 },
    zoom: 2,
    zoomInverse: 0.5,
    vbox: { x: 0, y: 0, width: 100, height: 80 },
    vport: { x: 0, y: 0, width: 50, height: 40 },
    ...overrides,
  };
}

afterEach(() => {
  registerPresencePointerSender(null);
});

// --- applyPresence ---------------------------------------------------------

describe("applyPresence", () => {
  it("adds a joined session with the first free palette color", () => {
    const state = applyPresence({}, presenceEvent("join-file"), 1000);
    expect(state[SESSION_A]).toEqual({
      id: SESSION_A,
      profileId: PROFILE_A,
      color: PRESENCE_PALETTE[0],
      updatedAt: 1000,
      pageId: null,
      point: null,
      zoom: null,
      zoomInverse: null,
      vbox: null,
      vport: null,
    });
  });

  it("gives each further session the next color and keeps the first on a refresh", () => {
    let state = applyPresence({}, presenceEvent("join-file"), 1000);
    state = applyPresence(state, presenceEvent("join-file", { sessionId: SESSION_B }), 1000);
    expect(state[SESSION_A].color).toBe(PRESENCE_PALETTE[0]);
    expect(state[SESSION_B].color).toBe(PRESENCE_PALETTE[1]);

    state = applyPresence(state, presenceEvent("presence"), 2000);
    expect(state[SESSION_A].color).toBe(PRESENCE_PALETTE[0]);
    expect(state[SESSION_A].updatedAt).toBe(2000);
  });

  it("keeps the known profile id when a message carries none", () => {
    let state = applyPresence({}, presenceEvent("join-file"), 1000);
    state = applyPresence(state, presenceEvent("presence", { profileId: null }), 1500);
    expect(state[SESSION_A].profileId).toBe(PROFILE_A);
  });

  it("drops the session on leave-file and on disconnect", () => {
    const joined = applyPresence({}, presenceEvent("join-file"), 1000);
    const left = applyPresence(joined, presenceEvent("leave-file"), 2000);
    expect(left[SESSION_A]).toBeUndefined();
    const again = applyPresence(joined, presenceEvent("disconnect", { profileId: null }), 2000);
    expect(again[SESSION_A]).toBeUndefined();
  });

  it("answers the same slice when a leave names an unknown session", () => {
    const state = applyPresence({}, presenceEvent("join-file"), 1000);
    expect(applyPresence(state, presenceEvent("leave-file", { sessionId: SESSION_B }), 2000)).toBe(
      state,
    );
  });

  it("falls back to the default color once the palette is taken", () => {
    let state: PresenceState = {};
    for (let index = 0; index < PRESENCE_PALETTE.length; index += 1) {
      state = applyPresence(
        state,
        presenceEvent("join-file", { sessionId: `session-${index}`, profileId: `profile-${index}` }),
        1000 + index,
      );
    }
    expect(nextPresenceColor(state)).toBe(DEFAULT_PRESENCE_COLOR);
    const extra = applyPresence(
      state,
      presenceEvent("join-file", { sessionId: "session-extra" }),
      2000,
    );
    expect(extra["session-extra"].color).toBe(DEFAULT_PRESENCE_COLOR);
  });

  it("assigns a color to a pointer-only session when its join arrives", () => {
    let state = applyPointerUpdate({}, pointerMessage(), 1000);
    expect(state[SESSION_A].color).toBeNull();
    state = applyPresence(state, presenceEvent("join-file"), 1500);
    expect(state[SESSION_A].color).toBe(PRESENCE_PALETTE[0]);
    // The pointer fields are not lost.
    expect(state[SESSION_A].point).toEqual({ x: 10, y: 20 });
  });
});

// --- applyPointerUpdate ----------------------------------------------------

describe("applyPointerUpdate", () => {
  it("writes the pointer fields and the clock, keeping the session identity", () => {
    const joined = applyPresence({}, presenceEvent("join-file"), 1000);
    const state = applyPointerUpdate(joined, pointerMessage(), 1200);
    expect(state[SESSION_A]).toEqual({
      id: SESSION_A,
      profileId: PROFILE_A,
      color: PRESENCE_PALETTE[0],
      updatedAt: 1200,
      pageId: PAGE_ID,
      point: { x: 10, y: 20 },
      zoom: 2,
      zoomInverse: 0.5,
      vbox: { x: 0, y: 0, width: 100, height: 80 },
      vport: { x: 0, y: 0, width: 50, height: 40 },
    });
  });

  it("creates an unknown session without a color, with the message profile", () => {
    const state = applyPointerUpdate(
      {},
      pointerMessage({ profileId: PROFILE_B, sessionId: SESSION_B }),
      900,
    );
    expect(state[SESSION_B]).toEqual({
      id: SESSION_B,
      profileId: PROFILE_B,
      color: null,
      updatedAt: 900,
      pageId: PAGE_ID,
      point: { x: 10, y: 20 },
      zoom: 2,
      zoomInverse: 0.5,
      vbox: { x: 0, y: 0, width: 100, height: 80 },
      vport: { x: 0, y: 0, width: 50, height: 40 },
    });
  });

  it("takes a message with no page or point as the new state of the session", () => {
    const joined = applyPresence({}, presenceEvent("join-file"), 1000);
    const moved = applyPointerUpdate(joined, pointerMessage(), 1100);
    const cleared = applyPointerUpdate(
      moved,
      pointerMessage({ pageId: null, point: null }),
      1200,
    );
    expect(cleared[SESSION_A].pageId).toBeNull();
    expect(cleared[SESSION_A].point).toBeNull();
  });
});

// --- visibleCursors -------------------------------------------------------

describe("visibleCursors", () => {
  const state = visibleState();

  it("keeps the cursors of the open page only", () => {
    expect(visibleCursors(state, PAGE_ID, 1000).map((cursor) => cursor.id)).toEqual([SESSION_A]);
  });

  it("hides a cursor older than the TTL and keeps the boundary", () => {
    expect(visibleCursors(state, PAGE_ID, 1000 + PRESENCE_TTL_MS)).toHaveLength(1);
    expect(visibleCursors(state, PAGE_ID, 1001 + PRESENCE_TTL_MS)).toHaveLength(0);
  });

  it("drops the sessions with no point and orders the rest by session id", () => {
    let next = applyPresence(state, presenceEvent("join-file", { sessionId: SESSION_B }), 1000);
    next = applyPointerUpdate(
      next,
      pointerMessage({ sessionId: SESSION_B, profileId: PROFILE_B, point: { x: 1, y: 2 } }),
      1000,
    );
    expect(visibleCursors(next, PAGE_ID, 1000).map((cursor) => cursor.id)).toEqual([
      SESSION_A,
      SESSION_B,
    ]);
    expect(visibleCursors(next, OTHER_PAGE, 1000)).toHaveLength(0);
  });
});

describe("hasFreshCursors", () => {
  it("is false without a pointer and true with a fresh one", () => {
    expect(hasFreshCursors({}, 0)).toBe(false);
    const joined = applyPresence({}, presenceEvent("join-file"), 1000);
    expect(hasFreshCursors(joined, 1000)).toBe(false);
    const moved = applyPointerUpdate(joined, pointerMessage(), 1000);
    expect(hasFreshCursors(moved, 1000)).toBe(true);
  });

  it("turns false once the TTL has passed", () => {
    const joined = applyPresence({}, presenceEvent("join-file"), 1000);
    const moved = applyPointerUpdate(joined, pointerMessage(), 1000);
    expect(hasFreshCursors(moved, 1000 + PRESENCE_TTL_MS)).toBe(true);
    expect(hasFreshCursors(moved, 1000 + PRESENCE_TTL_MS + 1)).toBe(false);
  });
});

// --- pointerUpdate --------------------------------------------------------

describe("pointerUpdate", () => {
  const viewport = {
    zoom: 2,
    vbox: { x: 5, y: 6, width: 100, height: 80 },
    vport: { width: 50, height: 40 },
  };

  it("builds the wire message from the viewport slice", () => {
    const update = pointerUpdate(
      { fileId: FILE_ID, pageId: PAGE_ID, viewport },
      { x: 12.5, y: 34.5 },
    );
    expect(update).toEqual({
      fileId: FILE_ID,
      pageId: PAGE_ID,
      zoom: 2,
      zoomInverse: 0.5,
      vbox: { x: 5, y: 6, width: 100, height: 80 },
      vport: { x: 0, y: 0, width: 50, height: 40 },
      position: { x: 12.5, y: 34.5 },
    });
  });

  it("answers null without a file, a page or a viewport", () => {
    expect(pointerUpdate({ fileId: null, pageId: PAGE_ID, viewport }, { x: 0, y: 0 })).toBeNull();
    expect(pointerUpdate({ fileId: FILE_ID, pageId: null, viewport }, { x: 0, y: 0 })).toBeNull();
    expect(
      pointerUpdate({ fileId: FILE_ID, pageId: PAGE_ID, viewport: null }, { x: 0, y: 0 }),
    ).toBeNull();
  });
});

// --- Sender registry ------------------------------------------------------

describe("sendPresencePointer", () => {
  it("does nothing until a sender is registered", () => {
    const sent: unknown[] = [];
    expect(sendPresencePointer({ x: 1, y: 2 })).toBe(false);
    registerPresencePointerSender((point) => {
      sent.push(point);
      return true;
    });
    expect(sendPresencePointer({ x: 3, y: 4 })).toBe(true);
    expect(sent).toEqual([{ x: 3, y: 4 }]);
    registerPresencePointerSender(null);
    expect(sendPresencePointer({ x: 5, y: 6 })).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("reports a refusal of the sender", () => {
    registerPresencePointerSender(() => false);
    expect(sendPresencePointer({ x: 0, y: 0 })).toBe(false);
  });
});

// --- Pointer throttle -----------------------------------------------------

describe("createPointerThrottle", () => {
  it("sends the first point of a window and drops the rest", () => {
    let clock = 0;
    const sent: unknown[] = [];
    const throttle = createPointerThrottle({
      now: () => clock,
      send: (point) => sent.push(point),
    });
    expect(throttle.push({ x: 1, y: 1 })).toBe(true);
    clock = POINTER_THROTTLE_MS - 1;
    expect(throttle.push({ x: 2, y: 2 })).toBe(false);
    clock = POINTER_THROTTLE_MS;
    expect(throttle.push({ x: 3, y: 3 })).toBe(true);
    expect(sent).toEqual([
      { x: 1, y: 1 },
      { x: 3, y: 3 },
    ]);
  });

  it("lets the next push through after a reset", () => {
    let clock = 0;
    let sent = 0;
    const throttle = createPointerThrottle({
      now: () => clock,
      send: () => {
        sent += 1;
      },
    });
    throttle.push({ x: 0, y: 0 });
    clock = 10;
    expect(throttle.push({ x: 1, y: 1 })).toBe(false);
    throttle.reset();
    expect(throttle.push({ x: 2, y: 2 })).toBe(true);
    expect(sent).toBe(2);
  });

  it("defaults to the 50ms window", () => {
    let clock = 0;
    const throttle = createPointerThrottle({ now: () => clock, send: () => undefined });
    expect(throttle.push({ x: 0, y: 0 })).toBe(true);
    clock = 49;
    expect(throttle.push({ x: 1, y: 1 })).toBe(false);
    clock = 50;
    expect(throttle.push({ x: 2, y: 2 })).toBe(true);
  });
});

// A joined session with a cursor on PAGE_ID at clock 1000, and a second
// session without a pointer.
function visibleState(): PresenceState {
  let state = applyPresence({}, presenceEvent("join-file"), 900);
  state = applyPresence(state, presenceEvent("join-file", { sessionId: SESSION_B }), 900);
  state = applyPointerUpdate(state, pointerMessage(), 1000);
  state = applyPointerUpdate(
    state,
    pointerMessage({ sessionId: SESSION_B, pageId: OTHER_PAGE, point: { x: 3, y: 4 } }),
    1000,
  );
  return state;
}
