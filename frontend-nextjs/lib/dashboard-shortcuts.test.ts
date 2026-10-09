import { describe, expect, it, vi } from "vitest";
import {
  dashboardShortcutSet,
  dashboardShortcuts,
  elementCreationTarget,
  getTooltip,
  runDashboardShortcut,
  type DashboardShortcutActions,
  type DashboardShortcutKey,
} from "@/lib/dashboard-shortcuts";
import { tr } from "@/lib/i18n";

const allKeys: DashboardShortcutKey[] = [
  "toggle-theme",
  "go-to-drafts",
  "go-to-libs",
  "go-to-search",
  "create-new-project",
];

describe("dashboardShortcuts", () => {
  it("builds the platform commands of the five definitions", () => {
    expect(Object.keys(dashboardShortcuts(false))).toHaveLength(5);
    expect(dashboardShortcuts(true)["toggle-theme"].command).toBe("alt+m");
    expect(dashboardShortcuts(false)["toggle-theme"].command).toBe("alt+m");
    expect(dashboardShortcuts(false)["go-to-drafts"].command).toBe("g d");
    expect(dashboardShortcuts(false)["go-to-libs"].command).toBe("g l");
    expect(dashboardShortcuts(true)["go-to-search"].command).toBe("command+f");
    expect(dashboardShortcuts(false)["go-to-search"].command).toBe("ctrl+f");
    expect(dashboardShortcuts(false)["create-new-project"].command).toBe("+");
  });

  it("builds the platform tooltips", () => {
    expect(dashboardShortcuts(true)["toggle-theme"].tooltip).toBe("\u2325M");
    expect(dashboardShortcuts(false)["toggle-theme"].tooltip).toBe("Alt+M");
    expect(dashboardShortcuts(true)["go-to-search"].tooltip).toBe("\u2318F");
    expect(dashboardShortcuts(false)["go-to-search"].tooltip).toBe("Ctrl+F");
    expect(dashboardShortcuts(false)["go-to-drafts"].tooltip).toBe("G D");
    expect(dashboardShortcuts(false)["go-to-libs"].tooltip).toBe("G L");
    expect(dashboardShortcuts(false)["create-new-project"].tooltip).toBe("+");
  });

  it("keeps every definition in the dashboard section", () => {
    for (const key of allKeys) {
      const definition = dashboardShortcuts(false)[key];
      expect(definition.section).toEqual(["dashboard"]);
      expect(definition.subsections).toHaveLength(1);
    }
    expect(dashboardShortcuts(false)["toggle-theme"].subsections).toEqual(["generic"]);
    expect(dashboardShortcuts(false)["create-new-project"].subsections).toEqual(["generic"]);
    expect(dashboardShortcuts(false)["go-to-drafts"].subsections).toEqual(["navigation-dashboard"]);
    expect(dashboardShortcuts(false)["go-to-libs"].subsections).toEqual(["navigation-dashboard"]);
    expect(dashboardShortcuts(false)["go-to-search"].subsections).toEqual(["navigation-dashboard"]);
  });
});

describe("dashboardShortcutSet", () => {
  it("composes the page sets", () => {
    expect(Object.keys(dashboardShortcutSet("base", false))).toEqual([
      "toggle-theme",
    ]);
    expect(Object.keys(dashboardShortcutSet("dashboard", false))).toEqual([
      "toggle-theme",
      "go-to-drafts",
      "go-to-libs",
    ]);
    expect(Object.keys(dashboardShortcutSet("projects", false))).toEqual([
      "toggle-theme",
      "go-to-drafts",
      "go-to-libs",
      "go-to-search",
      "create-new-project",
    ]);
    expect(Object.keys(dashboardShortcutSet("drafts-libraries", false))).toEqual([
      "toggle-theme",
      "go-to-drafts",
      "go-to-libs",
      "go-to-search",
    ]);
  });

  it("builds the definitions per platform", () => {
    expect(dashboardShortcutSet("drafts-libraries", true)["go-to-search"].command).toBe("command+f");
    expect(dashboardShortcutSet("projects", false)["go-to-search"].command).toBe("ctrl+f");
  });
});

describe("getTooltip", () => {
  it("returns the platform tooltip of a definition", () => {
    expect(getTooltip("go-to-search", true)).toBe("\u2318F");
    expect(getTooltip("go-to-search", false)).toBe("Ctrl+F");
    expect(getTooltip("toggle-theme", false)).toBe("Alt+M");
  });
});

describe("elementCreationTarget", () => {
  it("creates files inside a project route and projects elsewhere", () => {
    expect(elementCreationTarget("project-1")).toBe("create-file");
    expect(elementCreationTarget(null)).toBe("create-project");
  });
});

describe("runDashboardShortcut", () => {
  function setup() {
    const navigate = vi.fn();
    const toggleTheme = vi.fn();
    const createElement = vi.fn();
    const actions: DashboardShortcutActions = {
      navigate,
      defaultProjectId: "drafts-id",
      toggleTheme,
      createElement,
    };
    return { actions, navigate, toggleTheme, createElement };
  }

  it("dispatches the theme toggle", () => {
    const { actions, navigate, toggleTheme } = setup();
    runDashboardShortcut("toggle-theme", actions);
    expect(toggleTheme).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("navigates to the default project files", () => {
    const { actions, navigate } = setup();
    runDashboardShortcut("go-to-drafts", actions);
    expect(navigate).toHaveBeenCalledWith("dashboard-files", { projectId: "drafts-id" });
  });

  it("passes a missing default project through as null", () => {
    const { actions, navigate } = setup();
    actions.defaultProjectId = null;
    runDashboardShortcut("go-to-drafts", actions);
    expect(navigate).toHaveBeenCalledWith("dashboard-files", { projectId: null });
  });

  it("navigates to the libraries and search sections", () => {
    const { actions, navigate } = setup();
    runDashboardShortcut("go-to-libs", actions);
    runDashboardShortcut("go-to-search", actions);
    expect(navigate).toHaveBeenNthCalledWith(1, "dashboard-libraries");
    expect(navigate).toHaveBeenNthCalledWith(2, "dashboard-search");
  });

  it("delegates the create action to the page", () => {
    const { actions, createElement } = setup();
    runDashboardShortcut("create-new-project", actions);
    expect(createElement).toHaveBeenCalledTimes(1);
  });
});

describe("label keys", () => {
  it("resolve through the generated catalog", () => {
    // tr() falls back to the key itself, so a label the extractor missed would
    // render as its own name. The definitions keep their keys in the labelKey
    // data field, which scripts/extract-translations.mjs scans via trFieldRe.
    for (const key of allKeys) {
      const definition = dashboardShortcuts(false)[key];
      expect(tr(definition.labelKey)).not.toBe(definition.labelKey);
    }
  });
});
