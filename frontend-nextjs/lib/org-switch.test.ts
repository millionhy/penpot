// Pin down the headless half of F5.7a: the bucket helpers, the two-column
// dropdown sorting, the organizations map, the switcher target resolvers and
// the allowed? port of the organization permission table.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "@/lib/config";
import {
  PERSONAL_BUCKET_ID,
  canLeaveOrganization,
  closedControlLine2,
  createTeamTargetId,
  hasOrganizations,
  organizationAllowed,
  organizationBucketId,
  organizationsFromTeams,
  resolveAdminConsoleHref,
  showCreateOrganizationInTeamsColumn,
  showSubscriptionBadge,
  showTeamOptionsButton,
  simplifiedMode,
  sortAllTeams,
  sortOrganizationTeams,
  sortOrganizations,
  teamDisplayName,
  teamHref,
  teamSelectTarget,
  teamToOrganization,
  teamsForOrganization,
} from "@/lib/org-switch";
import type { TeamOrganization, TeamWithOrganization } from "@/lib/team";

function team(overrides: Partial<TeamWithOrganization> = {}): TeamWithOrganization {
  return { id: "t1", name: "Team", ...overrides };
}

function organization(overrides: Partial<TeamOrganization> = {}): TeamOrganization {
  return { id: "o1", name: "Organization", ...overrides };
}

describe("organizationBucketId / teamToOrganization", () => {
  it("keys organizations by id and the absence of one by the personal bucket", () => {
    expect(PERSONAL_BUCKET_ID).toBe("personal");
    expect(organizationBucketId(organization())).toBe("o1");
    expect(organizationBucketId(null)).toBe("personal");
    expect(organizationBucketId(undefined)).toBe("personal");
  });

  it("returns null for a team with no organization", () => {
    expect(teamToOrganization(team())).toBeNull();
    expect(teamToOrganization(null)).toBeNull();
  });

  it("adds the team id under default-team-id without touching the original", () => {
    const org = organization({ slug: "org-slug" });
    const source = team({ id: "t2", organization: org });
    expect(teamToOrganization(source)).toEqual({
      id: "o1",
      name: "Organization",
      slug: "org-slug",
      "default-team-id": "t2",
    });
    expect(org).not.toHaveProperty("default-team-id");
  });
});

describe("teamDisplayName / teamHref", () => {
  it("translates the default team label", () => {
    expect(teamDisplayName(team({ "is-default": true }))).toBe("Personal Projects");
    expect(teamDisplayName(team({ name: "Alpha" }))).toBe("Alpha");
  });

  it("builds the dashboard-recent route", () => {
    expect(teamHref({ id: "t1" })).toBe("/dashboard/recent?team-id=t1");
  });
});

describe("showSubscriptionBadge", () => {
  it("never badges a default team", () => {
    expect(
      showSubscriptionBadge(
        team({ "is-default": true, subscription: { type: "unlimited", status: "active" } }),
      ),
    ).toBe(false);
  });

  it("never badges a team inside an organization", () => {
    expect(
      showSubscriptionBadge(
        team({ organization: organization(), subscription: { type: "unlimited", status: "active" } }),
      ),
    ).toBe(false);
  });

  it("badges a standalone unlimited or enterprise team", () => {
    expect(showSubscriptionBadge(team({ subscription: { type: "unlimited" } }))).toBe(true);
    expect(showSubscriptionBadge(team({ subscription: { type: "enterprise" } }))).toBe(true);
  });

  it("falls back to the professional plan when unpaid or canceled", () => {
    expect(
      showSubscriptionBadge(team({ subscription: { type: "unlimited", status: "canceled" } })),
    ).toBe(false);
    expect(
      showSubscriptionBadge(team({ subscription: { type: "professional", status: "active" } })),
    ).toBe(false);
    expect(showSubscriptionBadge(team())).toBe(false);
    expect(showSubscriptionBadge(team({ subscription: null }))).toBe(false);
  });
});

describe("sortOrganizationTeams", () => {
  it("orders by lower-case name with the default team last", () => {
    const beta = team({ id: "b", name: "Beta" });
    const alpha = team({ id: "a", name: "alpha" });
    const personal = team({ id: "d", name: "Personal", "is-default": true });
    const input = [beta, personal, alpha];
    expect(sortOrganizationTeams(input).map((row) => row.id)).toEqual(["a", "b", "d"]);
    // The input array keeps its order.
    expect(input.map((row) => row.id)).toEqual(["b", "d", "a"]);
  });
});

describe("sortAllTeams", () => {
  it("orders by display name with the default team last", () => {
    const personal = team({ id: "d", "is-default": true, name: "Personal" });
    const beta = team({ id: "b", name: "Beta" });
    const alpha = team({ id: "a", name: "Alpha" });
    expect(sortAllTeams([personal, beta, alpha]).map((row) => row.id)).toEqual(["a", "b", "d"]);
  });

  it("takes the display-name fn as a parameter", () => {
    const x = team({ id: "x", name: "AAA" });
    const y = team({ id: "y", name: "BBB" });
    // Sorting by id reverses the name order, proving the parameter is used.
    expect(sortAllTeams([x, y], (row) => row.id).map((row) => row.id)).toEqual(["x", "y"]);
  });
});

describe("teamsForOrganization", () => {
  const personal = team({ id: "tp", name: "Zeta" });
  const o1a = team({ id: "o1a", name: "Beta", organization: organization({ id: "o1" }) });
  const o1personal = team({
    id: "o1p",
    name: "Personal",
    "is-default": true,
    organization: organization({ id: "o1" }),
  });
  const o2 = team({ id: "o2", name: "Alpha", organization: organization({ id: "o2" }) });

  it("returns the teams of a named organization, sorted", () => {
    expect(teamsForOrganization([personal, o1a, o1personal, o2], "o1").map((row) => row.id)).toEqual(
      ["o1a", "o1p"],
    );
  });

  it("returns the organization-less teams for the personal bucket", () => {
    expect(
      teamsForOrganization([personal, o1a, o1personal, o2], PERSONAL_BUCKET_ID).map(
        (row) => row.id,
      ),
    ).toEqual(["tp"]);
  });
});

describe("sortOrganizations", () => {
  it("orders by name with the id-less bucket last", () => {
    const o2 = organization({ id: "o2", name: "Beta" });
    const o1 = organization({ id: "o1", name: "Alpha" });
    expect(sortOrganizations([null, o2, o1])).toEqual([o1, o2, null]);
  });

  it("tie-breaks same names on the id", () => {
    const b = organization({ id: "b", name: "Same" });
    const a = organization({ id: "a", name: "Same" });
    expect(sortOrganizations([b, a])).toEqual([a, b]);
  });
});

describe("closedControlLine2", () => {
  it("renders the organization name only with organizations around", () => {
    expect(closedControlLine2(false, organization())).toBeNull();
    expect(closedControlLine2(true, organization({ name: "Org name" }))).toBe("Org name");
    expect(closedControlLine2(true, null)).toBeNull();
  });
});

describe("createTeamTargetId / teamSelectTarget", () => {
  const organizations = { o1: organization({ "default-team-id": "td" }), personal: null };

  it("targets the previewed organization default team", () => {
    expect(createTeamTargetId(organizations, "o1")).toBe("td");
    expect(createTeamTargetId(organizations, PERSONAL_BUCKET_ID)).toBeNull();
    expect(createTeamTargetId(organizations, "o9")).toBeNull();
  });

  it("navigates only when the team changes", () => {
    expect(teamSelectTarget("t2", { id: "t1" })).toBe("t2");
    expect(teamSelectTarget("t1", { id: "t1" })).toBeNull();
    expect(teamSelectTarget("t1", null)).toBe("t1");
  });
});

describe("showCreateOrganizationInTeamsColumn", () => {
  it("follows the admin-console flag", () => {
    expect(showCreateOrganizationInTeamsColumn([])).toBe(false);
    expect(showCreateOrganizationInTeamsColumn(["admin-console"])).toBe(true);
  });
});

describe("resolveAdminConsoleHref", () => {
  const originalPublicUri = config.publicUri;

  beforeEach(() => {
    config.publicUri = "";
  });

  afterEach(() => {
    config.publicUri = originalPublicUri;
  });

  it("links the organization page when the profile owns it", () => {
    const org = organization({ "owner-id": "p1", slug: "slug-1" });
    expect(resolveAdminConsoleHref(org, "p1")).toBe(
      "/admin-console/organization/%73%6C%75%67%2D%31/%6F%31/people/",
    );
  });

  it("links the generic page for non-owners, no organization or a missing slug", () => {
    const owned = organization({ "owner-id": "p1", slug: "slug-1" });
    expect(resolveAdminConsoleHref(owned, "p2")).toBe("/admin-console/");
    expect(resolveAdminConsoleHref(null, "p1")).toBe("/admin-console/");
    expect(resolveAdminConsoleHref(organization({ "owner-id": "p1" }), "p1")).toBe(
      "/admin-console/",
    );
  });
});

describe("organizationsFromTeams", () => {
  const personal = team({ id: "tp", "is-default": true });
  const orgDefault = team({
    id: "td",
    "is-default": true,
    organization: organization({ id: "o1", name: "Org One", slug: "org-one", "owner-id": "p1" }),
  });
  const plain = team({ id: "t2" });

  it("indexes every default team's organization under its bucket", () => {
    expect(organizationsFromTeams([personal, orgDefault, plain], null)).toEqual({
      personal: null,
      o1: {
        id: "o1",
        name: "Org One",
        slug: "org-one",
        "owner-id": "p1",
        "default-team-id": "td",
      },
    });
  });

  it("merges the active team's organization last", () => {
    const current = teamToOrganization(team({ id: "t2", organization: organization({ id: "o2" }) }));
    const map = organizationsFromTeams([personal], current);
    expect(map.o2?.["default-team-id"]).toBe("t2");
  });

  it("lets the active organization override the default team's entry", () => {
    // The assoc runs with the active team's own organization, so its
    // :default-team-id resolves through the active team.
    const current = teamToOrganization(team({ id: "t2", organization: organization({ id: "o1" }) }));
    const map = organizationsFromTeams([personal, orgDefault], current);
    expect(map.o1?.["default-team-id"]).toBe("t2");
  });
});

describe("hasOrganizations / simplifiedMode", () => {
  it("detects any non-personal bucket", () => {
    expect(hasOrganizations({ personal: null })).toBe(false);
    expect(hasOrganizations({ personal: null, o1: organization() })).toBe(true);
    expect(hasOrganizations({})).toBe(false);
  });

  it("falls back to a single column without a licence and without organizations", () => {
    expect(simplifiedMode(false, false)).toBe(true);
    expect(simplifiedMode(true, false)).toBe(false);
    expect(simplifiedMode(false, true)).toBe(false);
  });
});

describe("canLeaveOrganization / showTeamOptionsButton", () => {
  it("refuses without an organization and for the owner", () => {
    expect(canLeaveOrganization(null, "p1")).toBe(false);
    expect(canLeaveOrganization(organization({ "owner-id": "p1" }), "p1")).toBe(false);
    expect(canLeaveOrganization(organization({ "owner-id": "p1" }), "p2")).toBe(true);
  });

  it("matches the CLJS nil comparison when both ids are missing", () => {
    expect(canLeaveOrganization(organization(), undefined)).toBe(false);
    expect(canLeaveOrganization(organization(), "p2")).toBe(true);
  });

  it("shows the options button on a regular team, or on a default team with a leave action", () => {
    expect(showTeamOptionsButton(team(), false)).toBe(true);
    expect(showTeamOptionsButton(team({ "is-default": true }), false)).toBe(false);
    expect(showTeamOptionsButton(team({ "is-default": true }), true)).toBe(true);
    expect(showTeamOptionsButton(null, false)).toBe(true);
  });
});

describe("organizationAllowed", () => {
  it("create-team: anyone by default, owners always", () => {
    expect(organizationAllowed("create-team", { profileId: "p2" })).toBe(true);
    const onlyMe = { permissions: { "create-teams": "onlyMe" } };
    expect(organizationAllowed("create-team", { organizationPerms: onlyMe, profileId: "p2" })).toBe(
      false,
    );
    expect(
      organizationAllowed("create-team", {
        organizationPerms: { "owner-id": "p1", ...onlyMe },
        profileId: "p1",
      }),
    ).toBe(true);
  });

  it("delete-team: onlyOwners by default, owners always", () => {
    expect(
      organizationAllowed("delete-team", { profileId: "p2", teamPerms: { "is-owner": true } }),
    ).toBe(true);
    expect(
      organizationAllowed("delete-team", { profileId: "p2", teamPerms: { "is-admin": true } }),
    ).toBe(false);
    expect(organizationAllowed("delete-team", { profileId: "p2" })).toBe(false);
    // A stored value other than "onlyOwners" fails closed for non-owners.
    expect(
      organizationAllowed("delete-team", {
        organizationPerms: { permissions: { "delete-teams": "onlyMe" } },
        profileId: "p2",
        teamPerms: { "is-owner": true },
      }),
    ).toBe(false);
    expect(
      organizationAllowed("delete-team", {
        organizationPerms: { "owner-id": "p1", permissions: { "delete-teams": "onlyMe" } },
        profileId: "p1",
        teamPerms: {},
      }),
    ).toBe(true);
  });

  it("move-team: always by default, never refuses everyone", () => {
    expect(organizationAllowed("move-team", {})).toBe(true);
    expect(
      organizationAllowed("move-team", {
        organizationPerms: { permissions: { "move-teams": "never" } },
        profileId: "p1",
      }),
    ).toBe(false);
    const myOrganizations = { permissions: { "move-teams": "myOrganizations" } };
    expect(
      organizationAllowed("move-team", {
        organizationPerms: myOrganizations,
        targetOrganizationSameOwner: true,
      }),
    ).toBe(true);
    expect(organizationAllowed("move-team", { organizationPerms: myOrganizations })).toBe(false);
    expect(
      organizationAllowed("move-team", {
        organizationPerms: { permissions: { "move-teams": "sometimes" } },
      }),
    ).toBe(false);
  });

  it("send-invitations: ownersAndAdmins by default, owners narrows", () => {
    expect(organizationAllowed("send-invitations", { teamPerms: { "is-admin": true } })).toBe(true);
    expect(organizationAllowed("send-invitations", { teamPerms: { "is-owner": true } })).toBe(true);
    expect(organizationAllowed("send-invitations", { teamPerms: {} })).toBe(false);
    expect(
      organizationAllowed("send-invitations", {
        organizationPerms: { permissions: { "send-invitations": "owners" } },
        teamPerms: { "is-admin": true },
      }),
    ).toBe(false);
    expect(
      organizationAllowed("send-invitations", {
        organizationPerms: { permissions: { "send-invitations": "owners" } },
        teamPerms: { "is-owner": true },
      }),
    ).toBe(true);
  });

  it("add-anybody-to-team: anyone by default", () => {
    expect(organizationAllowed("add-anybody-to-team", {})).toBe(true);
    expect(
      organizationAllowed("add-anybody-to-team", {
        organizationPerms: { permissions: { "new-team-members": "members" } },
      }),
    ).toBe(false);
  });

  it("treats a missing owner id on both sides as the owner, like the CLJS", () => {
    expect(
      organizationAllowed("delete-team", {
        organizationPerms: {},
        profileId: undefined,
        teamPerms: {},
      }),
    ).toBe(true);
  });
});
