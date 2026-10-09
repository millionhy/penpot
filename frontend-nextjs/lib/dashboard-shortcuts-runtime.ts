// Dashboard shortcut runtime (F5.6): the route -> set resolution, the
// set -> matcher bindings construction and the theme toggle cycle. The
// matcher itself lives in lib/shortcuts.ts.
//
// Port of the mounting points of hooks/use-shortcuts on the dashboard pages
// (dashboard.cljs, dashboard/projects.cljs, dashboard/files.cljs,
// dashboard/libraries.cljs and settings.cljs) and of du/toggle-theme
// (data/profile.cljs).
//
// Deviations from the CLJS original, documented:
// - Set selection follows the route, not hook mount order. The CLJS shell
//   pushes sc/shortcuts-dashboard for every /dashboard/* route and the page
//   components push their own set under the same ::dashboard key; which of
//   the two ends up bound depends on effect timing (a fresh load, a
//   navigation and a page switch can differ, and a pop can leave nothing
//   bound). The shell picks the set the route mounts - the navigation
//   outcome - with a single binding point; every page set is a superset of
//   the shell set, so nothing is lost.
// - nextTheme only computes the next value; persisting the profile and the
//   activate-theme analytics event stay with the caller.

import {
  dashboardShortcutSet,
  runDashboardShortcut,
  type DashboardShortcutActions,
  type DashboardShortcutKey,
  type DashboardShortcutSetName,
} from "@/lib/dashboard-shortcuts";
import {
  applyCustomOverrides,
  eventToMousetrapCommand,
  type CustomShortcuts,
  type ShortcutBinding,
  type ShortcutKeyEvent,
  type ShortcutMatcher,
  type ShortcutTarget,
} from "@/lib/shortcuts";

function isRoute(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(base + "/");
}

// The registry set a route mounts:
// - /dashboard/recent* -> sc/shortcuts-projects (projects.cljs)
// - /dashboard/files*, /dashboard/libraries* -> sc/shortcuts-drafts-libraries
// - every other /dashboard* route -> sc/shortcuts-dashboard (the shell)
// - /settings* -> sc/shortcuts (base, mounted by settings.cljs)
// - elsewhere null: the viewer and workspace sets are not migrated yet.
export function dashboardSetForPath(pathname: string): DashboardShortcutSetName | null {
  if (isRoute(pathname, "/dashboard")) {
    if (isRoute(pathname, "/dashboard/recent")) return "projects";
    if (isRoute(pathname, "/dashboard/files") || isRoute(pathname, "/dashboard/libraries")) {
      return "drafts-libraries";
    }
    return "dashboard";
  }
  if (isRoute(pathname, "/settings")) return "base";
  return null;
}

// The set as matcher bindings, with the :dashboard group overrides applied
// (every dashboard set mounts under that group key). A command cleared to ""
// stays in the binding: canonicalCommands("") yields no combos, so the
// matcher never fires it.
export function buildDashboardBindings(
  setName: DashboardShortcutSetName,
  macos: boolean,
  customs: CustomShortcuts | null | undefined,
  actions: DashboardShortcutActions,
): ShortcutBinding[] {
  const definitions = applyCustomOverrides(dashboardShortcutSet(setName, macos), customs, "dashboard");
  return Object.entries(definitions).map(([key, definition]) => ({
    command: definition.command,
    run: () => runDashboardShortcut(key as DashboardShortcutKey, actions),
  }));
}

export type ThemeName = "light" | "dark" | "system";

// du/toggle-theme: dark -> light -> system -> dark. "default" is old data on
// the database and enters the cycle at dark; missing or unknown values also
// land on dark (the CLJS failsafe).
export function nextTheme(current: string | null | undefined): ThemeName {
  const value = current === "default" ? "dark" : current;
  switch (value) {
    case "dark":
      return "light";
    case "light":
      return "system";
    case "system":
      return "dark";
    default:
      return "dark";
  }
}

// One keydown -> one mousetrap combo handed to the matcher. Returns whether
// an action ran; the caller preventDefaults on true, like wrap-cb does.
// Standalone modifier presses produce no combo and are ignored.
export function dispatchDashboardKeydown(
  matcher: ShortcutMatcher,
  event: ShortcutKeyEvent,
  macos: boolean,
  target?: ShortcutTarget | null,
): boolean {
  const combo = eventToMousetrapCommand(event, macos);
  if (combo === null) return false;
  return matcher.handle(combo, target);
}
