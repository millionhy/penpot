// Dashboard route group logic (F5.1). Headless port of the team and project
// slice of app.main.data.team and app.main.data.dashboard, plus the derived
// selections the app.main.ui.dashboard.* views compute inline.
//
// Kept free of JSX so it runs in vitest's node environment, like lib/forms.ts
// and lib/settings.ts. The views live in app/dashboard/* and
// components/dashboard-*.tsx.

import { cmd } from "@/lib/rpc";
import type { RouteName } from "@/lib/routes";
import { routePaths } from "@/lib/routes";
import { globalStorage } from "@/lib/storage";
import type { RpcParams } from "@/lib/types";

// --- Row shapes ------------------------------------------------------------
//
// packages/api-types recovered result types for only part of the RPC surface,
// and get-teams / get-projects / get-team-recent-files are not in it. The
// fields the dashboard reads are declared here against the backend rows:
// backend/src/app/rpc/commands/teams.clj, projects.clj and the
// sql:team-recent-files query in files.clj.

// Transit decodes instants as Dates (the "~m" read handler in lib/transit.ts),
// while hand-written fixtures and JSON sources produce ISO strings, so the row
// types accept both.
export type InstantValue = string | Date;

export interface TeamPermissions {
  "can-edit"?: boolean;
  "can-manage-members"?: boolean;
  "can-create-project"?: boolean;
  "is-owner"?: boolean;
  "is-admin"?: boolean;
}

export interface Team {
  id: string;
  name: string;
  "is-default"?: boolean;
  "organization-id"?: string | null;
  "organization-name"?: string | null;
  permissions?: TeamPermissions;
  features?: string[];
}

export interface Project {
  id: string;
  name: string;
  "team-id": string;
  "is-default"?: boolean;
  "is-pinned"?: boolean;
  "deleted-at"?: InstantValue | null;
  "modified-at"?: InstantValue | null;
  "created-at"?: InstantValue | null;
  // get-projects answers with the live file count; project-item* uses it to
  // tell "still loading" from "genuinely empty".
  count?: number;
}

export interface FileSummary {
  id: string;
  name: string;
  "project-id": string;
  revn?: number;
  vern?: number;
  "is-shared"?: boolean;
  "modified-at"?: InstantValue | null;
  "created-at"?: InstantValue | null;
  // file_thumbnail id joined by sql:team-recent-files. Turning it into an image
  // goes through the media worker (render-thumbnail in ui/dashboard/grid.cljs),
  // which arrives with the full grid in F5.2.
  "thumbnail-id"?: string | null;
}

// create-file answers with the whole file, data included, because
// on-file-created navigates straight to the first page.
export interface CreatedFile extends FileSummary {
  data?: { pages?: string[] } | null;
}

// --- Team resolution -------------------------------------------------------

// get-last-team-id in app.main.data.team: the last visited team id lives in the
// "penpot-global" local storage under the data.team namespace, written as an
// effect of team-initialized on every team switch.
export const TEAM_STORAGE_NS = "app.main.data.team";

export function readLastTeamId(): string | null {
  const value = globalStorage.get<unknown>(TEAM_STORAGE_NS, "current-team-id");
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function writeLastTeamId(teamId: string): void {
  globalStorage.set(TEAM_STORAGE_NS, "current-team-id", teamId);
}

// team-container* in app.main.ui.cljs renders nothing unless the route carries a
// real team id, and on-query-navigate resolves the post-login team with
// (if (contains? teams last-team-id) last-team-id default-team-id). The shell
// makes that explicit: the query param wins when it names one of our teams, then
// the last visited team, then the profile default. Falling back to the first
// team is a shell convenience, so a stale last-team-id cannot strand the user on
// a blank dashboard the way it would in CLJS.
export function resolveTeamId(input: {
  queryTeamId?: string | null;
  lastTeamId?: string | null;
  defaultTeamId?: string | null;
  teamIds?: readonly string[];
}): string | null {
  const ids = input.teamIds ?? [];
  const known = new Set(ids);
  const pick = (candidate?: string | null): string | null =>
    typeof candidate === "string" && known.has(candidate) ? candidate : null;
  return (
    pick(input.queryTeamId) ??
    pick(input.lastTeamId) ??
    pick(input.defaultTeamId) ??
    (ids.length > 0 ? ids[0] : null)
  );
}

// --- Derived selections ----------------------------------------------------

// The projects memo in dashboard*: only the projects of the current team.
export function projectsForTeam(
  projects: Iterable<Project>,
  teamId: string | null | undefined,
): Project[] {
  if (teamId === null || teamId === undefined) return [];
  const out: Project[] = [];
  for (const project of projects) {
    if (project["team-id"] === teamId) out.push(project);
  }
  return out;
}

function toMs(value: InstantValue | null | undefined): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === "string" && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function timeOf(value: InstantValue | null | undefined): number {
  return toMs(value) ?? 0;
}

function notDeleted(row: { "deleted-at"?: InstantValue | null }): boolean {
  return row["deleted-at"] === null || row["deleted-at"] === undefined;
}

// projects-section*: (remove :deleted-at) (sort-by :modified-at) (reverse).
export function visibleProjects(projects: Iterable<Project>): Project[] {
  return [...projects]
    .filter(notDeleted)
    .sort((a, b) => timeOf(b["modified-at"]) - timeOf(a["modified-at"]));
}

// The default-project memo in dashboard*: the first :is-default project, which
// is the drafts project the sidebar labels "Drafts".
export function defaultProject(projects: Iterable<Project>): Project | null {
  for (const project of projects) {
    if (project["is-default"] === true) return project;
  }
  return null;
}

// pinned-projects memo in sidebar-content*: not deleted, not the drafts
// project, pinned, sorted by name. An empty result renders the placeholder.
export function pinnedProjects(projects: Iterable<Project>): Project[] {
  return [...projects]
    .filter(
      (project) =>
        notDeleted(project) && project["is-default"] !== true && project["is-pinned"] === true,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The per-project file list in projects-section*: the recent files that belong
// to that project, newest first.
export function recentFilesOf(files: Iterable<FileSummary>, projectId: string): FileSummary[] {
  return [...files]
    .filter((file) => file["project-id"] === projectId)
    .sort((a, b) => timeOf(b["modified-at"]) - timeOf(a["modified-at"]));
}

// (:can-edit (:permissions team)): the gate for the new-file and new-project
// buttons, the deleted section and the templates section.
export function canEdit(team: Team | null | undefined): boolean {
  return team?.permissions?.["can-edit"] === true;
}

// drafts? in sidebar-content*: the files section while the selected project is
// the default one.
export function isDraftsSection(
  section: RouteName | null,
  currentProjectId: string | null | undefined,
  defaultProjectId: string | null | undefined,
): boolean {
  return (
    section === "dashboard-files" &&
    currentProjectId !== null &&
    currentProjectId !== undefined &&
    currentProjectId === defaultProjectId
  );
}

// show-templates? in dashboard-content*: flag plus edit permission.
export function showTemplates(flags: Iterable<string>, team: Team | null | undefined): boolean {
  return new Set(flags).has("dashboard-templates-section") && canEdit(team);
}

// The section fallback in dashboard-content*: without edit permission the
// deleted route is not reachable, so recent renders instead.
export function effectiveSection(
  section: RouteName,
  team: Team | null | undefined,
): RouteName {
  return section === "dashboard-deleted" && !canEdit(team) ? "dashboard-recent" : section;
}

// --- Navigation ------------------------------------------------------------

// The eleven dashboard routes, in the order app.main.ui.cljs lists them.
export const dashboardSections: readonly RouteName[] = [
  "dashboard-recent",
  "dashboard-files",
  "dashboard-libraries",
  "dashboard-fonts",
  "dashboard-font-providers",
  "dashboard-search",
  "dashboard-deleted",
  "dashboard-members",
  "dashboard-invitations",
  "dashboard-webhooks",
  "dashboard-settings",
];

// The CLJS router hands :section to the page; the App Router has to derive it
// from the pathname so the sidebar can highlight the active entry.
export function sectionFromPathname(pathname: string): RouteName | null {
  const normalized =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  for (const section of dashboardSections) {
    if (routePaths[section] === normalized) return section;
  }
  return null;
}

export interface DashboardNavParams {
  teamId?: string | null;
  projectId?: string | null;
  searchTerm?: string | null;
}

// Port of the go-to-dashboard-* events in app.main.data.common: every dashboard
// route carries the current team id and the files route also the project id.
// The shell builds hrefs instead of emitting events because the App Router owns
// navigation. A null value is dropped, matching (d/without-nils) in rt/nav.
export function dashboardHref(section: RouteName, params: DashboardNavParams = {}): string {
  const search = new URLSearchParams();
  if (params.teamId !== null && params.teamId !== undefined) search.set("team-id", params.teamId);
  if (params.projectId !== null && params.projectId !== undefined) {
    search.set("project-id", params.projectId);
  }
  if (params.searchTerm !== null && params.searchTerm !== undefined) {
    search.set("search-term", params.searchTerm);
  }
  const query = search.toString();
  return routePaths[section] + (query.length > 0 ? "?" + query : "");
}

// go-to-workspace in app.main.data.common: team-id, file-id and page-id travel
// as query params on the workspace route.
export function workspaceHref(params: {
  teamId?: string | null;
  fileId: string;
  pageId?: string | null;
}): string {
  const search = new URLSearchParams();
  if (params.teamId !== null && params.teamId !== undefined) search.set("team-id", params.teamId);
  search.set("file-id", params.fileId);
  if (params.pageId !== null && params.pageId !== undefined) search.set("page-id", params.pageId);
  return routePaths.workspace + "?" + search.toString();
}

// The first page of a freshly created file, for on-file-created.
export function firstPageId(file: CreatedFile | null | undefined): string | null {
  const pages = file?.data?.pages;
  return Array.isArray(pages) && pages.length > 0 ? pages[0] : null;
}

// --- Page titles -----------------------------------------------------------

// The title effect in projects-section*: (tr "title.dashboard.projects" tname),
// where tname is the personal-projects label for the default team and the team
// name for every other team.
export function projectsTitleName(team: Team | null | undefined, personalLabel: string): string {
  return team?.["is-default"] === true ? personalLabel : team?.name ?? "";
}

// --- Relative time ---------------------------------------------------------

// ct/timeago (app.common.time) is date-fns v4 formatDistanceToNowStrict with
// {includeSeconds true, addSuffix true}; v4 dropped includeSeconds, so the
// observable behaviour is the strict units below with the en-US suffix. The
// shell has no date-fns dependency and the catalog is English only, so the
// algorithm and the strings are reproduced here verbatim. `now` is injectable
// to keep the function headless and testable. Missing or invalid values answer
// null, the shell's `(when v ...)` equivalent; date-fns throws on them.

const MINUTES_IN_DAY = 1440;
const MINUTES_IN_MONTH = MINUTES_IN_DAY * (365.242 / 12);
const MINUTES_IN_YEAR = MINUTES_IN_DAY * 365.242;

// date-fns _lib/getTimezoneOffsetInMilliseconds: normalizes the day/month/year
// buckets across DST changes.
function timezoneOffsetMs(date: Date): number {
  const utc = new Date(
    Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
      date.getMilliseconds(),
    ),
  );
  utc.setUTCFullYear(date.getFullYear());
  return date.getTime() - utc.getTime();
}

type DistanceUnit = "second" | "minute" | "hour" | "day" | "month" | "year";

function distanceUnit(minutes: number, dstMinutes: number): DistanceUnit {
  if (minutes < 1) return "second";
  if (minutes < 60) return "minute";
  if (minutes < MINUTES_IN_DAY) return "hour";
  if (dstMinutes < MINUTES_IN_MONTH) return "day";
  if (dstMinutes < MINUTES_IN_YEAR) return "month";
  return "year";
}

// The en-US formatDistance tokens date-fns resolves: xSeconds, xMinutes,
// xHours, xDays, xMonths and xYears, each with its singular/plural form and
// the addSuffix wrapper ("X ago" / "in X").
function distanceWords(unit: DistanceUnit, value: number, future: boolean): string {
  const words: Record<DistanceUnit, [string, string]> = {
    second: ["1 second", "seconds"],
    minute: ["1 minute", "minutes"],
    hour: ["1 hour", "hours"],
    day: ["1 day", "days"],
    month: ["1 month", "months"],
    year: ["1 year", "years"],
  };
  const [one, other] = words[unit];
  const result = value === 1 ? one : value + " " + other;
  return future ? "in " + result : result + " ago";
}

export function timeAgo(
  value: InstantValue | null | undefined,
  now: Date = new Date(),
): string | null {
  const ms = toMs(value);
  const nowMs = now.getTime();
  if (ms === null || Number.isNaN(nowMs)) return null;
  const future = ms > nowMs;
  const earlier = future ? now : new Date(ms);
  const later = future ? new Date(ms) : now;
  const milliseconds = later.getTime() - earlier.getTime();
  const minutes = milliseconds / 60000;
  const dstMinutes =
    (milliseconds - (timezoneOffsetMs(later) - timezoneOffsetMs(earlier))) / 60000;
  const unit = distanceUnit(minutes, dstMinutes);
  let count: number;
  if (unit === "second") count = Math.round(milliseconds / 1000);
  else if (unit === "minute") count = Math.round(minutes);
  else if (unit === "hour") count = Math.round(minutes / 60);
  else if (unit === "day") count = Math.round(dstMinutes / MINUTES_IN_DAY);
  else if (unit === "month") {
    const months = Math.round(dstMinutes / MINUTES_IN_MONTH);
    // formatDistanceStrict folds a rounded 12 months into "1 year".
    if (months === 12) return distanceWords("year", 1, future);
    count = months;
  } else count = Math.round(dstMinutes / MINUTES_IN_YEAR);
  return distanceWords(unit, count, future);
}

// --- Unique names ------------------------------------------------------------

// cfh/get-used-names and cfh/generate-unique-name (app.common.files.helpers).
// The create-project and create-file events both pass :immediate-suffix? true,
// so the base name counts as taken and the first candidate is "<base> 1"; the
// default suffix-fn is (str " " copy-count).

export function usedNames(rows: Iterable<{ name?: string | null }>): Set<string> {
  const names = new Set<string>();
  for (const row of rows) {
    if (typeof row.name === "string") names.add(row.name);
  }
  return names;
}

export function generateUniqueName(
  baseName: string,
  existingNames: Iterable<string>,
  options: { immediateSuffix?: boolean } = {},
): string {
  const used = new Set(existingNames);
  if (options.immediateSuffix === true) used.add(baseName);
  if (!used.has(baseName)) return baseName;
  for (let count = 1; ; count += 1) {
    const candidate = baseName + " " + String(count);
    if (!used.has(candidate)) return candidate;
  }
}

// --- File features -----------------------------------------------------------

// The create-file event sends the enabled feature set minus
// cfeat/frontend-only-features (app.common.features), which never persist on
// the file row. The store's :features for the current team is the team row's
// feature list, so the shell derives the same set from the resolved team.

export const FRONTEND_ONLY_FEATURES: readonly string[] = [
  "styles/v2",
  "plugins/runtime",
  "text-editor/v2-html-paste",
  "text-editor/v2",
  "text-editor-wasm/v1",
  "tokens/numeric-input",
  "render-wasm/v1",
];

export function fileFeatures(team: Team | null | undefined): string[] {
  const excluded = new Set(FRONTEND_ONLY_FEATURES);
  return (team?.features ?? []).filter((feature) => !excluded.has(feature));
}

// --- Commands --------------------------------------------------------------

export function getTeams(): Promise<Team[]> {
  return cmd<Team[]>("get-teams");
}

export function getTeam(id: string): Promise<Team> {
  return cmd<Team>("get-team", { id });
}

export function getProjects(teamId: string): Promise<Project[]> {
  const params: RpcParams["get-projects"] = { "team-id": teamId };
  return cmd<Project[]>("get-projects", params);
}

export function getTeamRecentFiles(teamId: string): Promise<FileSummary[]> {
  const params: RpcParams["get-team-recent-files"] = { "team-id": teamId };
  return cmd<FileSummary[]>("get-team-recent-files", params);
}

export function getProjectFiles(projectId: string): Promise<FileSummary[]> {
  const params: RpcParams["get-project-files"] = { "project-id": projectId };
  return cmd<FileSummary[]>("get-project-files", params);
}

export function createProject(params: RpcParams["create-project"]): Promise<Project> {
  return cmd<Project>("create-project", params);
}

export function renameProject(params: RpcParams["rename-project"]): Promise<Project> {
  return cmd<Project>("rename-project", params);
}

// 204: the command answers empty, callers re-fetch the project list.
export function updateProjectPin(params: RpcParams["update-project-pin"]): Promise<void> {
  return cmd<void>("update-project-pin", params);
}

export function deleteProject(params: RpcParams["delete-project"]): Promise<unknown> {
  return cmd("delete-project", params);
}

export function createFile(params: RpcParams["create-file"]): Promise<CreatedFile> {
  return cmd<CreatedFile>("create-file", params);
}

export function searchFiles(params: RpcParams["search-files"]): Promise<FileSummary[]> {
  return cmd<FileSummary[]>("search-files", params);
}