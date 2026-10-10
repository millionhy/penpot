// Organization/team switcher logic (F5.7a). Headless port of the pure half of
// app.main.ui.dashboard.organization-team-switch plus the permission table of
// common/src/app/common/types/organization.cljc: the bucket helpers, the
// two-column dropdown sorting, the organizations map, the small target
// resolvers and allowed?.
//
// Kept free of JSX so it runs in vitest's node environment, like lib/team.ts
// and lib/nitrate.ts; the view lives in components/org-team-switch.tsx.
//
// Deviations from the CLJS original, documented:
// - The organizations map keys buckets by plain strings, with
//   PERSONAL_BUCKET_ID standing in for the :personal keyword, and skips the
//   uuid/parse round-trips because shell ids are already strings. UUID strings
//   are fixed-width hex, so their lexicographic order matches the UUID
//   comparison the CLJS tie-breaks organizations with.
// - The sort-* helpers run over arrays instead of the CLJS persistent map;
//   Clojure sort-by and Array#sort are both stable, so ties keep the input
//   order in either language.
// - profile-id and owner-id compare after normalizing undefined to null, so a
//   missing id on both sides matches the CLJS (= nil nil) exactly.

import { config } from "@/lib/config";
import {
  dashboardHref,
  subscriptionType,
  type Team,
  type TeamPermissions,
} from "@/lib/dashboard";
import { tr } from "@/lib/i18n";
import { buildAdminConsoleHref } from "@/lib/nitrate";
import type { TeamOrganization, TeamWithOrganization } from "@/lib/team";

// --- Buckets -----------------------------------------------------------------

// Sentinel used for the "personal projects" bucket, since those teams have no
// organization (:organization is nil, the :personal keyword here).
export const PERSONAL_BUCKET_ID = "personal";

// Keyed by organization-bucket-id, not raw id: every personal default team
// maps to a nil organization, so keying by id would collide them all under a
// bare nil. The bucket id keeps the "personal/other-teams" entry explicit and
// consistent with selected-organization-id and create-team-target-id.
export type OrganizationsMap = Record<string, TeamOrganization | null>;

// organization-bucket-id: the key an organization (or its absence) is indexed
// under in the organizations map.
export function organizationBucketId(
  organization: TeamOrganization | null | undefined,
): string {
  return organization?.id ?? PERSONAL_BUCKET_ID;
}

// team->organization (app.main.data.team): the nested organization of a team,
// with the team id under :default-team-id. The CLJS assoces unconditionally,
// so every team resolves its organization through its own id, default or not.
export function teamToOrganization(
  team: TeamWithOrganization | null | undefined,
): TeamOrganization | null {
  const organization = team?.organization;
  if (organization === null || organization === undefined) return null;
  return { ...organization, "default-team-id": team?.id };
}

// --- Display -----------------------------------------------------------------

// team-display-name: the default team is the personal "my teams" bucket.
export function teamDisplayName(team: Pick<Team, "is-default" | "name">): string {
  return team["is-default"] ? tr("dashboard.personal-projects") : team.name;
}

// team-href: the dashboard-recent route of a team, the target the CLJS
// resolves through the router.
export function teamHref(team: { id: string }): string {
  return dashboardHref("dashboard-recent", { teamId: team.id });
}

const planBadgeTypes: readonly string[] = ["unlimited", "enterprise"];

// show-subscription-badge?: never on a default team ("Personal projects" has
// no billing of its own) and never on a team that belongs to an organization,
// since a team's :subscription reflects its owner's own plan. Only a
// standalone team outside every organization shows its own plan.
export function showSubscriptionBadge(team: TeamWithOrganization): boolean {
  return (
    !team["is-default"] &&
    (team.organization?.id ?? null) === null &&
    planBadgeTypes.includes(subscriptionType(team.subscription))
  );
}

// --- Sorting -----------------------------------------------------------------

// Clojure compare over strings (String#compareTo and JS relational operators
// both walk UTF-16 code units), with nil sorting first.
function compareStrings(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function lowerOrEmpty(value: string | null | undefined): string {
  return (value ?? "").toLowerCase();
}

// (juxt (boolean :is-default) lower-name): false sorts before true, so the
// default team lands last.
function defaultBucketLast(
  a: { "is-default"?: boolean },
  b: { "is-default"?: boolean },
): number {
  return Number(Boolean(a["is-default"])) - Number(Boolean(b["is-default"]));
}

// sort-organization-teams: orders the teams of a single organization for the
// dropdown's second column, alphabetical with the default team last. boolean
// collapses a missing :is-default and an explicit false into one comparator
// value.
export function sortOrganizationTeams<T extends TeamWithOrganization>(
  teams: ReadonlyArray<T>,
): T[] {
  return [...teams].sort((a, b) => {
    const byDefault = defaultBucketLast(a, b);
    if (byDefault !== 0) return byDefault;
    return compareStrings(lowerOrEmpty(a.name), lowerOrEmpty(b.name));
  });
}

// sort-all-teams: orders every team for the simplified single-column
// dropdown, alphabetical by display name with "Personal projects" last. Takes
// the display-name fn as a parameter so it stays pure; the component passes
// teamDisplayName, which translates the default team's label.
export function sortAllTeams<T extends TeamWithOrganization>(
  teams: ReadonlyArray<T>,
  displayName: (team: T) => string = teamDisplayName,
): T[] {
  return [...teams].sort((a, b) => {
    const byDefault = defaultBucketLast(a, b);
    if (byDefault !== 0) return byDefault;
    return compareStrings(lowerOrEmpty(displayName(a)), lowerOrEmpty(displayName(b)));
  });
}

// teams-for-organization: teams to preview in the dropdown's second column
// for organization-id: teams with no organization of their own when the id is
// the personal bucket, otherwise the teams belonging to that organization,
// sorted for display.
export function teamsForOrganization<T extends TeamWithOrganization>(
  teams: ReadonlyArray<T>,
  organizationId: string,
): T[] {
  const filtered = teams.filter((team) =>
    organizationId === PERSONAL_BUCKET_ID
      ? (team.organization?.id ?? null) === null
      : team.organization?.id === organizationId,
  );
  return sortOrganizationTeams(filtered);
}

function missingId(organization: TeamOrganization | null | undefined): number {
  return organization?.id === null || organization?.id === undefined ? 1 : 0;
}

// sort-organizations: orders the organizations for the dropdown's first
// column, alphabetical with the "Other teams" bucket (no id) always last;
// organizations sharing a name tie-break on id so the order is stable.
export function sortOrganizations(
  organizations: ReadonlyArray<TeamOrganization | null>,
): Array<TeamOrganization | null> {
  return [...organizations].sort((a, b) => {
    const byBucket = missingId(a) - missingId(b);
    if (byBucket !== 0) return byBucket;
    const byName = compareStrings(lowerOrEmpty(a?.name), lowerOrEmpty(b?.name));
    if (byName !== 0) return byName;
    return compareStrings(a?.id ?? null, b?.id ?? null);
  });
}

// --- Switcher derivations ----------------------------------------------------

// closed-control-line-2: the organization name for the second line of the
// closed switcher control, or null when the line must not render at all: the
// profile belongs to no organization, or the current destination has no
// organization of its own.
export function closedControlLine2(
  hasOrganizations: boolean,
  currentOrganization: TeamOrganization | null | undefined,
): string | null {
  return hasOrganizations ? (currentOrganization?.name ?? null) : null;
}

// create-team-target-id: the organization default team id that "Create new
// team" targets, or null when the new team belongs under "Other teams".
// Creation targets the organization currently previewed in the switcher's
// left column, i.e. the one the user triggers the action from, not
// necessarily the open dashboard's own organization.
export function createTeamTargetId(
  organizations: OrganizationsMap,
  organizationId: string,
): string | null {
  if (organizationId === PERSONAL_BUCKET_ID) return null;
  return organizations[organizationId]?.["default-team-id"] ?? null;
}

// team-select-target: the team id to navigate to when a team row is selected,
// or null when selecting is a no-op beyond closing the switcher because the
// user is already in that team.
export function teamSelectTarget(
  selectedTeamId: string,
  currentTeam: { id?: string | null } | null | undefined,
): string | null {
  return selectedTeamId !== (currentTeam?.id ?? null) ? selectedTeamId : null;
}

// show-create-organization-in-teams-column?: whether the simplified
// single-column dropdown offers its own "Create new organization" fallback
// action: only on deployments where the admin console (Nitrate) exists at
// all, mirroring the pre-merge sidebar's top-level (when nitrate? ...) gate.
export function showCreateOrganizationInTeamsColumn(
  flags: readonly string[] = config.flags,
): boolean {
  return flags.includes("admin-console");
}

// resolve-admin-console-href: the admin-console link for the pinned action at
// the bottom of the organizations column: the organization-specific page when
// profile owns organization (the active team's one), the generic
// admin-console page otherwise, including when the active team has no
// organization at all.
export function resolveAdminConsoleHref(
  organization: TeamOrganization | null | undefined,
  profileId: string | null | undefined,
): string {
  const organizationId = organization?.id;
  if (organizationId && (profileId ?? null) === (organization?.["owner-id"] ?? null)) {
    return buildAdminConsoleHref({
      organizationId,
      organizationSlug: organization?.slug ?? null,
    });
  }
  return buildAdminConsoleHref();
}

// The organizations map the first column reads, keyed by
// organization-bucket-id: every default team contributes its organization
// (nil for the personal bucket), then the active team's organization merges
// in last, the way the CLJS cond-> assoc runs — which also means the merged
// entry resolves :default-team-id to the active team itself.
export function organizationsFromTeams(
  teams: ReadonlyArray<TeamWithOrganization>,
  currentOrganization: TeamOrganization | null | undefined,
): OrganizationsMap {
  const organizations: OrganizationsMap = {};
  for (const team of teams) {
    if (!team["is-default"]) continue;
    const organization = teamToOrganization(team);
    organizations[organizationBucketId(organization)] = organization;
  }
  if (currentOrganization?.id) {
    organizations[currentOrganization.id] = currentOrganization;
  }
  return organizations;
}

// has-organizations?: whether the map holds any real organization, i.e. any
// bucket other than the personal one.
export function hasOrganizations(organizations: OrganizationsMap): boolean {
  return Object.keys(organizations).some((key) => key !== PERSONAL_BUCKET_ID);
}

// simplified-mode?: without a valid license and without belonging to any real
// organization there is nothing to put in an organizations column at all;
// fall back to a single teams-only column.
export function simplifiedMode(validLicense: boolean, includesOrganizations: boolean): boolean {
  return !validLicense && !includesOrganizations;
}

// can-leave-organization?: the organization owner cannot leave their own
// organization from the team options menu.
export function canLeaveOrganization(
  organization: TeamOrganization | null | undefined,
  profileId: string | null | undefined,
): boolean {
  if (!organization?.id) return false;
  return (profileId ?? null) !== (organization["owner-id"] ?? null);
}

// show-team-options-button?: a default team (the personal bucket, or an
// organization's own default team) has no options of its own to manage; the
// "..." button is only worth showing when there is at least a
// "leave organization" action behind it.
export function showTeamOptionsButton(
  team: Pick<Team, "is-default"> | null | undefined,
  canLeave: boolean,
): boolean {
  return !team?.["is-default"] || canLeave;
}

// --- Organization permissions ------------------------------------------------

// The five actions of the action-rules table in
// common/src/app/common/types/organization.cljc.
export type OrganizationAction =
  | "create-team"
  | "delete-team"
  | "move-team"
  | "send-invitations"
  | "add-anybody-to-team";

// The {:owner-id ... :permissions ...} slice of an organization the rules
// read; the same fields the switcher already carries on TeamOrganization.
export interface OrganizationPerms {
  "owner-id"?: string | null;
  permissions?: Record<string, string> | null;
}

export interface OrganizationAllowedParams {
  organizationPerms?: OrganizationPerms | null;
  profileId?: string | null;
  teamPerms?: TeamPermissions | null;
  // Only read by :move-team ("myOrganizations").
  targetOrganizationSameOwner?: boolean | null;
}

// The :defaults table; stored permissions merge over it.
const organizationPermissionDefaults: Record<string, string> = {
  "create-teams": "any",
  "delete-teams": "onlyOwners",
  "move-teams": "always",
  "send-invitations": "ownersAndAdmins",
  "new-team-members": "anyone",
};

// allowed?: returns true only for explicitly allowed actions (fail-closed),
// with the owner check comparing profile-id and owner-id after normalizing
// undefined to null so a missing id on both sides matches (= nil nil).
export function organizationAllowed(
  action: OrganizationAction,
  params: OrganizationAllowedParams,
): boolean {
  const rules: Record<string, string> = {
    ...organizationPermissionDefaults,
    ...(params.organizationPerms?.permissions ?? {}),
  };
  const isOrganizationOwner =
    (params.profileId ?? null) === (params.organizationPerms?.["owner-id"] ?? null);
  switch (action) {
    case "create-team":
      // Organization owners can always create teams inside their
      // organizations.
      return isOrganizationOwner || rules["create-teams"] === "any";
    case "delete-team": {
      if (isOrganizationOwner) return true;
      if (rules["delete-teams"] === "onlyOwners") {
        return Boolean(params.teamPerms?.["is-owner"]);
      }
      return false;
    }
    case "move-team": {
      const value = rules["move-teams"];
      if (value === "never") return false;
      if (value === "always") return true;
      if (value === "myOrganizations") return params.targetOrganizationSameOwner === true;
      return false;
    }
    case "send-invitations": {
      const value = rules["send-invitations"];
      if (value === "ownersAndAdmins") {
        return Boolean(params.teamPerms?.["is-owner"]) || Boolean(params.teamPerms?.["is-admin"]);
      }
      if (value === "owners") return Boolean(params.teamPerms?.["is-owner"]);
      return false;
    }
    case "add-anybody-to-team":
      return rules["new-team-members"] === "anyone";
    default:
      return false;
  }
}
