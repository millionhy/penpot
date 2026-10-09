// Pin down the headless half of F5.5: the permission and role rules ported
// from app.main.ui.dashboard.team, the member/invitation list derivations, the
// webhook error mapping, the team-hero storage key and the wire shape of the
// member, invitation and webhook commands.

import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "@/lib/config";
import { decodeTransit, encodeTransit } from "@/lib/transit";
import {
  TEAM_FORM_SUCCESS_MESSAGE,
  TEAM_HERO_STORAGE_KEY,
  TEAM_HERO_STORAGE_NS,
  availableRoles,
  canChangeMemberRole,
  canEditWebhook,
  canLeaveFromMenu,
  canRemoveFromMenu,
  canSendInvitations,
  createInvitations,
  createWebhook,
  deleteWebhook,
  extractStatus,
  getTeamMembers,
  globalEnabledFeatures,
  invitationStatus,
  invitationUrl,
  isYou,
  leaveTeam,
  memberRole,
  nextSortState,
  orderedMembers,
  readTeamHeroVisible,
  refreshTeamPermissions,
  roleLabel,
  selectedInvitations,
  showMemberMenu,
  sortedInvitations,
  teamFormErrorMessage,
  teamPhotoUrl,
  translateErrorHint,
  updateMemberRole,
  webhookLastDeliveryText,
  writeTeamHeroVisible,
  type TeamInvitation,
  type TeamMember,
  type TeamWithOrganization,
  type Webhook,
} from "@/lib/team";

function team(overrides: Partial<TeamWithOrganization> = {}): TeamWithOrganization {
  return { id: "t1", name: "Team", ...overrides };
}

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return { id: "m1", email: "m1@example.com", ...overrides };
}

function invitation(overrides: Partial<TeamInvitation> = {}): TeamInvitation {
  return { email: "a@example.com", role: "editor", ...overrides };
}

function webhook(overrides: Partial<Webhook> = {}): Webhook {
  return { id: "w1", uri: "https://example.com/hook", ...overrides };
}

describe("canSendInvitations", () => {
  const originalFlags = config.flags;

  afterEach(() => {
    config.flags = originalFlags;
  });

  it("falls back to the team owner/admin flags", () => {
    expect(canSendInvitations(team({ permissions: { "is-owner": true } }), "p1")).toBe(true);
    expect(canSendInvitations(team({ permissions: { "is-admin": true } }), "p1")).toBe(true);
    expect(canSendInvitations(team({ permissions: { "can-edit": true } }), "p1")).toBe(false);
    expect(canSendInvitations(team({ permissions: {} }), "p1")).toBe(false);
    expect(canSendInvitations(null, "p1")).toBe(false);
  });

  it("lets the organization rules decide under the admin-console flag", () => {
    config.flags = [...config.flags, "admin-console"];
    // No stored rule: the :send-invitations default is ownersAndAdmins.
    const organization = { id: "o1" };
    expect(
      canSendInvitations(team({ permissions: { "is-owner": true }, organization }), "p1"),
    ).toBe(true);
    expect(
      canSendInvitations(team({ permissions: { "is-admin": true }, organization }), "p1"),
    ).toBe(true);
    expect(
      canSendInvitations(team({ permissions: { "can-edit": true }, organization }), "p1"),
    ).toBe(false);
  });

  it("narrows to owners when the organization says so", () => {
    config.flags = [...config.flags, "admin-console"];
    const organization = { id: "o1", permissions: { "send-invitations": "owners" } };
    expect(
      canSendInvitations(team({ permissions: { "is-owner": true }, organization }), "p1"),
    ).toBe(true);
    expect(
      canSendInvitations(team({ permissions: { "is-admin": true }, organization }), "p1"),
    ).toBe(false);
  });

  it("refuses everyone on an unrecognized rule", () => {
    config.flags = [...config.flags, "admin-console"];
    const organization = { id: "o1", permissions: { "send-invitations": "nobody" } };
    expect(
      canSendInvitations(team({ permissions: { "is-owner": true }, organization }), "p1"),
    ).toBe(false);
  });

  it("keeps the fallback without a stored organization", () => {
    config.flags = [...config.flags, "admin-console"];
    expect(canSendInvitations(team({ permissions: { "is-owner": true } }), "p1")).toBe(true);
  });
});

describe("roles", () => {
  it("offers viewer and editor, plus admin for a team admin", () => {
    expect(availableRoles(team({ permissions: {} })).map((role) => role.value)).toEqual([
      "viewer",
      "editor",
    ]);
    expect(
      availableRoles(team({ permissions: { "is-admin": true } })).map((role) => role.value),
    ).toEqual(["viewer", "editor", "admin"]);
    // An owner that is not flagged admin does not get the option, like
    // get-available-roles.
    expect(
      availableRoles(team({ permissions: { "is-owner": true } })).map((role) => role.value),
    ).toEqual(["viewer", "editor"]);
    expect(availableRoles(null).map((role) => role.value)).toEqual(["viewer", "editor"]);
  });

  it("labels a role, defaulting to viewer", () => {
    expect(roleLabel("owner")).toBe("Owner");
    expect(roleLabel("admin")).toBe("Admin");
    expect(roleLabel("editor")).toBe("Editor");
    expect(roleLabel("viewer")).toBe("Viewer");
    expect(roleLabel("something-else")).toBe("Viewer");
    expect(roleLabel(null)).toBe("Viewer");
  });

  it("reads the exclusive role of a member row", () => {
    expect(memberRole(member({ "is-owner": true, "is-admin": true, "can-edit": true }))).toBe(
      "owner",
    );
    expect(memberRole(member({ "is-admin": true, "can-edit": true }))).toBe("admin");
    expect(memberRole(member({ "can-edit": true }))).toBe("editor");
    expect(memberRole(member())).toBe("viewer");
  });

  it("turns the role cell into a dropdown for a non-owner member", () => {
    const owner = team({ permissions: { "is-owner": true } });
    const admin = team({ permissions: { "is-admin": true } });
    const editor = team({ permissions: { "can-edit": true } });
    const target = member({ id: "m2" });
    expect(canChangeMemberRole(owner, target, "p1")).toBe(true);
    expect(canChangeMemberRole(admin, target, "p1")).toBe(true);
    expect(canChangeMemberRole(editor, target, "p1")).toBe(false);
    expect(canChangeMemberRole(owner, member({ id: "m2", "is-owner": true }), "p1")).toBe(false);
    // The (not (and is-you is-owner)) branch is subsumed by the owner check.
    expect(canChangeMemberRole(owner, member({ id: "p1", "is-owner": true }), "p1")).toBe(false);
    expect(canChangeMemberRole(null, target, "p1")).toBe(false);
  });
});

describe("member menus", () => {
  it("shows the '...' trigger on your own row or for a deletable member", () => {
    const owner = team({ permissions: { "is-owner": true } });
    const admin = team({ permissions: { "is-admin": true } });
    const viewer = team({ permissions: {} });
    const target = member({ id: "m2" });
    expect(showMemberMenu(viewer, member({ id: "p1" }), "p1")).toBe(true);
    expect(showMemberMenu(owner, target, "p1")).toBe(true);
    expect(showMemberMenu(admin, target, "p1")).toBe(true);
    // An admin does not manage the owner row (is-owner? and (not owner?)).
    expect(showMemberMenu(admin, member({ id: "m2", "is-owner": true }), "p1")).toBe(false);
    expect(showMemberMenu(viewer, target, "p1")).toBe(false);
  });

  it("keeps 'Leave team' on your own row", () => {
    expect(canLeaveFromMenu(member({ id: "p1" }), "p1")).toBe(true);
    expect(canLeaveFromMenu(member({ id: "m2" }), "p1")).toBe(false);
    expect(canLeaveFromMenu(member({ id: "m2" }), null)).toBe(false);
  });

  it("keeps 'Remove member' off your own row and off a superior owner", () => {
    const owner = team({ permissions: { "is-owner": true } });
    const admin = team({ permissions: { "is-admin": true } });
    expect(canRemoveFromMenu(owner, member({ id: "m2" }), "p1")).toBe(true);
    expect(canRemoveFromMenu(owner, member({ id: "p1" }), "p1")).toBe(false);
    expect(canRemoveFromMenu(admin, member({ id: "m2", "is-owner": true }), "p1")).toBe(false);
    expect(canRemoveFromMenu(admin, member({ id: "m3", "is-admin": true }), "p1")).toBe(true);
  });
});

describe("orderedMembers", () => {
  it("puts the owner first and sorts the rest by created-at", () => {
    const rows = [
      member({ id: "b", "created-at": "2026-02-01T00:00:00Z" }),
      member({ id: "owner", "is-owner": true, "created-at": "2026-09-01T00:00:00Z" }),
      member({ id: "a", "created-at": new Date("2026-01-01T00:00:00Z") }),
    ];
    expect(orderedMembers(rows).map((row) => row.id)).toEqual(["owner", "a", "b"]);
  });

  it("renders sorted when no owner row is present", () => {
    const rows = [
      member({ id: "b", "created-at": "2026-02-01T00:00:00Z" }),
      member({ id: "a", "created-at": "2026-01-01T00:00:00Z" }),
    ];
    expect(orderedMembers(rows).map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("treats a missing created-at as the epoch", () => {
    const rows = [
      member({ id: "dated", "created-at": "2026-01-01T00:00:00Z" }),
      member({ id: "undated" }),
    ];
    expect(orderedMembers(rows).map((row) => row.id)).toEqual(["undated", "dated"]);
  });

  it("detects the viewer's own row", () => {
    expect(isYou(member({ id: "p1" }), "p1")).toBe(true);
    expect(isYou(member({ id: "m2" }), "p1")).toBe(false);
    expect(isYou(member({ id: "m2" }), null)).toBe(false);
  });
});

describe("invitation sorting", () => {
  it("flips the active column and starts the other one ascending", () => {
    expect(nextSortState({ field: null, direction: "asc" }, "role")).toEqual({
      field: "role",
      direction: "asc",
    });
    expect(nextSortState({ field: "role", direction: "asc" }, "role")).toEqual({
      field: "role",
      direction: "desc",
    });
    expect(nextSortState({ field: "role", direction: "desc" }, "role")).toEqual({
      field: "role",
      direction: "asc",
    });
    expect(nextSortState({ field: "role", direction: "desc" }, "status")).toEqual({
      field: "status",
      direction: "asc",
    });
  });

  it("keeps the input order without a sort column", () => {
    const rows = [invitation({ email: "b@x" }), invitation({ email: "a@x" })];
    expect(sortedInvitations(rows, { field: null, direction: "asc" })).toEqual(rows);
  });

  it("sorts by status: pending before expired, email breaks ties", () => {
    const rows = [
      invitation({ email: "b@x", expired: true }),
      invitation({ email: "c@x" }),
      invitation({ email: "a@x", expired: true }),
    ];
    const asc = sortedInvitations(rows, { field: "status", direction: "asc" });
    expect(asc.map((row) => row.email)).toEqual(["c@x", "a@x", "b@x"]);
    const desc = sortedInvitations(rows, { field: "status", direction: "desc" });
    expect(desc.map((row) => row.email)).toEqual(["b@x", "a@x", "c@x"]);
  });

  it("sorts by role name, email breaks ties", () => {
    const rows = [
      invitation({ email: "b@x", role: "viewer" }),
      invitation({ email: "c@x", role: "admin" }),
      invitation({ email: "a@x", role: "admin" }),
      invitation({ email: "d@x", role: undefined }),
    ];
    // clojure.core/compare puts nil before any keyword, so the missing role
    // leads the ascending order.
    const asc = sortedInvitations(rows, { field: "role", direction: "asc" });
    expect(asc.map((row) => row.email)).toEqual(["d@x", "a@x", "c@x", "b@x"]);
    const desc = sortedInvitations(rows, { field: "role", direction: "desc" });
    expect(desc.map((row) => row.email)).toEqual(["b@x", "c@x", "a@x", "d@x"]);
  });

  it("reads the badge state and the checked rows", () => {
    expect(invitationStatus(invitation({ expired: true }))).toBe("expired");
    expect(invitationStatus(invitation())).toBe("pending");
    const rows = [invitation({ email: "a@x" }), invitation({ email: "b@x" })];
    const checked = new Set(["b@x", "gone@x"]);
    expect(selectedInvitations(rows, checked).map((row) => row.email)).toEqual(["b@x"]);
  });
});

describe("webhooks", () => {
  it("lets the team editor or the hook creator edit", () => {
    const editor = team({ permissions: { "can-edit": true } });
    const viewer = team({ permissions: {} });
    expect(canEditWebhook(webhook(), editor, "p1")).toBe(true);
    expect(canEditWebhook(webhook({ "profile-id": "p1" }), viewer, "p1")).toBe(true);
    expect(canEditWebhook(webhook({ "profile-id": "p2" }), viewer, "p1")).toBe(false);
    expect(canEditWebhook(webhook(), null, "p1")).toBe(false);
  });

  it("extracts the status after the prefix", () => {
    expect(extractStatus("unexpected-status:500")).toBe("500");
    expect(extractStatus("unexpected-status: 404")).toBe("404");
    expect(extractStatus("timeout")).toBe("");
  });

  it("maps the validation hints to their messages", () => {
    expect(translateErrorHint("invalid-uri")).toBe("URL does not pass validation.");
    expect(translateErrorHint("ssl-validation-error")).toBe("Error on SSL validation.");
    expect(translateErrorHint("timeout")).toBe("Timeout");
    expect(translateErrorHint("connection-error")).toBe(
      "Connection error, URL not reacheable",
    );
    expect(translateErrorHint("unexpected-status:502")).toBe("Unexpected status 502");
    expect(translateErrorHint("blocked-request:some-detail")).toBe(
      "Connection error, URL not reacheable",
    );
    expect(translateErrorHint("whatever")).toBe("Unexpected error on validating");
    expect(translateErrorHint(null)).toBe("Unexpected error on validating");
  });

  it("writes the last-delivery tooltip", () => {
    expect(webhookLastDeliveryText(webhook())).toBe("Last delivery was successful.");
    expect(webhookLastDeliveryText(webhook({ "error-code": null }))).toBe(
      "Last delivery was successful.",
    );
    expect(webhookLastDeliveryText(webhook({ "error-code": "ssl-validation-error" }))).toBe(
      "Last delivery was not successful. Error on SSL validation.",
    );
    // The ssl class is an exact match in CLJS; a suffixed code falls through
    // to the generic branch.
    expect(webhookLastDeliveryText(webhook({ "error-code": "ssl-validation-error:cert" }))).toBe(
      "Last delivery was not successful. Unexpected error on validating",
    );
    expect(webhookLastDeliveryText(webhook({ "error-code": "unexpected-status:403" }))).toBe(
      "Last delivery was not successful. Unexpected status 403",
    );
    expect(webhookLastDeliveryText(webhook({ "error-code": "timeout" }))).toBe(
      "Last delivery was not successful. Unexpected error on validating",
    );
  });
});

describe("invitationUrl and teamPhotoUrl", () => {
  it("builds the verify-token URL from the public uri", () => {
    expect(invitationUrl("https://penpot.example", "tok-1")).toBe(
      "https://penpot.example?screen=auth-verify-token&token=tok-1",
    );
    expect(invitationUrl("", "tok-1")).toBe("?screen=auth-verify-token&token=tok-1");
  });

  it("resolves a stored team photo to assets/by-id", () => {
    expect(teamPhotoUrl({ "photo-id": "abc" }, "http://x:9001")).toBe(
      "http://x:9001/assets/by-id/abc",
    );
    expect(teamPhotoUrl({ "photo-id": "abc" }, "http://x:9001/")).toBe(
      "http://x:9001/assets/by-id/abc",
    );
    expect(teamPhotoUrl({ "photo-id": "abc" }, "")).toBe("/assets/by-id/abc");
    expect(teamPhotoUrl({ "photo-id": null }, "http://x:9001")).toBeNull();
    expect(teamPhotoUrl({}, "http://x:9001")).toBeNull();
  });
});

describe("team hero storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to visible without a browser storage", () => {
    expect(readTeamHeroVisible()).toBe(true);
  });

  it("round-trips the dismissed flag under the CLJS storage key", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });

    writeTeamHeroVisible(false);
    const key = "penpot-global:" + TEAM_HERO_STORAGE_NS + "/" + TEAM_HERO_STORAGE_KEY;
    expect(store.has(key)).toBe(true);
    expect(decodeTransit(store.get(key) ?? "")).toBe(false);
    expect(readTeamHeroVisible()).toBe(false);

    // A non-boolean entry reads as visible (the coerce of the CLJS nav).
    store.set(key, encodeTransit("yes"));
    expect(readTeamHeroVisible()).toBe(true);
  });
});

// --- Commands ----------------------------------------------------------------
//
// The fetch stub records the request; the POST body is the transit document
// encodeParams writes, so decodeTransit reads it back and the raw text pins
// the values that must travel as keywords or sets.

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(response: () => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  });
  return calls;
}

function jsonResponse(payload: unknown): () => Response {
  return () =>
    new Response(encodeTransit(payload), {
      status: 200,
      headers: { "content-type": "application/transit+json" },
    });
}

function bodyOf(call: RecordedCall): string {
  return call.init.body as string;
}

describe("team commands", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the members with a GET and the team-id query", async () => {
    const calls = stubFetch(jsonResponse([{ id: "m1", email: "m1@example.com" }]));
    const rows = await getTeamMembers("t1");
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].url).toBe("/api/main/methods/get-team-members?team-id=t1");
    expect(rows[0].id).toBe("m1");
  });

  it("sends the member role as a transit keyword", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await updateMemberRole("t1", "m1", "admin");
    const body = decodeTransit<Record<string, unknown>>(bodyOf(calls[0]));
    expect(body).toEqual({ "team-id": "t1", "member-id": "m1", role: "admin" });
    // The backend malli schema wants :role as a keyword; a plain string would
    // fail validation, so the raw document must carry "~:admin".
    expect(bodyOf(calls[0])).toContain('"~:admin"');
  });

  it("sends the emails format as a transit set plus the role keyword", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await createInvitations({
      teamId: "t1",
      emails: ["a@x", "b@x"],
      role: "editor",
    });
    const body = decodeTransit<Record<string, unknown>>(bodyOf(calls[0]));
    expect(body["team-id"]).toBe("t1");
    expect(body.emails).toEqual(["a@x", "b@x"]);
    expect(body.role).toBe("editor");
    const raw = bodyOf(calls[0]);
    expect(raw).toContain("~#set");
    expect(raw).toContain('"~:editor"');
    expect(body["resend?"]).toBeUndefined();
  });

  it("sends the invitations format with a keyword per row and the resend flag", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await createInvitations({
      teamId: "t1",
      invitations: [{ email: "a@x", role: "viewer" }],
      resend: true,
    });
    const body = decodeTransit<{ invitations: unknown; "resend?": unknown }>(bodyOf(calls[0]));
    expect(body.invitations).toEqual([{ email: "a@x", role: "viewer" }]);
    expect(body["resend?"]).toBe(true);
    expect(bodyOf(calls[0])).toContain('"~:viewer"');
  });

  it("refuses a params map with neither invitation format", () => {
    expect(() => createInvitations({ teamId: "t1" })).toThrow(/emails\+role/);
  });

  it("sends only the id when deleting a webhook", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await deleteWebhook("w1");
    const body = decodeTransit<Record<string, unknown>>(bodyOf(calls[0]));
    expect(Object.keys(body)).toEqual(["id"]);
    expect(body.id).toBe("w1");
  });

  it("always sends is-active when creating a webhook", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await createWebhook("t1", "https://example.com/hook", "application/json", false);
    const body = decodeTransit<Record<string, unknown>>(bodyOf(calls[0]));
    expect(body).toEqual({
      "team-id": "t1",
      uri: "https://example.com/hook",
      mtype: "application/json",
      "is-active": false,
    });
  });

  it("attaches reassign-to only when the leaver picked a new owner", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await leaveTeam("t1");
    expect(Object.keys(decodeTransit<Record<string, unknown>>(bodyOf(calls[0])))).toEqual(["id"]);

    await leaveTeam("t1", "m2");
    const body = decodeTransit<Record<string, unknown>>(bodyOf(calls[1]));
    expect(body).toEqual({ id: "t1", "reassign-to": "m2" });
  });
});

describe("team form messages", () => {
  it("keeps the untranslated success literal of team_form.cljs", () => {
    expect(TEAM_FORM_SUCCESS_MESSAGE).toBe("Team created successfully");
  });

  it("picks the error by whether the request carried an id", () => {
    expect(teamFormErrorMessage(true)).toBe("Error on updating team.");
    expect(teamFormErrorMessage(false)).toBe("Error on creating team.");
  });
});

describe("globalEnabledFeatures", () => {
  const originalFlags = config.flags;

  afterEach(() => {
    config.flags = originalFlags;
  });

  it("always carries the default feature set", () => {
    config.flags = [];
    const features = globalEnabledFeatures();
    expect(features).toContain("components/v2");
    expect(features).toContain("layout/grid");
    expect(features).toContain("tokens/numeric-input");
    expect(features).not.toContain("text-editor/v2");
  });

  it("adds the features that their flags enable", () => {
    config.flags = ["feature-text-editor-v2", "feature-render-wasm"];
    const features = globalEnabledFeatures();
    expect(features).toContain("text-editor/v2");
    expect(features).toContain("render-wasm/v1");
    // A set: no duplicate when a flag repeats a default feature.
    expect(features.filter((feature) => feature === "styles/v2")).toHaveLength(1);
  });
});

describe("refreshTeamPermissions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // with-refreshed-team runs get-teams and seeks the id; it never calls
  // get-team, so the permission decision runs on the freshly fetched row and
  // the caller can refresh its teams list from the same answer.
  it("seeks the id in the get-teams answer and decides on that row", async () => {
    const calls = stubFetch(
      jsonResponse([
        { id: "t2", permissions: {} },
        { id: "t1", permissions: { "is-admin": true } },
      ]),
    );
    const result = await refreshTeamPermissions("t1", "p1");
    expect(calls[0].url).toBe("/api/main/methods/get-teams");
    expect(result.team?.id).toBe("t1");
    expect(result.canInvite).toBe(true);
  });

  it("leaves team null and invites refused when the id is gone", async () => {
    stubFetch(jsonResponse([{ id: "t2", permissions: { "is-owner": true } }]));
    const result = await refreshTeamPermissions("missing", "p1");
    expect(result.team).toBeNull();
    expect(result.canInvite).toBe(false);
  });
});
