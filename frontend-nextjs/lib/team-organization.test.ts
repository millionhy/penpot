// Pin down the headless half of the team ↔ organization block: the
// organizations list of the settings page, the permission gates of the three
// actions and the target list of the change-organization modal.

import { describe, expect, it } from "vitest";
import {
  allOrganizations,
  canAddToOrganization,
  canChangeOrganization,
  canRemoveFromOrganization,
  changeTargetOrganizations,
  organizationsAllowedToCreateTeams,
} from "@/lib/team-organization";
import type { TeamOrganization, TeamWithOrganization } from "@/lib/team";

function team(overrides: Partial<TeamWithOrganization> = {}): TeamWithOrganization {
  return { id: "t1", name: "Team", ...overrides };
}

function organization(overrides: Partial<TeamOrganization> = {}): TeamOrganization {
  return { id: "o1", name: "Organization", ...overrides };
}

describe("allOrganizations", () => {
  it("keeps only the organizations of default teams", () => {
    const org = organization({ id: "o1" });
    const teams = [
      team({ id: "t1", "is-default": true, organization: org }),
      team({ id: "t2", "is-default": false, organization: org }),
      team({ id: "t3", "is-default": true, organization: null }),
      team({ id: "t4", "is-default": true }),
    ];
    expect(allOrganizations(teams)).toEqual([{ ...org, "default-team-id": "t1" }]);
  });

  it("answers with an empty list when nobody belongs to an organization", () => {
    expect(allOrganizations([team()])).toEqual([]);
  });
});

describe("organizationsAllowedToCreateTeams", () => {
  it("keeps the organizations whose rule is any and the ones the user owns", () => {
    const organizations = [
      organization({ id: "any", permissions: { "create-teams": "any" } }),
      organization({ id: "owned", "owner-id": "p1", permissions: { "create-teams": "owners" } }),
      organization({ id: "blocked", "owner-id": "p2", permissions: { "create-teams": "owners" } }),
    ];
    expect(organizationsAllowedToCreateTeams(organizations, "p1").map((org) => org.id)).toEqual([
      "any",
      "owned",
    ]);
  });

  it("reads the stored rule only, like the nitrate filter", () => {
    // show-add-team-to-organization-modal runs (or (= perm "any") is-own?)
    // on the projected permissions, so a missing map grants nothing.
    expect(organizationsAllowedToCreateTeams([organization()], "p1")).toEqual([]);
  });
});

describe("canChangeOrganization", () => {
  it("needs more than one organization, the UX rule of the settings page", () => {
    expect(canChangeOrganization([])).toBe(false);
    expect(canChangeOrganization([organization()])).toBe(false);
    expect(canChangeOrganization([organization(), organization({ id: "o2" })])).toBe(true);
  });
});

describe("canAddToOrganization", () => {
  it("asks for the team owner, an organization and a non-default team", () => {
    const owner = { permissions: { "is-owner": true } };
    expect(canAddToOrganization({ ...owner, "is-default": false }, [organization()])).toBe(true);
    expect(canAddToOrganization({ ...owner, "is-default": true }, [organization()])).toBe(false);
    expect(canAddToOrganization({ "is-default": false, permissions: {} }, [organization()])).toBe(
      false,
    );
    expect(canAddToOrganization({ ...owner, "is-default": false }, [])).toBe(false);
  });
});

describe("canRemoveFromOrganization", () => {
  it("is false for a team without an organization", () => {
    expect(canRemoveFromOrganization({ permissions: { "is-owner": true } }, "p1")).toBe(false);
  });

  it("follows the move-teams rule of the source organization", () => {
    const teamRow = {
      permissions: { "is-owner": true },
      organization: organization({ permissions: { "move-teams": "never" } }),
    };
    expect(canRemoveFromOrganization(teamRow, "p1")).toBe(false);
    expect(
      canRemoveFromOrganization(
        { ...teamRow, organization: organization({ permissions: { "move-teams": "always" } }) },
        "p1",
      ),
    ).toBe(true);
  });

  it("blocks myOrganizations moves, which cannot leave the organization", () => {
    // can-move-team? answers false for myOrganizations unless the target has
    // the same owner, and the remove flow always passes false.
    const organizationRow = organization({
      "owner-id": "p1",
      permissions: { "move-teams": "myOrganizations" },
    });
    expect(
      canRemoveFromOrganization(
        { permissions: { "is-owner": true }, organization: organizationRow },
        "p1",
      ),
    ).toBe(false);
  });
});

describe("changeTargetOrganizations", () => {
  it("drops the current organization and the ones without create permission", () => {
    const source = organization({
      id: "source",
      "owner-id": "p1",
      permissions: { "move-teams": "always", "create-teams": "any" },
    });
    const organizations = [
      source,
      organization({ id: "target", permissions: { "create-teams": "any" } }),
      organization({ id: "blocked", "owner-id": "p2", permissions: { "create-teams": "owners" } }),
    ];
    expect(changeTargetOrganizations(organizations, source, "p1").map((org) => org.id)).toEqual([
      "target",
    ]);
  });

  it("returns nothing when the move rule is never", () => {
    const source = organization({ permissions: { "move-teams": "never" } });
    expect(changeTargetOrganizations([source, organization({ id: "o2" })], source, "p1")).toEqual(
      [],
    );
  });

  it("keeps only the organizations of the same owner under myOrganizations", () => {
    const source = organization({ id: "source", "owner-id": "p1", permissions: { "move-teams": "myOrganizations" } });
    const organizations = [
      source,
      organization({ id: "mine", "owner-id": "p1", permissions: { "create-teams": "any" } }),
      organization({ id: "other", "owner-id": "p2", permissions: { "create-teams": "any" } }),
    ];
    expect(changeTargetOrganizations(organizations, source, "p1").map((org) => org.id)).toEqual([
      "mine",
    ]);
  });
});
