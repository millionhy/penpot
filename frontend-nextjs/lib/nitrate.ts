// Nitrate (admin console) helpers (F5.7a). Headless port of the slice of
// app.main.data.nitrate that the organization/team switcher, its
// leave-organization flow and the create-organization action need: the
// admin-console URL builders, the licence check, the organization team and
// leave derivations, the leave-organization command with its summary-driven
// modal decision, and the leave error mapping.
//
// Kept free of JSX so it runs in vitest's node environment, like lib/team.ts
// and lib/org-switch.ts; the views live in components/org-team-switch.tsx
// and components/org-leave-flows.tsx.
//
// Deviations from the CLJS original, documented:
// - The nitrate-audit events (delete-organization-member-event) are
//   telemetry; the shell does not send them.
// - The rt/nav-raw :href events become href strings and the caller
//   navigates: an admin-console target leaves the SPA, so the caller assigns
//   window.location instead of pushing a route.
// - build-admin-console-href percent-encodes the slug and the id the way the
//   CLJS does, with lambdaisland's one-arity percent-encode: every UTF-8 byte
//   is encoded, letters included ("my-org" -> "%6D%79%2D%6F%72%67"). The port
//   keeps that byte-for-byte so deep links match.

import { config, hasFlag } from "@/lib/config";
import type { InstantValue } from "@/lib/dashboard";
import { tr } from "@/lib/i18n";
import { cmd } from "@/lib/rpc";
import type { TeamWithOrganization } from "@/lib/team";
import type { RpcParams } from "@/lib/types";

// --- Admin console URLs ------------------------------------------------------

// Values may be absent; the CLJS map->query-string drops nil values, so the
// port drops null and undefined too.
export interface AdminConsoleQueryParams {
  [key: string]: string | null | undefined;
}

export interface AdminConsoleOrganization {
  organizationId?: string | null;
  organizationSlug?: string | null;
}

// Port of lambdaisland.uri (parse / join / uri-str) limited to what the
// admin-console URLs need: scheme, authority, path and query. Fragments are
// not part of either builder and are dropped; user, password and port stay
// inside the authority string untouched.
interface ParsedUri {
  scheme: string | null;
  authority: string | null;
  path: string | null;
  query: string | null;
}

const uriRe = /^(([^:/?#]+):)?(\/\/([^/?#\\]*))?([^?#]*)?(\?([^#]*))?(#(.*))?$/;

function parseUri(input: string): ParsedUri {
  const match = uriRe.exec(input);
  if (match === null) {
    return { scheme: null, authority: null, path: null, query: null };
  }
  const scheme = match[2] ?? null;
  const authority = match[4] ?? null;
  const rawPath = match[5] ?? "";
  // (when (seq path) path): an empty path is no path at all.
  const path = rawPath.length > 0 ? rawPath : null;
  const query = match[7] ?? null;
  return { scheme, authority, path, query };
}

// RFC 3986 section 5.2.4, port of remove-dot-segments.
function removeDotSegments(path: string | null): string | null {
  if (path === null) return null;
  const segments = path.split(/(?=\/)/);
  const out: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === "/.") {
      if (i + 1 < segments.length) continue;
      out.push("/");
    } else if (segment === "/..") {
      if (i + 1 < segments.length) {
        out.pop();
      } else {
        out.pop();
        out.push("/");
      }
    } else {
      out.push(segment);
    }
  }
  return out.join("");
}

// merge-paths: replace the last path segment of `base` with `ref`, or treat
// `ref` as rooted when `base` has no path yet.
function mergePaths(base: string | null, ref: string): string {
  if (base !== null && base.includes("/")) {
    const cut = base.lastIndexOf("/");
    return base.slice(0, cut + 1) + ref;
  }
  if (ref.startsWith("/")) return ref;
  return "/" + ref;
}

function joinUriRef(base: ParsedUri, ref: ParsedUri): ParsedUri {
  if (ref.scheme !== null) {
    return { ...ref, path: removeDotSegments(ref.path) };
  }
  if (ref.authority !== null) {
    // join* with a host on the ref only takes the base scheme (path stays
    // untouched, unlike the relative-path branch below).
    return {
      scheme: base.scheme,
      authority: ref.authority,
      path: ref.path,
      query: ref.query,
    };
  }
  if (ref.path === null) {
    return { ...base, query: ref.query ?? base.query };
  }
  const path = ref.path.startsWith("/") ? ref.path : mergePaths(base.path, ref.path);
  return {
    scheme: base.scheme,
    authority: base.authority,
    path: removeDotSegments(path),
    query: ref.query,
  };
}

function uriToString(uri: ParsedUri): string {
  let out = "";
  if (uri.scheme !== null) out += uri.scheme + ":";
  if (uri.authority !== null) out += "//" + uri.authority;
  out += uri.path ?? "";
  // uri-str checks `query` for truth; an empty string still renders the "?".
  if (uri.query !== null) out += "?" + uri.query;
  return out;
}

// (u/join base & refs) over a base plus relative segments.
function joinUri(base: string, ...refs: string[]): string {
  let current = parseUri(base);
  for (const ref of refs) {
    current = joinUriRef(current, parseUri(ref));
  }
  return uriToString(current);
}

// lambdaisland's one-arity percent-encode: every byte of the UTF-8 encoding
// becomes %XX, uppercase hex (see byte->hex in lambdaisland.uri.platform).
function percentEncodeAll(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const byte of bytes) {
    out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

// (query-encode): keep a-zA-Z0-9-._~@/ , encode a space as "+" and everything
// else per byte. char-seq is code-point aware; the for..of loop matches it.
const querySafeRe = /[a-zA-Z0-9\-._~@/]/;

function queryEncode(value: string): string {
  let out = "";
  for (const char of value) {
    if (char === " ") out += "+";
    else if (querySafeRe.test(char)) out += char;
    else out += percentEncodeAll(char);
  }
  return out;
}

function mapToQueryString(params: AdminConsoleQueryParams): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    pairs.push(queryEncode(key) + "=" + queryEncode(value));
  }
  return pairs.join("&");
}

// build-admin-console-url: publicUri joined with "admin-console/" and `path`,
// plus an optional query string. The CLJS cond-> assoces :query whenever the
// map is non-empty, and uri-str renders the "?" for an empty query too, so an
// all-nil map still ends in a bare "?".
export function buildAdminConsoleUrl(
  path: string,
  queryParams: AdminConsoleQueryParams | null = null,
  publicUri: string = config.publicUri,
): string {
  let url = joinUri(publicUri, "admin-console/", path);
  if (queryParams !== null && Object.keys(queryParams).length > 0) {
    url += "?" + mapToQueryString(queryParams);
  }
  return url;
}

// build-admin-console-href: the organization page when both the id and the
// slug are set, the generic admin-console root otherwise.
export function buildAdminConsoleHref(organization?: AdminConsoleOrganization | null): string {
  const organizationId = organization?.organizationId;
  const organizationSlug = organization?.organizationSlug;
  if (organizationId && organizationSlug) {
    const path =
      "organization/" +
      percentEncodeAll(organizationSlug) +
      "/" +
      percentEncodeAll(organizationId) +
      "/people/";
    return buildAdminConsoleUrl(path);
  }
  return buildAdminConsoleUrl("");
}

// go-to-nitrate-ac-create-organization: the create-organization entry of the
// admin console, tagged with the origin the switcher reports.
export function adminConsoleCreateOrganizationHref(origin: string): string {
  return buildAdminConsoleUrl("", { action: "create-organization", origin });
}

// --- Licence check -----------------------------------------------------------

// The shape with-nitrate-licence (backend profile.clj / nitrate.clj) adds to
// the profile under the :admin-console flag; the generated Profile type does
// not carry it because it depends on runtime flags.
export interface LicensedProfile {
  subscription?: { status?: string | null } | null;
}

const validLicenseStatuses: readonly string[] = ["active", "past_due", "trialing"];

// is-valid-license?: only meaningful when the admin console exists at all.
export function isValidLicense(profile: LicensedProfile | null | undefined): boolean {
  if (!hasFlag("admin-console")) return false;
  const status = profile?.subscription?.status;
  return typeof status === "string" && validLicenseStatuses.includes(status);
}

// --- Organization team slices ------------------------------------------------

// organization-teams: the teams of one organization out of the full list.
export function organizationTeams(
  teams: ReadonlyArray<TeamWithOrganization>,
  organizationId: string,
): TeamWithOrganization[] {
  return teams.filter((team) => team.organization?.id === organizationId);
}

export interface OrganizationLeaveInfo {
  defaultTeamId: string | undefined;
  notOwnedTeams: TeamWithOrganization[];
}

// organization-leave-info: the default team id and the not-owned teams of an
// organization. Owned teams come from ::get-leave-organization-summary.
export function organizationLeaveInfo(
  organizationTeamRows: ReadonlyArray<TeamWithOrganization>,
): OrganizationLeaveInfo {
  const defaultTeam = organizationTeamRows.find((team) => team["is-default"] === true);
  return {
    defaultTeamId: defaultTeam?.id,
    notOwnedTeams: organizationTeamRows.filter(
      (team) => team["is-default"] !== true && team.permissions?.["is-owner"] !== true,
    ),
  };
}

// --- Leave error mapping -----------------------------------------------------

// team-leave-message: the error codes the team-leave flows share. Returns
// null when the code is not mapped, which the CLJS turns into an rx/throw.
function teamLeaveMessage(code: string | undefined): string | null {
  switch (code) {
    case "only-owner-can-delete-team":
      return tr("errors.team-leave.only-owner-can-delete");
    case "no-enough-members-for-leave":
      return tr("errors.team-leave.insufficient-members");
    case "member-does-not-exist":
      return tr("errors.team-leave.member-does-not-exists");
    case "owner-cant-leave-team":
      return tr("errors.team-leave.owner-cant-leave");
    default:
      return null;
  }
}

// team-leave-on-error: the message to toast, or null for the generic
// fallback the caller resolves itself.
export function teamLeaveErrorMessage(code: string | undefined): string | null {
  return teamLeaveMessage(code);
}

// org-leave-on-error: the team-leave codes plus the two organization ones.
export function orgLeaveErrorMessage(code: string | undefined): string | null {
  const shared = teamLeaveMessage(code);
  if (shared !== null) return shared;
  switch (code) {
    case "not-valid-teams":
      return tr("errors.organization-leave.no-valid-teams");
    case "organization-owner-cannot-leave":
      return tr("errors.organization-leave.organization-owner-cannot-leave");
    default:
      return null;
  }
}

// --- Leave-organization command ----------------------------------------------

export type LeaveOrganizationParams = RpcParams["leave-organization"];

export function leaveOrganization(params: LeaveOrganizationParams): Promise<unknown> {
  return cmd("leave-organization", params);
}

export interface LeaveOrganizationTransferableTeam {
  id: string;
  name: string;
  members?: Array<{ id: string; name?: string; email?: string; "is-admin"?: boolean }>;
}

// schema:get-leave-organization-summary-result (backend nitrate.clj).
export interface LeaveOrganizationSummary {
  "teams-to-delete": number;
  "teams-to-transfer": number;
  "teams-to-exit": number;
  "teams-to-detach": number;
  "team-ids-to-delete": string[];
  "transferable-teams": LeaveOrganizationTransferableTeam[];
  "member-added-at"?: InstantValue | null;
  "organization-member-count-before": number;
}

export function getLeaveOrganizationSummary(
  id: string,
  defaultTeamId: string,
): Promise<LeaveOrganizationSummary> {
  const params: RpcParams["get-leave-organization-summary"] = {
    id,
    "default-team-id": defaultTeamId,
  };
  return cmd("get-leave-organization-summary", params);
}

// leave-organization-fn: fold the transferred teams into teams-to-leave. The
// CLJS cond->> threads the not-owned teams into (:always (map select-keys
// [:id])) and then into (concat teams-to-transfer ...), so the wire order is
// the transfer entries first, the not-owned ids after; the backend checks the
// set of ids, not the order, and the transfer entries keep their :reassign-to.
export function buildTeamsToLeave(
  notOwnedTeams: ReadonlyArray<{ id: string }>,
  teamsToTransfer: ReadonlyArray<{ id: string; "reassign-to"?: string }>,
): Array<{ id: string; "reassign-to"?: string }> {
  const base = notOwnedTeams.map((team) => ({ id: team.id }));
  return teamsToTransfer.length > 0 ? [...teamsToTransfer, ...base] : base;
}

// show-leave-organization-modal: which modal the summary asks for.
export type LeaveOrganizationModalKind = "reassign" | "warning" | "confirm";

export function leaveOrganizationModalKind(
  summary: LeaveOrganizationSummary,
): LeaveOrganizationModalKind {
  if (summary["teams-to-transfer"] > 0) return "reassign";
  if (
    summary["teams-to-delete"] > 0 ||
    summary["teams-to-exit"] > 0 ||
    summary["teams-to-detach"] > 0
  ) {
    return "warning";
  }
  return "confirm";
}
