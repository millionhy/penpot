// Team ↔ organization management (F5.7b). Headless port of the organization
// slice of app.main.ui.dashboard.team (the settings block, team-settings-page*)
// and of the three Nitrate flows in app.main.data.nitrate: add a team to an
// organization, change the organization of a team (the same command) and take
// a team out of its organization.
//
// Kept free of JSX so it runs in vitest's node environment, like lib/team.ts
// and lib/org-switch.ts; the views live in
// components/team-organization-block.tsx and
// components/select-organization-modal.tsx.
//
// Deviations from the CLJS original, documented:
// - add-team-to-organization audits the move and can park a pending action in
//   the session store while it redirects to the organization's SSO provider.
//   The shell runs the same check-nitrate-sso gate and redirects, but does not
//   persist the pending action, so the call is not replayed automatically when
//   the provider sends the user back; the dashboard reads the fresh teams on
//   return and the user repeats the action. The audit event is not sent either
//   (the shell has no event pipeline for it).
// - The permission helpers take the already-resolved profile id instead of
//   reading the store, and reuse organizationAllowed from lib/org-switch.ts.
// - fetch-organizations-allowed answers with a plain record instead of a
//   Clojure map; the keys are the organization ids.

import { cmd } from "@/lib/rpc";
import { organizationAllowed, teamToOrganization } from "@/lib/org-switch";
import type { Team } from "@/lib/dashboard";
import type { RpcParams } from "@/lib/types";
import type { TeamOrganization, TeamWithOrganization } from "@/lib/team";

// --- Derivations -------------------------------------------------------------

// all-organizations (team-settings-page* and the two modals): every default
// team that sits in an organization contributes its organization object
// (dt/team->organization). Teams without an organization contribute nothing,
// which is why the result is a plain list.
export function allOrganizations(
  teams: ReadonlyArray<TeamWithOrganization>,
): TeamOrganization[] {
  const result: TeamOrganization[] = [];
  for (const team of teams) {
    if (team["is-default"] !== true) continue;
    const organization = teamToOrganization(team);
    if (organization !== null) result.push(organization);
  }
  return result;
}

// The filter shared by both modals: organizations where the user may create
// teams, either because the rule is "any" or because they own it.
export function organizationsAllowedToCreateTeams(
  organizations: ReadonlyArray<TeamOrganization>,
  profileId: string | null | undefined,
): TeamOrganization[] {
  return organizations.filter((organization) => {
    const permission = organization.permissions?.["create-teams"];
    return permission === "any" || (profileId ?? null) === (organization["owner-id"] ?? null);
  });
}

// can-change-organization?: "hide only when the user belongs to one
// organization", the UX rule of team-settings-page*.
export function canChangeOrganization(
  organizations: ReadonlyArray<TeamOrganization>,
): boolean {
  return organizations.length > 1;
}

// can-add-to-organization?: the team owner can attach a standalone team to any
// organization. A default team already belongs to its organization bucket, so
// it never offers the action.
export function canAddToOrganization(
  team: Pick<Team, "is-default" | "permissions"> | null | undefined,
  organizations: ReadonlyArray<TeamOrganization>,
): boolean {
  return (
    team?.permissions?.["is-owner"] === true &&
    organizations.length > 0 &&
    team["is-default"] !== true
  );
}

// allowed? :move-team with target-organization-same-owner? false, the gate of
// show-remove-team-from-organization-modal. The source organization's rules
// decide, with the team permissions joining the check.
export function canRemoveFromOrganization(
  team: Pick<Team, "permissions"> & { organization?: TeamOrganization | null },
  profileId: string | null | undefined,
): boolean {
  const organization = team.organization;
  if (organization === null || organization === undefined) return false;
  return organizationAllowed("move-team", {
    organizationPerms: {
      "owner-id": organization["owner-id"],
      permissions: organization.permissions,
    },
    profileId,
    teamPerms: team.permissions,
    targetOrganizationSameOwner: false,
  });
}

// The selectable targets of show-change-team-organization-modal: the move
// rule narrows the pool ("never" blocks every move, "myOrganizations" keeps
// the organizations of the same owner), then the create-teams rule filters it
// and the current organization drops out.
export function changeTargetOrganizations(
  organizations: ReadonlyArray<TeamOrganization>,
  sourceOrganization: TeamOrganization | null | undefined,
  profileId: string | null | undefined,
): TeamOrganization[] {
  const movePermission = sourceOrganization?.permissions?.["move-teams"];
  const byMove =
    movePermission === "never"
      ? []
      : movePermission === "myOrganizations"
        ? organizations.filter(
            (organization) =>
              (organization["owner-id"] ?? null) ===
              (sourceOrganization?.["owner-id"] ?? null),
          )
        : organizations;
  const sourceId = sourceOrganization?.id ?? null;
  return organizationsAllowedToCreateTeams(byMove, profileId).filter(
    (organization) => organization.id !== sourceId,
  );
}

// fetch-organizations-allowed: organizations whose rule allows anybody to
// join a team are pre-approved; the rest ask the backend whether every one of
// their members sits in the team.
export async function organizationsAllowedToJoin(
  teamId: string,
  organizations: ReadonlyArray<TeamOrganization>,
): Promise<Record<string, boolean>> {
  const allowed: Record<string, boolean> = {};
  const toCheck: TeamOrganization[] = [];
  for (const organization of organizations) {
    if (organizationAllowed("add-anybody-to-team", { organizationPerms: organization })) {
      allowed[organization.id] = true;
    } else {
      toCheck.push(organization);
    }
  }
  if (toCheck.length === 0) return allowed;
  const params: RpcParams["all-team-members-in-organizations"] = {
    "team-id": teamId,
    "organization-ids": toCheck.map((organization) => organization.id),
  };
  const checked = await cmd<Record<string, boolean>>(
    "all-team-members-in-organizations",
    params,
  );
  return { ...allowed, ...checked };
}

// --- Commands ----------------------------------------------------------------

// add-team-to-organization doubles as the change flow in the CLJS original
// (both modals confirm into it), so the shell keeps a single command.
export function addTeamToOrganization(
  teamId: string,
  organizationId: string,
): Promise<unknown> {
  const params: RpcParams["add-team-to-organization"] = {
    "team-id": teamId,
    "organization-id": organizationId,
  };
  return cmd("add-team-to-organization", params);
}

export function removeTeamFromOrganization(
  teamId: string,
  organizationId: string,
  organizationName: string,
): Promise<unknown> {
  const params: RpcParams["remove-team-from-organization"] = {
    "team-id": teamId,
    "organization-id": organizationId,
    "organization-name": organizationName,
  };
  return cmd("remove-team-from-organization", params);
}

export interface NitrateSsoResult {
  authorized?: boolean;
  "redirect-uri"?: string | null;
}

// check-nitrate-sso: whether the organization's identity provider already
// vouches for this session, or where to send the user to get vouched for.
export function checkNitrateSso(
  organizationId: string,
  url: string,
): Promise<NitrateSsoResult> {
  const params = { "organization-id": organizationId, url } as RpcParams["check-nitrate-sso"];
  return cmd<NitrateSsoResult>("check-nitrate-sso", params);
}

export interface ExternalInvitationsStatus {
  "has-external-invitations"?: boolean;
  "allows-anybody"?: boolean;
}

// check-team-external-invitations: the select-organization modal warns when
// moving the team would cancel invitations to people outside the target
// organization.
export function checkTeamExternalInvitations(
  teamId: string,
  organizationId: string,
): Promise<ExternalInvitationsStatus> {
  const params: RpcParams["check-team-external-invitations"] = {
    "team-id": teamId,
    "organization-id": organizationId,
  };
  return cmd<ExternalInvitationsStatus>("check-team-external-invitations", params);
}
