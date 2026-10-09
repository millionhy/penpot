// Dashboard shortcuts registry (F5.6). Port of the definitions and set
// compositions in app.main.data.dashboard.shortcuts, the "+" action of
// app.main.data.dashboard/create-element, and the navigation events the
// definitions emit (app.main.data.common go-to-dashboard-*).
//
// Two shell conventions differ from the CLJS shape:
// - labelKey holds the i18n key; scripts/extract-translations.mjs scans the
//   labelKey fields (trFieldRe), so the catalog keeps these labels exactly
//   like the settings nav does. Do not spell the pattern out in prose here,
//   the regex is not comment-aware.
// - Commands and tooltips are built per platform by dashboardShortcuts(macos).
//   The CLJS namespace bakes c-mod/ds/alt at load time (client-only); the
//   shell cannot, because the module also evaluates during SSR.
//
// Deviations from the CLJS original, documented:
// - dd/create-element is split: elementCreationTarget() decides file vs
//   project (the route's project-id, like `(contains? pparams :project-id)`),
//   while the RPC call and the post-create UI state (inline rename on the
//   projects page, workspace navigation on the files page) stay with the
//   pages that already own them (F5.2).
// - go-to-search navigates only; the CLJS event also focuses #search-input
//   after the navigation. The element exists in the shell sidebar
//   (id="search-input"), the runtime hook focuses it.
// - The toggle-theme event carries the ::ev/origin "dashboard:shortcuts"
//   analytics marker; the shell has no analytics channel yet.

import { aMod, altLabel, cMod, metaLabel } from "@/lib/shortcuts";
import type { DashboardNavParams } from "@/lib/dashboard";
import type { RouteName } from "@/lib/routes";

export type DashboardShortcutKey =
  | "toggle-theme"
  | "go-to-drafts"
  | "go-to-libs"
  | "go-to-search"
  | "create-new-project";

export interface DashboardShortcutDefinition {
  labelKey: string;
  tooltip: string;
  command: string;
  section: readonly string[];
  subsections: readonly string[];
}

export type DashboardShortcuts = Record<DashboardShortcutKey, DashboardShortcutDefinition>;

// The five definitions; every one carries section [:dashboard] like the CLJS
// maps. toggle-theme and create-new-project sit in :generic, the other three
// in :navigation-dashboard.
export function dashboardShortcuts(macos: boolean): DashboardShortcuts {
  return {
    "toggle-theme": {
      labelKey: "shortcuts.toggle-theme",
      tooltip: altLabel("M", macos),
      command: aMod("m"),
      section: ["dashboard"],
      subsections: ["generic"],
    },
    "go-to-drafts": {
      labelKey: "shortcuts.go-to-drafts",
      tooltip: "G D",
      command: "g d",
      section: ["dashboard"],
      subsections: ["navigation-dashboard"],
    },
    "go-to-libs": {
      labelKey: "shortcuts.go-to-libs",
      tooltip: "G L",
      command: "g l",
      section: ["dashboard"],
      subsections: ["navigation-dashboard"],
    },
    "go-to-search": {
      labelKey: "shortcuts.go-to-search",
      tooltip: metaLabel("F", macos),
      command: cMod("f", macos),
      section: ["dashboard"],
      subsections: ["navigation-dashboard"],
    },
    "create-new-project": {
      labelKey: "shortcuts.create-new-project",
      tooltip: "+",
      command: "+",
      section: ["dashboard"],
      subsections: ["generic"],
    },
  };
}

export type DashboardShortcutSetName = "dashboard" | "projects" | "drafts-libraries" | "base";

// The set compositions of the CLJS registry:
// - sc/shortcuts-{dashboard,projects,drafts-libraries}: the dashboard shell
//   adds the sidebar navigation pair, projects adds search and
//   create-new-project, drafts/libraries adds search. Every set includes
//   toggle-theme.
// - "base" is sc/shortcuts itself (the dsc/shortcuts map, toggle-theme only):
//   the settings layout mounts it for the :dashboard group
//   (settings.cljs: `use-shortcuts ::dashboard sc/shortcuts :dashboard`) and
//   the settings/shortcuts page renders it as the dashboard context tree.
const setKeys: Record<DashboardShortcutSetName, readonly DashboardShortcutKey[]> = {
  base: ["toggle-theme"],
  dashboard: ["toggle-theme", "go-to-drafts", "go-to-libs"],
  projects: [
    "toggle-theme",
    "go-to-drafts",
    "go-to-libs",
    "go-to-search",
    "create-new-project",
  ],
  "drafts-libraries": ["toggle-theme", "go-to-drafts", "go-to-libs", "go-to-search"],
};

export function dashboardShortcutSet(
  name: DashboardShortcutSetName,
  macos: boolean,
): DashboardShortcuts {
  const all = dashboardShortcuts(macos);
  const out = {} as DashboardShortcuts;
  for (const key of setKeys[name]) out[key] = all[key];
  return out;
}

// sc/get-tooltip: the tooltip of a definition, used where the UI shows the
// shortcut next to a label (e.g. the sidebar search tooltip).
export function getTooltip(key: DashboardShortcutKey, macos: boolean): string {
  return dashboardShortcuts(macos)[key].tooltip;
}

// dd/create-element: inside a project route the "+" shortcut creates a file
// with the dashboard.new-file-prefix name, anywhere else a project with
// dashboard.new-project-prefix; edit rights gate both.
export function elementCreationTarget(projectId: string | null): "create-file" | "create-project" {
  return projectId === null ? "create-project" : "create-file";
}

// What the runtime hook provides to run an action: the dashboard navigate()
// from lib/dashboard-context, the resolved default (drafts) project id (the
// CLJS `:project-id :default` resolves through the profile's
// :default-project-id), a theme toggle (dark -> light -> system -> dark, see
// du/toggle-theme) and the page-owned create-element handler.
export interface DashboardShortcutActions {
  navigate: (section: RouteName, params?: DashboardNavParams) => void;
  defaultProjectId: string | null;
  toggleTheme: () => void;
  createElement: () => void;
}

export function runDashboardShortcut(
  key: DashboardShortcutKey,
  actions: DashboardShortcutActions,
): void {
  switch (key) {
    case "toggle-theme":
      actions.toggleTheme();
      break;
    case "go-to-drafts":
      actions.navigate("dashboard-files", { projectId: actions.defaultProjectId });
      break;
    case "go-to-libs":
      actions.navigate("dashboard-libraries");
      break;
    case "go-to-search":
      actions.navigate("dashboard-search");
      break;
    case "create-new-project":
      actions.createElement();
      break;
  }
}
