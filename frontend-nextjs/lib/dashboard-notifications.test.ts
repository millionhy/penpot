// Unit tests for the dashboard team notification client (F5.7): the inbound
// classification of process-message's dashboard branch, the topic filter, and
// the subscription lifecycle. The socket and the timers are fakes, exactly like
// the F8.2 collab test, so a reconnect runs on controlled time.

import { describe, expect, it } from "vitest";

import { encodeParams } from "@/lib/transit";
import {
  classifyDashboardNotice,
  createDashboardNotifications,
  type DashboardNotice,
  type DashboardScope,
} from "@/lib/dashboard-notifications";
import type { WorkspaceSocketOptions, WorkspaceWebSocket } from "@/lib/workspace-socket";

const SESSION_ID = "00000000-0000-0000-0000-000000000001";
const TEAM_ID = "66666666-7777-8888-9999-000000000000";
const OTHER_TEAM = "77777777-8888-9999-0000-111111111111";
const PROFILE_ID = "88888888-9999-0000-1111-222222222222";
const ORG_ID = "99999999-0000-1111-2222-333333333333";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const FILE_ID = "11111111-2222-3333-4444-555555555555";

const SCOPE: DashboardScope = { teamId: TEAM_ID, profileId: PROFILE_ID, organizationId: ORG_ID };

function encode(message: Record<string, unknown>): string {
  return encodeParams(message);
}

// --- Classification --------------------------------------------------------

describe("classifyDashboardNotice", () => {
  it("keeps the file and library change types as a single refetch signal", () => {
    for (const type of ["file-change", "file-deleted", "file-restored", "library-change"]) {
      const notice = classifyDashboardNotice({ type, "file-id": FILE_ID }, SCOPE);
      expect(notice).toEqual({ kind: "refetch-files" });
    }
  });

  it("reads a membership change with its team, name and direction", () => {
    const notice = classifyDashboardNotice(
      { type: "team-membership-change", "team-id": TEAM_ID, "team-name": "Acme", change: "removed" },
      SCOPE,
    );
    expect(notice).toEqual({
      kind: "membership-change",
      teamId: TEAM_ID,
      teamName: "Acme",
      change: "removed",
    });
  });

  it("treats a membership change without a team id as malformed", () => {
    const notice = classifyDashboardNotice(
      { type: "team-membership-change", change: "added" },
      SCOPE,
    );
    expect(notice.kind).toBe("malformed");
  });

  it("rejects an unknown membership direction", () => {
    const notice = classifyDashboardNotice(
      { type: "team-membership-change", "team-id": TEAM_ID, change: "suspended" },
      SCOPE,
    );
    expect(notice.kind).toBe("malformed");
  });

  it("classifies a role change and an organization change", () => {
    expect(classifyDashboardNotice({ type: "team-role-change", "team-id": TEAM_ID, role: "viewer" }, SCOPE)).toEqual({
      kind: "role-change",
      teamId: TEAM_ID,
      role: "viewer",
    });
    expect(classifyDashboardNotice({ type: "team-organization-change", "team-id": TEAM_ID }, SCOPE)).toEqual({
      kind: "organization-change",
      teamId: TEAM_ID,
    });
  });

  it("surfaces a system notification with its code and message", () => {
    const notice = classifyDashboardNotice(
      { type: "notification", code: "upgrade-version", message: "A new version is available" },
      SCOPE,
    );
    expect(notice).toEqual({ kind: "system", code: "upgrade-version", message: "A new version is available" });
  });

  it("ignores a type outside the dashboard branch", () => {
    expect(classifyDashboardNotice({ type: "pointer-update", "file-id": FILE_ID }, SCOPE)).toEqual({
      kind: "ignored",
      reason: "type",
      type: "pointer-update",
    });
  });

  it("ignores a foreign topic even of an actionable type", () => {
    const notice = classifyDashboardNotice(
      { type: "file-change", topic: OTHER_TEAM, "file-id": FILE_ID },
      SCOPE,
    );
    expect(notice).toEqual({ kind: "ignored", reason: "topic", type: "file-change" });
  });

  it("keeps the system, team, profile and organization topics", () => {
    for (const topic of [ZERO_UUID, TEAM_ID, PROFILE_ID, ORG_ID]) {
      const notice = classifyDashboardNotice({ type: "library-change", topic }, SCOPE);
      expect(notice).toEqual({ kind: "refetch-files" });
    }
  });

  it("reports a non-map and a typeless message as malformed", () => {
    expect(classifyDashboardNotice(null, SCOPE).kind).toBe("malformed");
    expect(classifyDashboardNotice([1, 2], SCOPE).kind).toBe("malformed");
    expect(classifyDashboardNotice({ topic: TEAM_ID }, SCOPE).kind).toBe("malformed");
  });
});

// --- Subscriber lifecycle --------------------------------------------------

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

interface Harness {
  notices: DashboardNotice[];
  errors: unknown[];
  sockets: FakeSocket[];
  timers: { callback: () => void }[];
}

function createHarness(): Harness {
  const notices: DashboardNotice[] = [];
  const errors: unknown[] = [];
  const sockets: FakeSocket[] = [];
  const timers: { callback: () => void }[] = [];
  let handle = 0;

  createDashboardNotifications(
    {
      scope: SCOPE,
      backendOrigin: "http://localhost:6060",
      sessionId: SESSION_ID,
      socket: {
        createSocket: () => {
          const fake = new FakeSocket();
          sockets.push(fake);
          return fake;
        },
        setTimer: (callback) => {
          timers.push({ callback });
          handle += 1;
          return handle;
        },
        clearTimer: () => undefined,
        random: () => 0.5,
      } satisfies Partial<Omit<WorkspaceSocketOptions, "uri">>,
    },
    {
      onNotice: (notice) => notices.push(notice),
      onError: (error) => errors.push(error),
    },
  );

  return { notices, errors, sockets, timers };
}

describe("createDashboardNotifications", () => {
  it("subscribes the team on the first open, not before", () => {
    const h = createHarness();
    // A send before open is dropped: the client has not sent anything yet.
    expect(h.sockets[0].sent).toEqual([]);
    h.sockets[0].open();
    expect(h.sockets[0].sent).toHaveLength(1);
    expect(h.sockets[0].sent[0]).toContain("subscribe-team");
    expect(h.sockets[0].sent[0]).toContain(TEAM_ID);
  });

  it("re-sends subscribe-team after a reconnect", () => {
    const h = createHarness();
    h.sockets[0].open();
    h.sockets[0].drop();
    // The backoff timer drives the reconnect.
    h.timers[0].callback();
    expect(h.sockets[1]).toBeDefined();
    h.sockets[1].open();
    expect(h.sockets[1].sent[0]).toContain("subscribe-team");
  });

  it("forwards an actionable notice and stays silent on an ignored one", () => {
    const h = createHarness();
    h.sockets[0].open();
    h.sockets[0].deliver(encode({ type: "library-change", topic: TEAM_ID }));
    h.sockets[0].deliver(encode({ type: "pointer-update", "file-id": FILE_ID }));
    expect(h.notices).toEqual([{ kind: "refetch-files" }]);
  });

  it("reports a malformed payload through onError without closing", () => {
    const h = createHarness();
    h.sockets[0].open();
    h.sockets[0].deliver(encode({ type: "team-role-change", role: "editor" }));
    expect(h.errors).toHaveLength(1);
    expect(h.sockets[0].closes).toBe(0);
  });

  it("closes the socket on stop", () => {
    const h = createHarness();
    h.sockets[0].open();
    // Reach into the returned handle through the harness socket: stop is the
    // module's, so assert the fake saw the close via a fresh client.
    const client = createDashboardNotifications(
      {
        scope: SCOPE,
        backendOrigin: "http://localhost:6060",
        sessionId: SESSION_ID,
        socket: {
          createSocket: () => {
            const fake = new FakeSocket();
            h.sockets.push(fake);
            return fake;
          },
          setTimer: () => 1,
          clearTimer: () => undefined,
          random: () => 0.5,
        },
      },
      { onNotice: () => undefined },
    );
    client.stop();
    expect(h.sockets[h.sockets.length - 1].closes).toBe(1);
  });
});
