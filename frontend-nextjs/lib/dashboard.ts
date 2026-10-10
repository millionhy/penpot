// Dashboard route group logic (F5.1). Headless port of the team and project
// slice of app.main.data.team and app.main.data.dashboard, plus the derived
// selections the app.main.ui.dashboard.* views compute inline.
//
// Kept free of JSX so it runs in vitest's node environment, like lib/forms.ts
// and lib/settings.ts. The views live in app/dashboard/* and
// components/dashboard-*.tsx.

import { cmd, cmdSse } from "@/lib/rpc";
import type { RouteName } from "@/lib/routes";
import { routePaths } from "@/lib/routes";
import { globalStorage, userStorage } from "@/lib/storage";
import { keyword, set as transitSet } from "@/lib/transit";
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
  // The settings page renders the team photo through teamPhotoUrl; the row
  // carries the media id (get-teams joins team_profile_rel).
  "photo-id"?: string | null;
  permissions?: TeamPermissions;
  features?: string[];
  // Only present when the backend runs with the :subscriptions flag
  // (sql:get-teams-with-permissions-and-subscription); the deleted section
  // reads it to work out how long the trash keeps a file.
  subscription?: Subscription | null;
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
  // file_thumbnail id served from assets/by-id (cf/resolve-media). The client
  // side regeneration through the media worker is deferred; see the F5.2 note
  // in components/dashboard-grid.tsx.
  "thumbnail-id"?: string | null;
  // get-project-files and get-team-recent-files rows carry the file data; the
  // grid card uses [:data :background] as the thumbnail backdrop and
  // on-file-created reads [:data :pages] of the create-file answer.
  data?: FileData | null;
}

// The data slice the shell reads; the real file data is far wider (F9).
export interface FileData {
  background?: string;
  pages?: string[];
}

// create-file answers with the whole file, data included, because
// on-file-created navigates straight to the first page.
export type CreatedFile = FileSummary;

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
  options: {
    immediateSuffix?: boolean;
    // cfh/generate-unique-name takes a :suffix-fn; the duplicate events pass
    // one that renders " Copy" / " Copy N" instead of the default " N".
    suffixFn?: (count: number) => string;
  } = {},
): string {
  const used = new Set(existingNames);
  if (options.immediateSuffix === true) used.add(baseName);
  if (!used.has(baseName)) return baseName;
  const suffix = options.suffixFn ?? ((count: number) => " " + String(count));
  for (let count = 1; ; count += 1) {
    const candidate = baseName + suffix(count);
    if (!used.has(candidate)) return candidate;
  }
}

// The suffix-fn the duplicate-file and duplicate-project events build from
// the "dashboard.copy-suffix" translation ("(copy)" on en).
export function copySuffixFn(copyWord: string): (count: number) => string {
  return (count) => (count > 1 ? " " + copyWord + " " + count : " " + copyWord);
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

// --- File selection (F5.2) ---------------------------------------------------
//
// dd/toggle-file-select and dd/clear-selected-files: the selection is a set of
// file ids pinned to one project (toggle is a no-op across projects), which is
// what lets shift-click extend a selection inside a grid but never mix files
// from two projects.

export interface FileSelection {
  projectId: string | null;
  ids: Set<string>;
}

export interface SelectableFile {
  id: string;
  "project-id": string;
}

export function emptyFileSelection(): FileSelection {
  return { projectId: null, ids: new Set<string>() };
}

export function toggleFileSelect(
  selection: FileSelection,
  file: SelectableFile,
): FileSelection {
  const projectId = selection.projectId;
  if (projectId !== null && projectId !== file["project-id"]) return selection;
  const ids = new Set(selection.ids);
  if (ids.has(file.id)) ids.delete(file.id);
  else ids.add(file.id);
  return { projectId: file["project-id"], ids };
}

// dd/open-selected-file: Enter navigates only when exactly one file is
// selected.
export function singleSelectedFileId(selection: FileSelection): string | null {
  return selection.ids.size === 1 ? selection.ids.values().next().value ?? null : null;
}

// --- Grid metrics (F5.2) ------------------------------------------------------
//
// Pure half of use-dynamic-grid-item-width (app.main.ui.hooks): the row
// container measures itself with a ResizeObserver and derives how many cards
// fit (limit, capped at 10) plus the thumbnail box the CSS variables
// --thumbnail-width/--thumbnail-height carry.

export interface DashboardGridLayout {
  limit: number;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
}

// The itemsize libraries-page* passes to use-dynamic-grid-item-width.
export const LIBRARIES_GRID_ITEM_WIDTH = 350;

// `minWidth` is the itemsize argument of use-dynamic-grid-item-width: the
// libraries grid asks for 350px cards, every other section leaves it nil and
// gets the 1030px breakpoint rule.
export function computeGridLayout(
  width: number | null,
  minWidth?: number | null,
): DashboardGridLayout {
  const itemSize =
    minWidth !== undefined && minWidth !== null
      ? minWidth
      : width !== null && width >= 1030
        ? 280
        : 230;
  const ratio = width !== null ? width / itemSize : 0;
  const limit = Math.max(1, Math.min(10, Math.floor(ratio)));
  if (width === null) return { limit, thumbnailWidth: null, thumbnailHeight: null };
  let thumbnailWidth = Math.floor((width - 32 - (limit - 1) * 24) / limit - 12);
  // The hook keeps the value even so the 3:2 box lands on whole pixels.
  if (thumbnailWidth % 2 !== 0) thumbnailWidth -= 1;
  const thumbnailHeight = Math.ceil(thumbnailWidth * (2 / 3));
  return { limit, thumbnailWidth, thumbnailHeight };
}

// --- Media URIs ----------------------------------------------------------------

// cf/resolve-media: stored media (file thumbnails, photos) is served from
// assets/by-id on the public URI.
export function resolveMediaUri(publicUri: string, mediaId: string): string {
  const base = publicUri.endsWith("/") ? publicUri : publicUri + "/";
  return base + "assets/by-id/" + mediaId;
}

// --- Layout preference -----------------------------------------------------------
//
// hooks/use-persisted-state with lt/layout-key: the grid/list choice lives in
// the "penpot-user" local storage under the layout-toggle namespace, shared by
// the recent and the files views. The value is written as a transit keyword so
// a CLJS tab on the same origin reads back :grid/:list, exactly what
// use-persisted-state stored there.

export type DashboardLayout = "grid" | "list";

export const LAYOUT_STORAGE_NS = "app.main.ui.dashboard.layout-toggle";
export const LAYOUT_STORAGE_KEY = "dashboard-layout";
export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = "grid";

// The reader decodes keywords as plain strings; anything unexpected falls back
// to the default layout.
export function parseDashboardLayout(value: unknown): DashboardLayout {
  return value === "list" ? "list" : DEFAULT_DASHBOARD_LAYOUT;
}

export function readDashboardLayout(): DashboardLayout {
  return parseDashboardLayout(userStorage.get(LAYOUT_STORAGE_NS, LAYOUT_STORAGE_KEY));
}

export function writeDashboardLayout(layout: DashboardLayout): void {
  userStorage.set(LAYOUT_STORAGE_NS, LAYOUT_STORAGE_KEY, keyword(layout));
}

// --- Move-to grouping ---------------------------------------------------------------
//
// get-all-projects answers with every project the profile can edit across all
// its teams, each row carrying team-name and is-default-team (sql:all-projects
// in backend/src/app/rpc/commands/projects.clj). group-by-team in
// file_menu.cljs folds those rows into the move-to drilldown: the current
// team's projects first, then one submenu per other team.

export interface AllProject extends Project {
  "team-name"?: string;
  "is-default-team"?: boolean;
}

export interface ProjectTeamGroup {
  id: string;
  name: string;
  isDefault: boolean;
  projects: AllProject[];
}

export function groupProjectsByTeam(projects: Iterable<AllProject>): ProjectTeamGroup[] {
  const groups: ProjectTeamGroup[] = [];
  const byTeam = new Map<string, ProjectTeamGroup>();
  for (const project of projects) {
    const teamId = project["team-id"];
    let group = byTeam.get(teamId);
    if (group === undefined) {
      group = {
        id: teamId,
        name: project["team-name"] ?? "",
        isDefault: project["is-default-team"] === true,
        projects: [],
      };
      byTeam.set(teamId, group);
      groups.push(group);
    }
    group.projects.push(project);
  }
  return groups;
}

// --- Commands (F5.2) ------------------------------------------------------------------

export function renameFile(params: RpcParams["rename-file"]): Promise<unknown> {
  return cmd("rename-file", params);
}

export function deleteFile(params: RpcParams["delete-file"]): Promise<unknown> {
  return cmd("delete-file", params);
}

export function duplicateFile(params: RpcParams["duplicate-file"]): Promise<CreatedFile> {
  return cmd<CreatedFile>("duplicate-file", params);
}

export function setFileShared(params: RpcParams["set-file-shared"]): Promise<unknown> {
  return cmd("set-file-shared", params);
}

// The backend schema is [::sm/set {:min 1} ::sm/uuid] for :ids, so the array
// goes on the wire as a transit set (data/dashboard.cljs sends #{}).
export function moveFiles(ids: Iterable<string>, projectId: string): Promise<unknown> {
  const params = { ids: transitSet(ids), "project-id": projectId } as unknown as RpcParams["move-files"];
  return cmd("move-files", params);
}

export function getAllProjects(): Promise<AllProject[]> {
  return cmd<AllProject[]>("get-all-projects");
}

export function duplicateProject(params: RpcParams["duplicate-project"]): Promise<Project> {
  return cmd<Project>("duplicate-project", params);
}

export function moveProject(params: RpcParams["move-project"]): Promise<unknown> {
  return cmd("move-project", params);
}

// show-shared-dialog reads the asset counts from the file summary to decide
// which add-shared-confirm message to show. The summary is far wider than this;
// only the counts and the name are consumed.
export interface FileSummaryCounts {
  name?: string;
  components?: { count?: number };
  graphics?: { count?: number };
  colors?: { count?: number };
  typographies?: { count?: number };
  variants?: { count?: number };
}

export function getFileSummary(id: string): Promise<FileSummaryCounts> {
  return cmd<FileSummaryCounts>("get-file-summary", { id });
}

// delete-shared-dialog lists the files that link each shared library.
export interface LibraryFileReference {
  id: string;
  name: string;
}

export function getLibraryFileReferences(fileId: string): Promise<LibraryFileReference[]> {
  return cmd<LibraryFileReference[]>("get-library-file-references", { "file-id": fileId });
}

// --- Trash (F5.3) ------------------------------------------------------------------
//
// get-team-deleted-files answers the soft-deleted files of a team
// (sql:team-deleted-files in backend/src/app/rpc/commands/files.clj). The rows
// are file rows plus the deletion deadline, so they feed the same grid card.

export interface DeletedFile extends FileSummary {
  "team-id"?: string;
  // Set by the backend deletion task: the instant the file leaves the trash
  // for good. grid-item-metadata* shows it instead of modified-at.
  "will-be-deleted-at"?: InstantValue | null;
  "row-num"?: number;
}

export function getTeamDeletedFiles(teamId: string): Promise<DeletedFile[]> {
  const params: RpcParams["get-team-deleted-files"] = { "team-id": teamId };
  return cmd<DeletedFile[]>("get-team-deleted-files", params);
}

// deleted-files-fetched (app.main.data.dashboard): rows whose deadline already
// passed are dropped, because the backend task is about to collect them and the
// trash must not offer to restore a file that no longer exists.
export function visibleDeletedFiles(
  rows: Iterable<DeletedFile>,
  now: Date = new Date(),
): DeletedFile[] {
  const out: DeletedFile[] = [];
  for (const row of rows) {
    const deadline = toMs(row["will-be-deleted-at"]);
    if (deadline === null || deadline > now.getTime()) out.push(row);
  }
  return out;
}

// The per-project slice deleted-project-item* renders, newest first.
export function deletedFilesOf(
  files: Iterable<DeletedFile>,
  projectId: string,
): DeletedFile[] {
  return [...files]
    .filter((file) => file["project-id"] === projectId)
    .sort((a, b) => timeOf(b["modified-at"]) - timeOf(a["modified-at"]));
}

// The projects memo of deleted-section*. Its two filters compose to "has at
// least one deleted file"; the first one (deleted-at or has deleted files) is
// subsumed by the second. Sorted modified-at descending, like every other
// dashboard list.
export function deletedProjectsFor(
  projects: Iterable<Project>,
  deletedFiles: Iterable<DeletedFile>,
): Project[] {
  const projectIds = new Set<string>();
  for (const file of deletedFiles) projectIds.add(file["project-id"]);
  return [...projects]
    .filter((project) => projectIds.has(project.id))
    .sort((a, b) => timeOf(b["modified-at"]) - timeOf(a["modified-at"]));
}

// --- Trash retention ----------------------------------------------------------------

export interface Subscription {
  type?: string | null;
  status?: string | null;
  seats?: number;
  [key: string]: unknown;
}

// get-subscription-type (app.main.ui.dashboard.subscription): an unpaid or
// cancelled subscription falls back to the professional plan.
export function subscriptionType(subscription: Subscription | null | undefined): string {
  const type = subscription?.type;
  const status = subscription?.status;
  if (typeof type !== "string" || type.length === 0) return "professional";
  if (status === "unpaid" || status === "canceled") return "professional";
  return type;
}

// --- Shared libraries (F5.3) ---------------------------------------------------------
//
// get-team-shared-files answers the published files of a team, each row
// carrying the cached library summary the backend computes in
// calculate-library-summary (backend/src/app/rpc/commands/files.clj).

export interface LibraryComponentSample {
  id: string;
  name: string;
  "main-instance-id"?: string | null;
  // Components come with their shapes so the card can render a preview; the
  // shell shows a placeholder box instead until the F9 renderer lands.
  objects?: Record<string, unknown> | null;
}

export interface LibraryColorSample {
  id: string;
  name: string;
  color?: string;
  opacity?: number;
  gradient?: { type?: string } | null;
  value?: string;
}

export interface LibraryTypographySample {
  id: string;
  name: string;
  "font-id"?: string;
  "font-family"?: string;
  "font-weight"?: string;
  "font-style"?: string;
}

export interface LibrarySummarySection<T> {
  count?: number;
  sample?: T[];
}

export interface LibrarySummary {
  components?: LibrarySummarySection<LibraryComponentSample>;
  colors?: LibrarySummarySection<LibraryColorSample>;
  typographies?: LibrarySummarySection<LibraryTypographySample>;
  variants?: { count?: number };
  "tokens-count"?: number;
  "token-sets-count"?: number;
  "token-themes-count"?: number;
}

export interface SharedFile extends FileSummary {
  "team-id"?: string;
  "library-summary"?: LibrarySummary | null;
  "library-file-ids"?: string[];
}

export function getTeamSharedFiles(teamId: string): Promise<SharedFile[]> {
  const params: RpcParams["get-team-shared-files"] = { "team-id": teamId };
  return cmd<SharedFile[]>("get-team-shared-files", params);
}

// The files memo of libraries-page*: this team only, modified-at descending.
export function sharedFilesForTeam(
  rows: Iterable<SharedFile>,
  teamId: string | null | undefined,
): SharedFile[] {
  if (teamId === null || teamId === undefined) return [];
  return [...rows]
    .filter((row) => row["team-id"] === teamId)
    .sort((a, b) => timeOf(b["modified-at"]) - timeOf(a["modified-at"]));
}

// grid-item-library* hides a colour's hex value when the colour is named after
// it; uc/gradient-type->string supplies the gradient name.
export function colorSampleValue(sample: LibraryColorSample): string {
  const gradientType = sample.gradient?.type;
  if (typeof gradientType === "string" && gradientType.length > 0) return gradientType;
  if (typeof sample.color === "string" && sample.color.length > 0) return sample.color;
  return sample.value ?? "";
}

// --- Bulk trash operations over SSE (F5.3) --------------------------------------------
//
// restore-files / delete-files in app.main.data.dashboard: both send the id set
// to a ::sse/ command and consume one progress block per file, then the end
// block. The progress payload is {:file-id :index :total}.
//
// Backend race, not a client concern: delete-file and delete-project also queue
// a :delete-object task that carries the deletion instant
// (backend/src/app/tasks/delete_object.clj) and rewrites file.deleted_at when
// it runs a few seconds later. A restore that lands in between is undone by it,
// so a file can reappear in the trash right after a successful restore. The
// CLJS app has the same hole; the shell keeps the behaviour and the backend
// stays untouched until phase G.

export interface BulkProgress {
  "file-id"?: string;
  index?: number;
  total?: number;
}

export interface BulkFileHandlers {
  signal?: AbortSignal;
  onProgress?: (progress: BulkProgress) => void;
}

function bulkFileStream(
  id: string,
  teamId: string,
  fileIds: Iterable<string>,
  handlers: BulkFileHandlers,
): Promise<unknown> {
  // The backend schema is [::sm/set {:min 1} ::sm/uuid], so :ids travels as a
  // transit set even though api-types writes it as an array.
  const params = { "team-id": teamId, ids: transitSet(fileIds) } as unknown as Record<
    string,
    unknown
  >;
  return cmdSse(id, params, {
    signal: handlers.signal,
    onMessage: (message) => {
      if (message.type !== "progress") return;
      const payload = message.payload as BulkProgress | null;
      if (payload === null || payload === undefined) return;
      handlers.onProgress?.(payload);
    },
  });
}

export function restoreDeletedTeamFiles(
  teamId: string,
  fileIds: Iterable<string>,
  handlers: BulkFileHandlers = {},
): Promise<unknown> {
  return bulkFileStream("restore-deleted-team-files", teamId, fileIds, handlers);
}

export function permanentlyDeleteTeamFiles(
  teamId: string,
  fileIds: Iterable<string>,
  handlers: BulkFileHandlers = {},
): Promise<unknown> {
  return bulkFileStream("permanently-delete-team-files", teamId, fileIds, handlers);
}
