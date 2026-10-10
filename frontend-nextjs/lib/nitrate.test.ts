// Pin down the headless half of F5.7a: the admin-console URL builders (the
// lambdaisland join and the byte-for-byte percent-encoding), the licence
// check, the organization team and leave derivations, the leave error mapping,
// the summary-driven modal decision and the wire shape of the two
// leave-organization commands.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "@/lib/config";
import {
  adminConsoleCreateOrganizationHref,
  buildAdminConsoleHref,
  buildAdminConsoleUrl,
  buildTeamsToLeave,
  getLeaveOrganizationSummary,
  isValidLicense,
  leaveOrganization,
  leaveOrganizationModalKind,
  organizationLeaveInfo,
  organizationTeams,
  orgLeaveErrorMessage,
  teamLeaveErrorMessage,
  type LeaveOrganizationSummary,
} from "@/lib/nitrate";
import { decodeTransit, encodeTransit } from "@/lib/transit";
import type { TeamWithOrganization } from "@/lib/team";

function team(overrides: Partial<TeamWithOrganization> = {}): TeamWithOrganization {
  return { id: "t1", name: "Team", ...overrides };
}

describe("admin console URLs", () => {
  const originalPublicUri = config.publicUri;

  beforeEach(() => {
    config.publicUri = "";
  });

  afterEach(() => {
    config.publicUri = originalPublicUri;
  });

  it("joins the public uri with the admin-console path", () => {
    expect(buildAdminConsoleUrl("", null, "")).toBe("/admin-console/");
    expect(buildAdminConsoleUrl("", null, "http://localhost:3449")).toBe(
      "http://localhost:3449/admin-console/",
    );
    expect(buildAdminConsoleUrl("", null, "http://localhost:3449/")).toBe(
      "http://localhost:3449/admin-console/",
    );
  });

  it("appends the query string in map order, dropping nil values", () => {
    expect(
      buildAdminConsoleUrl(
        "",
        { action: "create-organization", origin: "dashboard:organization-switcher" },
        "",
      ),
    ).toBe("/admin-console/?action=create-organization&origin=dashboard%3Aorganization-switcher");
    expect(buildAdminConsoleUrl("", { a: "1", b: null, c: undefined }, "")).toBe(
      "/admin-console/?a=1",
    );
    // An empty map adds nothing; an all-nil map still ends in a bare "?",
    // because the CLJS cond-> assoces :query "" and uri-str renders it.
    expect(buildAdminConsoleUrl("", {}, "")).toBe("/admin-console/");
    expect(buildAdminConsoleUrl("", { b: null }, "")).toBe("/admin-console/?");
  });

  it("keeps the query-encode safe set and encodes the rest per byte", () => {
    // a-zA-Z0-9-._~@/ stay, a space becomes "+", anything else is
    // percent-encoded byte by byte ("%" itself included).
    expect(buildAdminConsoleUrl("", { origin: "a b@c/d" }, "")).toBe(
      "/admin-console/?origin=a+b@c/d",
    );
    expect(buildAdminConsoleUrl("", { origin: "50%" }, "")).toBe(
      "/admin-console/?origin=50%25",
    );
  });

  it("builds the organization page when the id and slug are set", () => {
    // lambdaisland's one-arity percent-encode encodes every byte, so the slug
    // and id travel fully escaped ("slug-1" -> "%73%6C%75%67%2D%31").
    expect(buildAdminConsoleHref({ organizationId: "o1", organizationSlug: "slug-1" })).toBe(
      "/admin-console/organization/%73%6C%75%67%2D%31/%6F%31/people/",
    );
    expect(buildAdminConsoleHref({ organizationId: "o1" })).toBe("/admin-console/");
    expect(buildAdminConsoleHref({ organizationSlug: "slug-1" })).toBe("/admin-console/");
    expect(buildAdminConsoleHref()).toBe("/admin-console/");
    expect(buildAdminConsoleHref(null)).toBe("/admin-console/");
  });

  it("tags the create-organization action with the origin", () => {
    expect(adminConsoleCreateOrganizationHref("dashboard:organization-switcher")).toBe(
      "/admin-console/?action=create-organization&origin=dashboard%3Aorganization-switcher",
    );
  });
});

describe("isValidLicense", () => {
  const originalFlags = config.flags;

  afterEach(() => {
    config.flags = originalFlags;
  });

  it("needs the admin-console flag", () => {
    expect(isValidLicense({ subscription: { status: "active" } })).toBe(false);
  });

  it("accepts the three valid statuses under the flag", () => {
    config.flags = [...config.flags, "admin-console"];
    expect(isValidLicense({ subscription: { status: "active" } })).toBe(true);
    expect(isValidLicense({ subscription: { status: "past_due" } })).toBe(true);
    expect(isValidLicense({ subscription: { status: "trialing" } })).toBe(true);
  });

  it("refuses the other statuses and a missing subscription", () => {
    config.flags = [...config.flags, "admin-console"];
    expect(isValidLicense({ subscription: { status: "canceled" } })).toBe(false);
    expect(isValidLicense({ subscription: { status: "unpaid" } })).toBe(false);
    expect(isValidLicense({ subscription: { status: "paused" } })).toBe(false);
    expect(isValidLicense({})).toBe(false);
    expect(isValidLicense({ subscription: null })).toBe(false);
    expect(isValidLicense(null)).toBe(false);
  });
});

describe("organizationTeams / organizationLeaveInfo", () => {
  const rows: TeamWithOrganization[] = [
    team({ id: "t1", organization: { id: "o1" } }),
    team({ id: "t2" }),
    team({ id: "t3", organization: { id: "o2" } }),
  ];

  it("filters the teams of one organization", () => {
    expect(organizationTeams(rows, "o1").map((row) => row.id)).toEqual(["t1"]);
    expect(organizationTeams(rows, "o9")).toEqual([]);
  });

  it("splits the default team from the not-owned ones", () => {
    const info = organizationLeaveInfo([
      team({ id: "td", "is-default": true }),
      team({ id: "t1", permissions: { "is-owner": true } }),
      team({ id: "t2", permissions: { "is-admin": true } }),
      team({ id: "t3" }),
    ]);
    expect(info.defaultTeamId).toBe("td");
    // The admin is not the owner, and a missing permissions map reads as
    // not-owned; the default team never counts.
    expect(info.notOwnedTeams.map((row) => row.id)).toEqual(["t2", "t3"]);
    expect(organizationLeaveInfo([])).toEqual({ defaultTeamId: undefined, notOwnedTeams: [] });
  });
});

describe("leave error mapping", () => {
  it("maps the four shared team-leave codes", () => {
    expect(teamLeaveErrorMessage("only-owner-can-delete-team")).toBe(
      "Only the owner of a team can delete it.",
    );
    expect(teamLeaveErrorMessage("no-enough-members-for-leave")).toBe(
      "Insufficient members to leave team, you probably want to delete it.",
    );
    expect(teamLeaveErrorMessage("member-does-not-exist")).toBe(
      "The member you try to assign does not exist.",
    );
    expect(teamLeaveErrorMessage("owner-cant-leave-team")).toBe(
      "Owner can't leave team, you must reassign the owner role.",
    );
    expect(teamLeaveErrorMessage("whatever")).toBeNull();
    expect(teamLeaveErrorMessage(undefined)).toBeNull();
  });

  it("adds the two organization codes on top of the shared ones", () => {
    expect(orgLeaveErrorMessage("member-does-not-exist")).toBe(
      "The member you try to assign does not exist.",
    );
    expect(orgLeaveErrorMessage("not-valid-teams")).toBe(
      "There was a problem leaving the organization. Please try again.",
    );
    expect(orgLeaveErrorMessage("organization-owner-cannot-leave")).toBe(
      "The organization owner can't leave the organization.",
    );
    expect(orgLeaveErrorMessage("whatever")).toBeNull();
  });
});

// --- Commands ----------------------------------------------------------------
//
// The fetch stub records the request; the POST body is the transit document
// encodeParams writes, so decodeTransit reads it back (same pattern as
// team.test.ts).

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

describe("leave-organization commands", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the payload with both team lists", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await leaveOrganization({
      id: "o1",
      name: "Org",
      "default-team-id": "td",
      "teams-to-delete": ["t9"],
      "teams-to-leave": [{ id: "t1" }, { id: "t2", "reassign-to": "m1" }],
    });
    expect(calls[0].url).toBe("/api/main/methods/leave-organization");
    expect(calls[0].init.method).toBe("POST");
    expect(decodeTransit(bodyOf(calls[0]))).toEqual({
      id: "o1",
      name: "Org",
      "default-team-id": "td",
      "teams-to-delete": ["t9"],
      "teams-to-leave": [{ id: "t1" }, { id: "t2", "reassign-to": "m1" }],
    });
  });

  it("fetches the summary with a GET and the two ids", async () => {
    const summary: LeaveOrganizationSummary = {
      "teams-to-delete": 0,
      "teams-to-transfer": 0,
      "teams-to-exit": 0,
      "teams-to-detach": 0,
      "team-ids-to-delete": [],
      "transferable-teams": [],
      "member-added-at": null,
      "organization-member-count-before": 3,
    };
    const calls = stubFetch(jsonResponse(summary));
    const result = await getLeaveOrganizationSummary("o1", "td");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].url).toBe(
      "/api/main/methods/get-leave-organization-summary?id=o1&default-team-id=td",
    );
    expect(result["organization-member-count-before"]).toBe(3);
  });
});

describe("buildTeamsToLeave", () => {
  it("keeps the not-owned ids when there is nothing to transfer", () => {
    expect(buildTeamsToLeave([{ id: "t1" }, { id: "t2" }], [])).toEqual([
      { id: "t1" },
      { id: "t2" },
    ]);
  });

  it("wires the transfer entries first, the not-owned ids after", () => {
    // cond->> folds the not-owned list into (concat teams-to-transfer ...),
    // so the transfers travel first and keep their :reassign-to.
    expect(buildTeamsToLeave([{ id: "t1" }], [{ id: "t3", "reassign-to": "m1" }])).toEqual([
      { id: "t3", "reassign-to": "m1" },
      { id: "t1" },
    ]);
  });
});

describe("leaveOrganizationModalKind", () => {
  function summary(overrides: Partial<LeaveOrganizationSummary> = {}): LeaveOrganizationSummary {
    return {
      "teams-to-delete": 0,
      "teams-to-transfer": 0,
      "teams-to-exit": 0,
      "teams-to-detach": 0,
      "team-ids-to-delete": [],
      "transferable-teams": [],
      "member-added-at": null,
      "organization-member-count-before": 1,
      ...overrides,
    };
  }

  it("asks to reassign when something transfers", () => {
    expect(leaveOrganizationModalKind(summary({ "teams-to-transfer": 1 }))).toBe("reassign");
    // The transfer branch wins over any of the warning counts.
    expect(
      leaveOrganizationModalKind(summary({ "teams-to-transfer": 1, "teams-to-delete": 2 })),
    ).toBe("reassign");
  });

  it("warns when teams delete, exit or detach", () => {
    expect(leaveOrganizationModalKind(summary({ "teams-to-delete": 2 }))).toBe("warning");
    expect(leaveOrganizationModalKind(summary({ "teams-to-exit": 1 }))).toBe("warning");
    expect(leaveOrganizationModalKind(summary({ "teams-to-detach": 1 }))).toBe("warning");
  });

  it("plainly confirms otherwise", () => {
    expect(leaveOrganizationModalKind(summary())).toBe("confirm");
  });
});
