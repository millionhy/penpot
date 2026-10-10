// Team management logic (F5.5). Headless port of the member, invitation and
// webhook slice of app.main.data.team, the derived selections of
// app.main.ui.dashboard.team (members section, invitations section, webhooks
// section, settings section), the change-owner modal and the team form.
//
// Kept free of JSX so it runs in vitest's node environment, like
// lib/dashboard.ts and lib/forms.ts. The views live in app/dashboard/*
// and components/team-*.tsx.
//
// Deviations from the CLJS original, documented:
// - dtm/fetch-members logs and skips a :not-found team; the shell caller treats
//   the same error as an empty list (see loadMembers in dashboard-context).
// - check-and-submit-invite-members carries organization branches behind the
//   :admin-console flag (check-organization-members and
//   all-organization-members-in-team); the shell runs with the flag off, so it
//   ports the fallback path and leaves the branches to F5.7.
// - The team-form success toast in team_form.cljs is the untranslated literal
//   "Team created successfully" for both create and update; the shell keeps the
//   same literal because the catalog has no entry to translate.

import { config, hasFlag } from "@/lib/config";
import { tr } from "@/lib/i18n";
import { cmd, cmdUpload } from "@/lib/rpc";
import { globalStorage } from "@/lib/storage";
import { keyword, set as transitSet } from "@/lib/transit";
import type { RpcParams } from "@/lib/types";
import { getTeams, type InstantValue, type Team } from "@/lib/dashboard";

// --- Row shapes ------------------------------------------------------------
//
// get-team-members answers with tp.* (team_profile_rel) joined to the profile
// row (sql:team-members in backend/src/app/rpc/commands/teams.clj): the role
// flags live on the relation, the identity fields on the profile.

export interface TeamMember {
  id: string;
  email: string;
  name?: string;
  fullname?: string;
  "photo-id"?: string | null;
  "is-active"?: boolean;
  // team_profile_rel columns.
  "team-id"?: string;
  "profile-id"?: string;
  "is-owner"?: boolean;
  "is-admin"?: boolean;
  "can-edit"?: boolean;
  "created-at"?: InstantValue | null;
}

export type TeamRole = "owner" | "admin" | "editor" | "viewer";

// sql:team-invitations row; :role travels as a keyword and decodes to a string
// through lib/transit.ts.
export interface TeamInvitation {
  email: string;
  role?: TeamRole | string;
  expired?: boolean;
}

// sql:team-stats row: both counts include the drafts project and the files of
// every project (deleted files land in the count too, same as CLJS).
export interface TeamStats {
  projects?: number;
  files?: number;
}

// The two content types the backend accepts (valid-mtypes in
// backend/src/app/rpc/commands/webhooks.clj; the CLJS form offers the same two
// even though data/team.cljs validates one more).
export type WebhookMtype = "application/json" | "application/transit+json";

// sql:get-webhooks row.
export interface Webhook {
  id: string;
  uri: string;
  mtype?: WebhookMtype | string;
  "is-active"?: boolean;
  "error-code"?: string | null;
  "error-count"?: number;
  "profile-id"?: string;
}

// The organization slice a team row carries when the backend runs with the
// :admin-console flag (add-organization-info-to-teams in nitrate.clj projects
// the organization->team-keys of common/src/app/common/types/organization.cljc
// onto the row: id, name, custom-photo, slug, avatar-bg-url, owner-id,
// expired-license, permissions, sso-active). team->organization adds the team
// id under :default-team-id so any team can resolve its organization. The
// switcher reads the avatar fields, canSendInvitations only reads owner-id
// and the permission rules.
export interface TeamOrganization {
  id: string;
  name?: string;
  slug?: string | null;
  "owner-id"?: string;
  permissions?: Record<string, string> | null;
  "default-team-id"?: string | null;
  // The backend resolves the organization logo to a public URI while
  // projecting the row, so the avatar renders it as-is.
  "custom-photo"?: string | null;
  "avatar-bg-url"?: string | null;
  "expired-license"?: boolean;
  "sso-active"?: boolean;
}

export interface TeamWithOrganization extends Team {
  organization?: TeamOrganization | null;
}

// --- Permissions -----------------------------------------------------------

// can-send-invitations? in common/src/app/common/types/organization.cljc:
// with the admin-console flag and an organization, the organization rules
// decide (the :send-invitations default is "ownersAndAdmins", normalized over
// the stored permissions); otherwise the team-level flags are the fallback.
export function canSendInvitations(
  team: TeamWithOrganization | null | undefined,
  // profile-id joins the CLJS call because allowed? compares it with the
  // organization owner; the shell keeps the argument for the contract, but
  // with the admin-console flag off it takes no part in the fallback.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  profileId: string | null | undefined,
): boolean {
  const permissions = team?.permissions;
  const organization = team?.organization;
  if (hasFlag("admin-console") && organization !== null && organization !== undefined) {
    const rules: Record<string, string> = {
      "send-invitations": "ownersAndAdmins",
      ...(organization.permissions ?? {}),
    };
    const value = rules["send-invitations"];
    if (value === "ownersAndAdmins") {
      return permissions?.["is-owner"] === true || permissions?.["is-admin"] === true;
    }
    if (value === "owners") return permissions?.["is-owner"] === true;
    return false;
  }
  return permissions?.["is-owner"] === true || permissions?.["is-admin"] === true;
}

// --- Roles -----------------------------------------------------------------

export interface RoleOption {
  value: TeamRole;
  label: string;
}

// get-available-roles in team.cljs: viewer and editor for everyone, admin only
// for a team admin. The labels are spelled out as literals so
// scripts/extract-translations.mjs can see the keys.
export function availableRoles(team: Team | null | undefined): RoleOption[] {
  const roles: RoleOption[] = [
    { value: "viewer", label: tr("labels.viewer") },
    { value: "editor", label: tr("labels.editor") },
  ];
  if (team?.permissions?.["is-admin"] === true) {
    roles.push({ value: "admin", label: tr("labels.admin") });
  }
  return roles;
}

// The role label cond shared by rol-info*, the invitation rows and the
// invitation modal; anything unknown renders as viewer, like the :else branch.
export function roleLabel(role: TeamRole | string | null | undefined): string {
  if (role === "owner") return tr("labels.owner");
  if (role === "admin") return tr("labels.admin");
  if (role === "editor") return tr("labels.editor");
  return tr("labels.viewer");
}

// The exclusive role of a member row: owner, then admin, then editor (the
// can-edit relation flag), viewer otherwise (rol-info*).
export function memberRole(member: TeamMember): TeamRole {
  if (member["is-owner"] === true) return "owner";
  if (member["is-admin"] === true) return "admin";
  if (member["can-edit"] === true) return "editor";
  return "viewer";
}

// The condition that turns the role cell into a dropdown (rol-info*):
// (and can-change-rol not-superior (not (and is-you is-owner))). Both
// not-superior branches reduce to "the member is not the owner", so the whole
// condition is "team owner or admin, looking at a non-owner member".
export function canChangeMemberRole(
  team: Team | null | undefined,
  member: TeamMember,
  viewerId: string | null | undefined,
): boolean {
  const permissions = team?.permissions;
  const isTeamOwner = permissions?.["is-owner"] === true;
  const isTeamAdmin = permissions?.["is-admin"] === true;
  const canChangeRole = isTeamOwner || isTeamAdmin;
  const memberIsOwner = member["is-owner"] === true;
  const isYou = viewerId !== null && viewerId !== undefined && viewerId === member.id;
  return canChangeRole && !memberIsOwner && !(isYou && memberIsOwner);
}

// The '...' trigger of member-actions*:
// (or is-you? (and can-delete? (not (and is-owner? (not owner?)))))
// where can-delete? is the team owner or admin flag.
export function showMemberMenu(
  team: Team | null | undefined,
  member: TeamMember,
  viewerId: string | null | undefined,
): boolean {
  const permissions = team?.permissions;
  const teamOwner = permissions?.["is-owner"] === true;
  const canDelete = teamOwner || permissions?.["is-admin"] === true;
  const isOwnerMember = member["is-owner"] === true;
  const isYou = viewerId !== null && viewerId !== undefined && viewerId === member.id;
  return isYou || (canDelete && !(isOwnerMember && !teamOwner));
}

// The :is-you-option entry ("Leave team") shows on the viewer's own row.
export function canLeaveFromMenu(
  member: TeamMember,
  viewerId: string | null | undefined,
): boolean {
  return viewerId !== null && viewerId !== undefined && viewerId === member.id;
}

// The :is-not-you-option entry ("Remove member"):
// (and can-delete? (not is-you?) (not (and is-owner? (not owner?)))).
export function canRemoveFromMenu(
  team: Team | null | undefined,
  member: TeamMember,
  viewerId: string | null | undefined,
): boolean {
  const permissions = team?.permissions;
  const teamOwner = permissions?.["is-owner"] === true;
  const canDelete = teamOwner || permissions?.["is-admin"] === true;
  const isOwnerMember = member["is-owner"] === true;
  const isYou = viewerId !== null && viewerId !== undefined && viewerId === member.id;
  return canDelete && !isYou && !(isOwnerMember && !teamOwner);
}

// --- Members list ----------------------------------------------------------

function toMs(value: InstantValue | null | undefined): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }
  if (typeof value === "string" && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

// team-members*: the owner first, then everyone else sorted by created-at
// ascending. A list without an owner row (defensive) renders sorted.
export function orderedMembers(members: Iterable<TeamMember>): TeamMember[] {
  const others: TeamMember[] = [];
  let owner: TeamMember | null = null;
  for (const member of members) {
    if (member["is-owner"] === true && owner === null) owner = member;
    else others.push(member);
  }
  others.sort((a, b) => toMs(a["created-at"]) - toMs(b["created-at"]));
  return owner === null ? others : [owner, ...others];
}

// member-info*: the row is "you" when the profile id matches.
export function isYou(member: TeamMember, viewerId: string | null | undefined): boolean {
  return viewerId !== null && viewerId !== undefined && viewerId === member.id;
}

// --- Invitations list ------------------------------------------------------

export type InvitationSortField = "role" | "status";
export type SortDirection = "asc" | "desc";

export interface InvitationSortState {
  field: InvitationSortField | null;
  direction: SortDirection;
}

// on-order-by-*: clicking the active column flips its direction, clicking the
// other one starts ascending.
export function nextSortState(
  current: InvitationSortState,
  field: InvitationSortField,
): InvitationSortState {
  const direction: SortDirection =
    current.field === field && current.direction === "asc" ? "desc" : "asc";
  return { field, direction };
}

// sort-by of (juxt :expired :email) / (juxt :role :email), reversed for
// descending. Clojure compare on keywords follows the name order, which is
// the same lexicographic order the strings carry; expired sorts before
// pending because false < true.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortedInvitations(
  rows: Iterable<TeamInvitation>,
  state: InvitationSortState,
): TeamInvitation[] {
  const list = [...rows];
  if (state.field === null) return list;
  if (state.field === "status") {
    list.sort((a, b) => {
      const byExpired = (a.expired === true ? 1 : 0) - (b.expired === true ? 1 : 0);
      return byExpired !== 0 ? byExpired : compareStrings(a.email, b.email);
    });
  } else {
    list.sort((a, b) => {
      const byRole = compareStrings(String(a.role ?? ""), String(b.role ?? ""));
      return byRole !== 0 ? byRole : compareStrings(a.email, b.email);
    });
  }
  if (state.direction === "desc") list.reverse();
  return list;
}

// invitation-row*: the badge state of an invitation.
export function invitationStatus(invitation: TeamInvitation): "expired" | "pending" {
  return invitation.expired === true ? "expired" : "pending";
}

// The selected-invitations memo of invitation-section*: the full rows behind
// the checked emails, in list order.
export function selectedInvitations(
  rows: Iterable<TeamInvitation>,
  selected: ReadonlySet<string>,
): TeamInvitation[] {
  return [...rows].filter((row) => selected.has(row.email));
}

// --- Webhooks --------------------------------------------------------------

// can-edit in webhook-item*: an edit permission on the team, or the profile
// that created the hook.
export function canEditWebhook(
  webhook: Webhook,
  team: Team | null | undefined,
  profileId: string | null | undefined,
): boolean {
  return (
    team?.permissions?.["can-edit"] === true ||
    (profileId !== null && profileId !== undefined && webhook["profile-id"] === profileId)
  );
}

// extract-status: the value after the "unexpected-status:" prefix.
export function extractStatus(errorCode: string): string {
  const parts = errorCode.split(":");
  return (parts[1] ?? "").trim();
}

// translate-error-hint: the :webhook-validation hint classes raised by
// validate-webhook! in backend/src/app/rpc/commands/webhooks.clj.
export function translateErrorHint(hint: string | null | undefined): string {
  if (hint === "invalid-uri") return tr("errors.webhooks.invalid-uri");
  if (hint === "ssl-validation-error") return tr("errors.webhooks.ssl-validation");
  if (hint === "timeout") return tr("errors.webhooks.timeout");
  if (hint === "connection-error") return tr("errors.webhooks.connection");
  if (typeof hint === "string" && hint.startsWith("unexpected-status")) {
    return tr("errors.webhooks.unexpected-status", extractStatus(hint));
  }
  if (typeof hint === "string" && hint.startsWith("blocked-request")) {
    return tr("errors.webhooks.connection");
  }
  return tr("errors.webhooks.unexpected");
}

// last-delivery-text in webhook-item*: the tooltip of the status icon. The
// ssl class is an exact match in the CLJS original, unlike the prefix match
// of unexpected-status.
export function webhookLastDeliveryText(webhook: Webhook): string {
  const errorCode = webhook["error-code"];
  if (errorCode === null || errorCode === undefined) {
    return tr("webhooks.last-delivery.success");
  }
  const suffix = errorCode === "ssl-validation-error"
    ? tr("errors.webhooks.ssl-validation")
    : errorCode.startsWith("unexpected-status")
      ? tr("errors.webhooks.unexpected-status", extractStatus(errorCode))
      : tr("errors.webhooks.unexpected");
  return tr("errors.webhooks.last-delivery") + " " + suffix;
}

// --- Invitation link -------------------------------------------------------

// copy-invitation-link (app.main.data.team) builds the URL with
// rt/resolve-uri :auth-verify-token, which is cf/public-uri plus the
// ?screen=... query string u/map->query-string produces, and the backend's
// get-team-invitation-token answers with just {:token ...}
// (backend/src/app/rpc/commands/teams_invitations.clj), so the URL carries
// the token and nothing else.
export function invitationUrl(publicUri: string, token: string): string {
  const query = new URLSearchParams({ screen: "auth-verify-token", token });
  return publicUri + "?" + query.toString();
}

// --- Team photo ------------------------------------------------------------

// resolve-team-photo-url in app.config: a stored photo is served from
// assets/by-id, otherwise the caller falls back to generateAvatar({name}).
export function teamPhotoUrl(
  team: { "photo-id"?: string | null } | null | undefined,
  publicUri: string,
): string | null {
  const photoId = team?.["photo-id"];
  if (photoId === undefined || photoId === null || photoId === "") return null;
  const base = publicUri.endsWith("/") ? publicUri : publicUri + "/";
  return base + "assets/by-id/" + photoId;
}

// --- Team hero banner ------------------------------------------------------

// The dismissed flag of the team-hero banner (projects-section*): stored in
// the "penpot-global" storage under the namespace of that view, transit
// encoded like every other entry, so a CLJS tab on the same origin agrees.
export const TEAM_HERO_STORAGE_NS = "app.main.ui.dashboard.projects";
export const TEAM_HERO_STORAGE_KEY = "show-team-hero";

export function readTeamHeroVisible(): boolean {
  const value = globalStorage.get<unknown>(TEAM_HERO_STORAGE_NS, TEAM_HERO_STORAGE_KEY);
  return typeof value === "boolean" ? value : true;
}

export function writeTeamHeroVisible(visible: boolean): void {
  globalStorage.set(TEAM_HERO_STORAGE_NS, TEAM_HERO_STORAGE_KEY, visible);
}

// --- Commands --------------------------------------------------------------

// fetch-members: the caller treats a :not-found team as an empty list, like
// the (log/warn ...) + (rx/empty) branch of the CLJS event.
export function getTeamMembers(teamId: string): Promise<TeamMember[]> {
  const params: RpcParams["get-team-members"] = { "team-id": teamId };
  return cmd<TeamMember[]>("get-team-members", params);
}

export function getTeamInvitations(teamId: string): Promise<TeamInvitation[]> {
  const params: RpcParams["get-team-invitations"] = { "team-id": teamId };
  return cmd<TeamInvitation[]>("get-team-invitations", params);
}

export function getTeamStats(teamId: string): Promise<TeamStats> {
  const params: RpcParams["get-team-stats"] = { "team-id": teamId };
  return cmd<TeamStats>("get-team-stats", params);
}

export function getWebhooks(teamId: string): Promise<Webhook[]> {
  const params: RpcParams["get-webhooks"] = { "team-id": teamId };
  return cmd<Webhook[]>("get-webhooks", params);
}

// update-member-role: the backend schema wants :role as a keyword, so the
// string role goes on the wire through keyword(). The command answers 204 and
// callers refresh the members list and the teams (the profile permissions can
// change with the role).
export function updateMemberRole(
  teamId: string,
  memberId: string,
  role: TeamRole,
): Promise<unknown> {
  const params = {
    "team-id": teamId,
    "member-id": memberId,
    role: keyword(role),
  } as unknown as RpcParams["update-team-member-role"];
  return cmd("update-team-member-role", params);
}

export function deleteMember(teamId: string, memberId: string): Promise<unknown> {
  const params: RpcParams["delete-team-member"] = { "team-id": teamId, "member-id": memberId };
  return cmd("delete-team-member", params);
}

// leave-current-team: :reassign-to only travels when the leaver picks a new
// owner (the leave-and-reassign modal).
export function leaveTeam(teamId: string, reassignTo?: string | null): Promise<unknown> {
  const params: RpcParams["leave-team"] = { id: teamId };
  if (reassignTo !== null && reassignTo !== undefined) params["reassign-to"] = reassignTo;
  return cmd("leave-team", params);
}

export function deleteTeam(teamId: string): Promise<unknown> {
  const params: RpcParams["delete-team"] = { id: teamId };
  return cmd("delete-team", params);
}

// create-team: features is the enabled-features set of the build; the caller
// supplies it (fileFeatures style) so this module stays config-free.
export function createTeam(
  name: string,
  features: string[],
  organizationId?: string | null,
): Promise<Team> {
  const params: RpcParams["create-team"] = { name, features };
  if (organizationId !== null && organizationId !== undefined) {
    params["organization-id"] = organizationId;
  }
  return cmd<Team>("create-team", params);
}

export function updateTeam(id: string, name: string): Promise<unknown> {
  const params: RpcParams["update-team"] = { id, name };
  return cmd("update-team", params);
}

// update-team-photo is one of the four multipart commands (cmdUpload); the
// CLJS event validates the blob first (di/validate-file) and the backend
// re-validates against the media schema.
export function updateTeamPhoto(teamId: string, file: Blob): Promise<unknown> {
  return cmdUpload("update-team-photo", { "team-id": teamId, file });
}

export interface CreateInvitationsParams {
  teamId: string;
  // Format 1 of create-invitations: one role for every email, sent as a
  // transit set (schema [::sm/set {:min 1} ::sm/email]).
  emails?: Iterable<string>;
  role?: TeamRole;
  // Format 2: individual roles per email (the resend flow sends the selected
  // invitation rows through this shape).
  invitations?: ReadonlyArray<{ email: string; role: TeamRole | string }>;
  resend?: boolean;
}

export function createInvitations(params: CreateInvitationsParams): Promise<unknown> {
  const wire: Record<string, unknown> = { "team-id": params.teamId };
  if (params.invitations !== undefined) {
    wire.invitations = params.invitations.map((row) => ({
      email: row.email,
      role: keyword(row.role),
    }));
  } else if (params.emails !== undefined && params.role !== undefined) {
    wire.emails = transitSet(params.emails);
    wire.role = keyword(params.role);
  } else {
    // The CLJS event's schema refuses a params map with neither format.
    throw new Error("create-invitations needs emails+role or invitations");
  }
  if (params.resend !== undefined) wire["resend?"] = params.resend;
  return cmd("create-team-invitations", wire as unknown as RpcParams["create-team-invitations"]);
}

export function updateInvitationRole(
  teamId: string,
  email: string,
  role: TeamRole | string,
): Promise<unknown> {
  const params = {
    "team-id": teamId,
    email,
    role: keyword(role),
  } as unknown as RpcParams["update-team-invitation-role"];
  return cmd("update-team-invitation-role", params);
}

export function deleteInvitation(teamId: string, email: string): Promise<unknown> {
  const params: RpcParams["delete-team-invitation"] = { "team-id": teamId, email };
  return cmd("delete-team-invitation", params);
}

export interface TeamInvitationToken {
  token: string;
}

export function getTeamInvitationToken(
  teamId: string,
  email: string,
): Promise<TeamInvitationToken> {
  const params: RpcParams["get-team-invitation-token"] = { "team-id": teamId, email };
  return cmd<TeamInvitationToken>("get-team-invitation-token", params);
}

// The reusable copy-link step of invitation-actions*: fetch the token, build
// the verify-token URL and hand it to the clipboard. Returns the URL so the
// caller can surface errors itself.
export async function copyInvitationLink(teamId: string, email: string): Promise<string> {
  const { token } = await getTeamInvitationToken(teamId, email);
  const url = invitationUrl(config.publicUri, token);
  await navigator.clipboard.writeText(url);
  return url;
}

// create-webhook: the backend schema lists team-id, uri and mtype, but the
// command reads :is-active from the params map regardless (insert-webhook! in
// webhooks.clj); the CLJS modal always sends it, so the shell does too and
// casts around the generated type gap.
export function createWebhook(
  teamId: string,
  uri: string,
  mtype: WebhookMtype,
  isActive: boolean,
): Promise<unknown> {
  const params = {
    "team-id": teamId,
    uri,
    mtype,
    "is-active": isActive,
  } as unknown as RpcParams["create-webhook"];
  return cmd("create-webhook", params);
}

export function updateWebhook(
  id: string,
  uri: string,
  mtype: WebhookMtype,
  isActive: boolean,
): Promise<unknown> {
  const params: RpcParams["update-webhook"] = {
    id,
    uri,
    mtype,
    "is-active": isActive,
  };
  return cmd("update-webhook", params);
}

// delete-webhook: the CLJS event attaches :team-id from the store, but the
// backend schema and lookup only need the webhook id.
export function deleteWebhook(id: string): Promise<unknown> {
  const params: RpcParams["delete-webhook"] = { id };
  return cmd("delete-webhook", params);
}

// --- Global features ---------------------------------------------------------

// features/global-enabled-features (app.main.features) over get-enabled-features
// (common/src/app/common/features.cljc): default-features unioned with the
// flag->feature translations. create-team sends this set, the same way the CLJS
// event does (dtm/create-team).
const GLOBAL_DEFAULT_FEATURES: readonly string[] = [
  "fdata/shape-data-type",
  "fdata/path-data",
  "styles/v2",
  "layout/grid",
  "components/v2",
  "plugins/runtime",
  "design-tokens/v1",
  "tokens/numeric-input",
  "variants/v1",
];

const FLAG_FEATURES: ReadonlyArray<readonly [string, string]> = [
  ["feature-styles-v2", "styles/v2"],
  ["feature-fdata-objects-map", "fdata/objects-map"],
  ["feature-fdata-pointer-map", "fdata/pointer-map"],
  ["feature-plugins", "plugins/runtime"],
  ["feature-design-tokens", "design-tokens/v1"],
  ["feature-text-editor-v2", "text-editor/v2"],
  ["feature-text-editor-v2-html-paste", "text-editor/v2-html-paste"],
  ["feature-text-editor-wasm", "text-editor-wasm/v1"],
  ["feature-render-wasm", "render-wasm/v1"],
  ["feature-variants", "variants/v1"],
  ["feature-token-input", "tokens/numeric-input"],
];

export function globalEnabledFeatures(): string[] {
  const features = new Set(GLOBAL_DEFAULT_FEATURES);
  for (const [flag, feature] of FLAG_FEATURES) {
    if (hasFlag(flag)) features.add(feature);
  }
  return [...features];
}

// --- Refreshed-team step ---------------------------------------------------

export interface RefreshTeamResult {
  // null when get-teams no longer carries the team (it was deleted in
  // another tab); the CLJS callback runs with a nil team in the same case.
  team: TeamWithOrganization | null;
  canInvite: boolean;
}

// with-refreshed-team (app.main.data.team): invitation flows never trust the
// stored team row. They run (rp/cmd! :get-teams), seek the id and use that
// row, both to refresh the caller's teams list and to run the permission
// decision on fresh data. The admin-console organization branches are F5.7;
// the fallback (team-level owner/admin) is what canSendInvitations computes.
export async function refreshTeamPermissions(
  teamId: string,
  profileId: string | null | undefined,
): Promise<RefreshTeamResult> {
  const teams = (await getTeams()) as TeamWithOrganization[];
  const team = teams.find((row) => row.id === teamId) ?? null;
  return {
    team,
    canInvite: team !== null && canSendInvitations(team, profileId),
  };
}

// --- Team form -------------------------------------------------------------

// The success toast team_form.cljs shows for both create and update; a
// literal because the catalog has no entry for it.
export const TEAM_FORM_SUCCESS_MESSAGE = "Team created successfully";

// on-error in team_form.cljs: :not-allowed opens the no-permission modal, a
// request that carried an id is an update, everything else is a create.
export function teamFormErrorMessage(hasId: boolean): string {
  return hasId ? "Error on updating team." : "Error on creating team.";
}
