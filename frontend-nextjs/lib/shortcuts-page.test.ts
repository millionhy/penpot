import { describe, expect, it } from "vitest";
import { dashboardShortcutSet } from "@/lib/dashboard-shortcuts";
import { tr } from "@/lib/i18n";
import { applyCustomOverrides } from "@/lib/shortcuts";
import {
  buildShortcutsTree,
  collectOpenSectionIds,
  computeShortcutsDiff,
  contextDisplayName,
  exportShortcutsFilename,
  extractShortcutParts,
  filterShortcutsTree,
  importShortcutsMerge,
  knownShortcutKeys,
  matchesSearch,
  sectionLabelKey,
  shortcutLabelKey,
  sortShortcutDiffEntries,
  subsectionLabelKey,
  tabRowFilter,
  validateImportedShortcuts,
  type ImportValidationError,
  type ImportValidationResult,
  type ShortcutDefinitionEntries,
  type ShortcutPageDefinition,
} from "@/lib/shortcuts-page";
import { knownWorkspaceShortcutKeys, pathShortcuts, workspaceShortcuts } from "@/lib/workspace-shortcuts";

// The suite mirrors frontend/test/frontend_tests/ui/settings_shortcuts_test.cljs
// where the semantics are shared, and covers the shell-only pieces (tree
// build/filter, tab predicates, filename) on top. Documented deviations are
// asserted explicitly so they fail loudly if the CLJS behavior is restored.

function invalidErrors(result: ImportValidationResult): ImportValidationError[] {
  expect(result.valid).toBe(false);
  return result.valid ? [] : result.errors;
}

const base = dashboardShortcutSet("base", false);
const baseDefaults = {
  workspace: null,
  dashboard: base,
  viewer: null,
};
const translate = (key: string) => key;

describe("matchesSearch", () => {
  it("matches when the term is empty or missing", () => {
    expect(matchesSearch("Save all", "")).toBe(true);
    expect(matchesSearch("Save all", null)).toBe(true);
    expect(matchesSearch("Save all", undefined)).toBe(true);
  });

  it("matches case-insensitively with both sides trimmed", () => {
    expect(matchesSearch("  Ctrl+Z  ", " ctrl ")).toBe(true);
    expect(matchesSearch("Save All", "SAVE")).toBe(true);
    expect(matchesSearch("ctrl+z", "ALT")).toBe(false);
  });

  it("reads the arguments as (name, term)", () => {
    expect(matchesSearch("save", "Save all")).toBe(false);
    expect(matchesSearch("Save all", "save")).toBe(true);
  });

  it("never matches a blank name against a non-blank term", () => {
    expect(matchesSearch("", "x")).toBe(false);
    expect(matchesSearch(null, "x")).toBe(false);
  });
});

describe("validateImportedShortcuts", () => {
  it("accepts a valid workspace payload", () => {
    expect(
      validateImportedShortcuts({
        workspace: {
          escape: "escape",
          "increase-zoom": "+",
          "zoom-lense-decrease": "alt+z",
        },
      }),
    ).toEqual({ valid: true });
  });

  it("accepts the optional contexts", () => {
    expect(
      validateImportedShortcuts({
        workspace: { escape: "escape" },
        dashboard: { "toggle-theme": "alt+m" },
        viewer: { "next-frame": "right" },
      }),
    ).toEqual({ valid: true });
  });

  it("accepts an empty string command", () => {
    expect(validateImportedShortcuts({ workspace: { escape: "" } })).toEqual({ valid: true });
  });

  it("accepts a missing workspace", () => {
    expect(validateImportedShortcuts({ dashboard: { "toggle-theme": "alt+m" } })).toEqual({
      valid: true,
    });
  });

  it("rejects nil and non-maps", () => {
    for (const value of [null, undefined, "shortcuts", 42, [], true]) {
      expect(validateImportedShortcuts(value).valid).toBe(false);
    }
  });

  it("rejects a non-map context with the context as path", () => {
    const errors = invalidErrors(validateImportedShortcuts({ workspace: "not-a-map" }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((error) => error.path === "workspace")).toBe(true);
  });

  it("rejects a non-string command with ctx/key as path", () => {
    const errors = invalidErrors(validateImportedShortcuts({ workspace: { escape: 123 } }));
    expect(errors.some((error) => error.path === "workspace/escape")).toBe(true);
  });

  it("rejects a vector command (only plain strings import)", () => {
    const errors = invalidErrors(
      validateImportedShortcuts({ workspace: { escape: ["ctrl+e"] } }),
    );
    expect(errors.some((error) => error.path === "workspace/escape")).toBe(true);
  });

  it("rejects an unknown top-level context", () => {
    const errors = invalidErrors(
      validateImportedShortcuts({ workspace: { escape: "escape" }, "unknown-context": {} }),
    );
    expect(errors.some((error) => error.path.includes("unknown-context"))).toBe(true);
  });

  it("rejects an unknown dashboard key", () => {
    const errors = invalidErrors(
      validateImportedShortcuts({ dashboard: { "not-a-real-shortcut": "x" } }),
    );
    expect(errors.some((error) => error.path === "dashboard/not-a-real-shortcut")).toBe(true);
  });

  it("rejects an unknown key in every context", () => {
    for (const context of ["workspace", "dashboard", "viewer"]) {
      const errors = invalidErrors(
        validateImportedShortcuts({ [context]: { "not-a-real-shortcut": "x" } }),
      );
      expect(errors.some((error) => error.path === context + "/not-a-real-shortcut")).toBe(true);
    }
  });

  it("accepts a key the path registry adds to the workspace context", () => {
    expect(validateImportedShortcuts({ workspace: { "move-nodes": "m" } })).toEqual({
      valid: true,
    });
  });

  it("never throws", () => {
    for (const value of [new Date(), new Set(["workspace"]), () => undefined, new Map()]) {
      expect(validateImportedShortcuts(value).valid).toBe(false);
    }
  });
});

describe("importShortcutsMerge", () => {
  it("updates multiple contexts", () => {
    const merged = importShortcutsMerge(
      { workspace: { "add-comment": "alt+c" }, viewer: { "select-all": "ctrl+alt+a" } },
      {},
      {
        workspace: {
          "add-comment": { command: "alt+c" },
          "select-all": { command: "ctrl+a" },
        },
      },
    );
    expect(merged).toEqual({
      workspace: { "add-comment": "alt+c" },
      viewer: { "select-all": "ctrl+alt+a" },
    });
  });

  it("preserves the contexts the payload does not mention", () => {
    const current = {
      workspace: { existing: "ctrl+e" },
      dashboard: { "toggle-theme": "alt+m" },
      viewer: { "select-all": "ctrl+a" },
    };
    const merged = importShortcutsMerge(
      { workspace: { "add-comment": "alt+c" } },
      current,
      {
        workspace: {
          "add-comment": { command: "alt+c" },
          existing: { command: "ctrl+e" },
          "toggle-theme": { command: "alt+m" },
          "select-all": { command: "ctrl+a" },
        },
      },
    );
    expect(merged).toEqual({
      workspace: { "add-comment": "alt+c" },
      dashboard: { "toggle-theme": "alt+m" },
      viewer: { "select-all": "ctrl+a" },
    });
  });

  it("clears a context when the import carries an empty map", () => {
    const merged = importShortcutsMerge(
      { workspace: {} },
      { workspace: { existing: "ctrl+e" } },
      {},
    );
    expect(merged).toEqual({ workspace: {} });
  });

  it("disables the default whose command collides with an imported one", () => {
    const merged = importShortcutsMerge(
      { workspace: { "select-all": "ctrl+a" } },
      {},
      {
        workspace: {
          "select-all": { command: "ctrl+a" },
          "add-comment": { command: "ctrl+a" },
        },
      },
    );
    expect(merged.workspace).toEqual({ "select-all": "ctrl+a", "add-comment": "" });
  });

  it("clears the earlier entry of a duplicated batch command", () => {
    const merged = importShortcutsMerge(
      { workspace: { "move-up": "ctrl+up", "move-to-top": "ctrl+up" } },
      {},
      {
        workspace: {
          "move-up": { command: "ctrl+shift+up" },
          "move-to-top": { command: "ctrl+shift+top" },
        },
      },
    );
    const workspace = merged.workspace ?? {};
    expect(workspace["move-up"]).toBe("");
    expect(workspace["move-to-top"]).toBe("ctrl+up");
  });

  it("does not clear a binding imported with its own registry command", () => {
    const merged = importShortcutsMerge(
      { dashboard: { "toggle-theme": "alt+m" } },
      {},
      { dashboard: { "toggle-theme": { command: "alt+m" } } },
    );
    expect(merged.dashboard).toEqual({ "toggle-theme": "alt+m" });
  });
});

describe("computeShortcutsDiff", () => {
  it("shows a new shortcut as a change", () => {
    const diff = computeShortcutsDiff({ workspace: { "add-comment": "alt+c" } }, {}, {});
    expect(diff).toHaveLength(1);
    const entry = diff[0];
    expect(entry.context).toBe("workspace");
    expect(entry.key).toBe("add-comment");
    expect(entry.imported).toBe("alt+c");
    expect(entry.current).not.toBe("alt+c");
  });

  it("shows a conflicting binding as a change", () => {
    const diff = computeShortcutsDiff({ workspace: { "select-all": "ctrl+shift+a" } }, {}, {});
    const entry = diff.find((item) => item.key === "select-all");
    expect(entry?.context).toBe("workspace");
    expect(entry?.imported).toBe("ctrl+shift+a");
  });

  it("shows an empty string import as a disabled shortcut", () => {
    const diff = computeShortcutsDiff({ workspace: { escape: "" } }, {}, {});
    const entry = diff.find((item) => item.key === "escape");
    expect(entry?.context).toBe("workspace");
    expect(entry?.imported).toBe("");
  });

  it("excludes unchanged shortcuts", () => {
    const diff = computeShortcutsDiff(
      { workspace: { escape: "" } },
      { workspace: { escape: "" } },
      {},
    );
    expect(diff).toHaveLength(0);
  });

  it("detects changes across multiple contexts", () => {
    const diff = computeShortcutsDiff(
      { workspace: { "add-comment": "alt+c" }, viewer: { "next-frame": "right" } },
      {},
      {},
    );
    const contexts = new Set(diff.map((entry) => entry.context));
    expect(contexts.has("workspace")).toBe(true);
    expect(contexts.has("viewer")).toBe(true);
  });

  it("compares against the dashboard registry default", () => {
    const defaults = { dashboard: base };
    expect(
      computeShortcutsDiff({ dashboard: { "toggle-theme": "alt+m" } }, {}, defaults),
    ).toHaveLength(0);
    const diff = computeShortcutsDiff({ dashboard: { "toggle-theme": "alt+t" } }, {}, defaults);
    expect(diff).toHaveLength(1);
    expect(diff[0].current).toBe("alt+m");
    expect(diff[0].customized).toBe(false);
  });

  it("marks a differing current override as customized", () => {
    const diff = computeShortcutsDiff(
      { dashboard: { "toggle-theme": "alt+t" } },
      { dashboard: { "toggle-theme": "alt+x" } },
      { dashboard: base },
    );
    expect(diff).toHaveLength(1);
    expect(diff[0].current).toBe("alt+x");
    expect(diff[0].customized).toBe(true);
  });
});

describe("sortShortcutDiffEntries", () => {
  it("orders by context (workspace, dashboard, viewer) then key", () => {
    const entry = (context: string, key: string) => ({
      context,
      key,
      current: null,
      imported: "x",
      customized: false,
    });
    const sorted = sortShortcutDiffEntries([
      entry("viewer", "b"),
      entry("dashboard", "z"),
      entry("workspace", "b"),
      entry("workspace", "a"),
    ]);
    expect(sorted.map((item) => item.context + ":" + item.key)).toEqual([
      "workspace:a",
      "workspace:b",
      "dashboard:z",
      "viewer:b",
    ]);
  });
});

describe("contextDisplayName", () => {
  it("names the three contexts", () => {
    expect(contextDisplayName("workspace")).toBe("Workspace");
    expect(contextDisplayName("dashboard")).toBe("Dashboard");
    expect(contextDisplayName("viewer")).toBe("Viewer");
  });
});

describe("extractShortcutParts", () => {
  it("uses the context override as the current command", () => {
    const customs = {
      workspace: { undo: "shift+z", "move-nodes": "shift+m" },
      dashboard: { "toggle-theme": "alt+t" },
      viewer: { "next-frame": "right" },
    };
    expect(extractShortcutParts("undo", customs, "workspace", baseDefaults).currentCommand).toBe(
      "shift+z",
    );
    expect(
      extractShortcutParts("toggle-theme", customs, "dashboard", baseDefaults).currentCommand,
    ).toBe("alt+t");
    expect(
      extractShortcutParts("next-frame", customs, "viewer", baseDefaults).currentCommand,
    ).toBe("right");
    expect(
      extractShortcutParts("move-nodes", customs, "workspace", baseDefaults).currentCommand,
    ).toBe("shift+m");
  });

  it("falls back to the registry default", () => {
    const parts = extractShortcutParts("toggle-theme", {}, "dashboard", baseDefaults);
    expect(parts.currentCommand).toBe("alt+m");
    expect(parts.customized).toBe(false);
    expect(parts.currentChars).toEqual([["alt", "m"]]);
  });

  it("marks a non-blank override that differs from the default", () => {
    expect(
      extractShortcutParts(
        "toggle-theme",
        { dashboard: { "toggle-theme": "alt+t" } },
        "dashboard",
        baseDefaults,
      ).customized,
    ).toBe(true);
    expect(
      extractShortcutParts(
        "toggle-theme",
        { dashboard: { "toggle-theme": "alt+m" } },
        "dashboard",
        baseDefaults,
      ).customized,
    ).toBe(false);
  });

  it("keeps an empty override as an empty current command", () => {
    const parts = extractShortcutParts(
      "toggle-theme",
      { dashboard: { "toggle-theme": "" } },
      "dashboard",
      baseDefaults,
    );
    expect(parts.currentCommand).toBe("");
    expect(parts.customized).toBe(false);
    // The list still carries the blank token (split-sc of ""); the column
    // renders "-" for a blank command before reading it.
    expect(parts.currentChars).toEqual([[""]]);
  });

  it("splits a vector default into short and last parts", () => {
    const defaults = { workspace: { "group-vector": { command: ["g", "v"] } } };
    const parts = extractShortcutParts("group-vector", {}, "workspace", defaults);
    expect(parts.currentCommand).toEqual(["g", "v"]);
    expect(parts.currentChars).toEqual([["g"], ["v"]]);
    expect(parts.currentShort).toEqual([["g"]]);
    expect(parts.currentLast).toEqual(["v"]);
  });

  it("keeps the whole list as short when there is a single command", () => {
    const parts = extractShortcutParts("toggle-theme", {}, "dashboard", baseDefaults);
    expect(parts.currentShort).toEqual([["alt", "m"]]);
    expect(parts.currentLast).toEqual(["alt", "m"]);
  });

  it("leaves the default empty for a context without a registry", () => {
    const parts = extractShortcutParts(
      "undo",
      { workspace: { undo: "shift+z" } },
      "workspace",
      baseDefaults,
    );
    expect(parts.currentCommand).toBe("shift+z");
    expect(parts.customized).toBe(true);
    expect(parts.defaultChars).toEqual([]);
    expect(parts.defaultLast).toBeNull();
  });
});

describe("workspace registry", () => {
  it("splits the base set from the path-editor set", () => {
    const workspace = workspaceShortcuts(false);
    const path = pathShortcuts(false);
    expect(Object.keys(workspace)).toHaveLength(120);
    expect(Object.keys(path)).toHaveLength(19);
    expect(path["move-nodes"].subsections).toEqual(["path-editor"]);
    expect(Object.values(path).every((row) => row.subsections[0] === "path-editor")).toBe(true);
  });

  it("keeps the commands the CLJS helpers build", () => {
    const workspace = workspaceShortcuts(false);
    expect(workspace["undo"].command).toBe("ctrl+z");
    expect(workspace["redo"].command).toEqual(["ctrl+shift+z", "ctrl+y"]);
    expect(workspace["opacity-0"].command).toEqual(["0", "num0"]);
    expect(workspace["toggle-layers"].command).toBe("alt+l");
    expect(workspace["toggle-history"].command).toBe("ctrl+alt+h");
  });

  it("drops the basics subsection like the page builder", () => {
    expect(workspaceShortcuts(false)["toggle-theme"].subsections).toEqual(["generic"]);
    expect(workspaceShortcuts(false)["plugins"].subsections).toEqual(["generic"]);
  });

  it("leaves the runtime-only path overrides out of the tree", () => {
    const path = pathShortcuts(false);
    for (const key of ["escape", "start-editing", "undo", "increase-zoom", "move-unit-up"]) {
      expect(path[key]).toBeUndefined();
    }
  });

  it("marks the base paste row non-customizable", () => {
    expect(workspaceShortcuts(false)["paste"].customizable).toBe(false);
    expect(pathShortcuts(false)["paste"].customizable).toBe(true);
  });

  it("lists the customizable keys of both registries", () => {
    const all = { ...workspaceShortcuts(false), ...pathShortcuts(false) };
    const customizable = Object.entries(all)
      .filter(([, definition]) => definition.customizable)
      .map(([key]) => key);
    expect([...knownWorkspaceShortcutKeys].sort()).toEqual(customizable.sort());
  });
});

describe("buildShortcutsTree", () => {
  it("builds the dashboard subtree of the base registry", () => {
    const tree = buildShortcutsTree(base, translate, {}, "dashboard");
    expect(tree.sections).toHaveLength(1);
    const section = tree.sections[0];
    expect(section.key).toBe("dashboard");
    expect(section.id).toBe("dashboard");
    expect(section.labelKey).toBe("shortcuts.section.dashboard");
    expect(section.translation).toBe("shortcuts.section.dashboard");
    expect(section.subsections).toHaveLength(1);
    const subsection = section.subsections[0];
    expect(subsection.key).toBe("generic");
    expect(subsection.id).toBe("dashboard/generic");
    expect(subsection.labelKey).toBe("shortcuts.subsection.generic");
    expect(subsection.rows).toHaveLength(1);
    const row = subsection.rows[0];
    expect(row.key).toBe("toggle-theme");
    expect(row.id).toBe("dashboard/generic/toggle-theme");
    expect(row.labelKey).toBe("shortcuts.toggle-theme");
    expect(row.command).toBe("alt+m");
    expect(row.originalCommand).toBe("alt+m");
    expect(row.customState).toBe("default");
    expect(row.customizable).toBe(true);
  });

  it("marks customized and disabled rows", () => {
    const customizedCustoms = { dashboard: { "toggle-theme": "alt+t" } };
    const customized = buildShortcutsTree(
      applyCustomOverrides(base, customizedCustoms, "dashboard"),
      translate,
      customizedCustoms,
      "dashboard",
    );
    const customizedRow = customized.sections[0].subsections[0].rows[0];
    expect(customizedRow.customState).toBe("customized");
    expect(customizedRow.command).toBe("alt+t");
    expect(customizedRow.originalCommand).toBe("alt+m");

    const disabled = buildShortcutsTree(
      base,
      translate,
      { dashboard: { "toggle-theme": "" } },
      "dashboard",
    );
    expect(disabled.sections[0].subsections[0].rows[0].customState).toBe("disabled");
  });

  it("sorts subsections and rows by their translated label", () => {
    const definitions: Record<string, ShortcutPageDefinition> = {
      "go-b": {
        labelKey: "label.b",
        command: "b",
        section: ["dashboard"],
        subsections: ["sub-b"],
      },
      "go-aa": {
        labelKey: "label.aa",
        command: "aa",
        section: ["dashboard"],
        subsections: ["sub-a"],
      },
      "go-a": {
        labelKey: "label.a",
        command: "a",
        section: ["dashboard"],
        subsections: ["sub-a"],
      },
    };
    const tree = buildShortcutsTree(
      definitions,
      (key) => key.replace("label.", ""),
      {},
      "dashboard",
    );
    const section = tree.sections[0];
    expect(section.subsections.map((subsection) => subsection.key)).toEqual(["sub-a", "sub-b"]);
    expect(section.subsections[0].rows.map((row) => row.key)).toEqual(["go-a", "go-aa"]);
    expect(section.subsections[1].rows.map((row) => row.key)).toEqual(["go-b"]);
  });

  it("keeps a base row and a path row that share a shortcut key", () => {
    const entries: ShortcutDefinitionEntries = [
      ...Object.entries(workspaceShortcuts(false)),
      ...Object.entries(pathShortcuts(false)),
    ];
    const tree = buildShortcutsTree(entries, translate, {}, "workspace");
    const section = tree.sections[0];
    expect(section.key).toBe("workspace");
    expect(section.subsections.map((subsection) => subsection.key)).toEqual([
      "alignment",
      "edit",
      "generic",
      "main-menu",
      "modify-layers",
      "navigation-workspace",
      "panels",
      "path-editor",
      "shape",
      "text-editor",
      "tools",
      "zoom-workspace",
    ]);
    const rowsOf = (key: string) =>
      section.subsections.find((subsection) => subsection.key === key)?.rows ?? [];
    expect(rowsOf("edit").find((row) => row.key === "copy")?.id).toBe("workspace/edit/copy");
    expect(rowsOf("path-editor").find((row) => row.key === "copy")?.id).toBe(
      "workspace/path-editor/copy",
    );
    expect(rowsOf("path-editor")).toHaveLength(19);
  });

  it("marks both copies of a shared key as customized", () => {
    const customs = { workspace: { copy: "alt+c" } };
    const entries: ShortcutDefinitionEntries = [
      ...Object.entries(applyCustomOverrides(workspaceShortcuts(false), customs, "workspace")),
      ...Object.entries(applyCustomOverrides(pathShortcuts(false), customs, "workspace")),
    ];
    const tree = buildShortcutsTree(entries, translate, customs, "workspace");
    const copies = tree.sections[0].subsections.flatMap((subsection) =>
      subsection.rows.filter((row) => row.key === "copy"),
    );
    expect(copies).toHaveLength(2);
    for (const row of copies) {
      expect(row.customState).toBe("customized");
      expect(row.command).toBe("alt+c");
      expect(row.originalCommand).toBe("ctrl+c");
    }
  });

  it("takes the effective command and keeps the registry original", () => {
    const customs = { dashboard: { "toggle-theme": "alt+t" } };
    const tree = buildShortcutsTree(
      applyCustomOverrides(base, customs, "dashboard"),
      translate,
      customs,
      "dashboard",
    );
    const row = tree.sections[0].subsections[0].rows[0];
    expect(row.command).toBe("alt+t");
    expect(row.originalCommand).toBe("alt+m");
  });
});

describe("filterShortcutsTree / collectOpenSectionIds", () => {
  const tree = buildShortcutsTree(base, translate, {}, "dashboard");

  it("collects the ids of sections and subsections", () => {
    expect(collectOpenSectionIds(tree)).toEqual(["dashboard", "dashboard/generic"]);
  });

  it("keeps matching rows and prunes empty branches", () => {
    const byLabel = filterShortcutsTree(tree, tabRowFilter("all", "toggle"));
    expect(byLabel.sections[0].subsections[0].rows.map((row) => row.key)).toEqual([
      "toggle-theme",
    ]);

    const byCommand = filterShortcutsTree(tree, tabRowFilter("all", "ALT"));
    expect(byCommand.sections[0].subsections[0].rows).toHaveLength(1);

    const empty = filterShortcutsTree(tree, tabRowFilter("all", "zzz-nope"));
    expect(empty.sections).toHaveLength(0);
  });
});

describe("tabRowFilter", () => {
  it("personalized keeps only non-blank overrides", () => {
    const customized = buildShortcutsTree(
      base,
      translate,
      { dashboard: { "toggle-theme": "alt+t" } },
      "dashboard",
    );
    expect(
      filterShortcutsTree(customized, tabRowFilter("personalized", "")).sections,
    ).toHaveLength(1);

    const disabled = buildShortcutsTree(
      base,
      translate,
      { dashboard: { "toggle-theme": "" } },
      "dashboard",
    );
    expect(filterShortcutsTree(disabled, tabRowFilter("personalized", "")).sections).toHaveLength(
      0,
    );
    expect(filterShortcutsTree(disabled, tabRowFilter("disabled", "")).sections).toHaveLength(1);
  });

  it("still applies the search term on the personalized tab", () => {
    const tree = buildShortcutsTree(
      base,
      translate,
      { dashboard: { "toggle-theme": "alt+t" } },
      "dashboard",
    );
    expect(filterShortcutsTree(tree, tabRowFilter("personalized", "zzz")).sections).toHaveLength(
      0,
    );
    expect(
      filterShortcutsTree(tree, tabRowFilter("personalized", "toggle")).sections,
    ).toHaveLength(1);
  });
});

describe("knownShortcutKeys", () => {
  it("knows the three registries", () => {
    expect(knownShortcutKeys.dashboard).toEqual(["toggle-theme"]);
    expect(knownShortcutKeys.workspace).toBe(knownWorkspaceShortcutKeys);
    expect(knownShortcutKeys.viewer).toHaveLength(13);
    expect(knownShortcutKeys.viewer).toContain("open-workspace");
  });
});

describe("label keys", () => {
  it("resolve through the generated catalog", () => {
    const keys = [
      sectionLabelKey("dashboard"),
      subsectionLabelKey("generic"),
      shortcutLabelKey("toggle-theme"),
    ];
    for (const key of keys) {
      expect(tr(key)).not.toBe(key);
    }
  });

  it("keeps the mapped tables and falls back to the concat form", () => {
    expect(sectionLabelKey("dashboard")).toBe("shortcuts.section.dashboard");
    expect(subsectionLabelKey("path-editor")).toBe("shortcuts.subsection.path-editor");
    expect(subsectionLabelKey("mystery")).toBe("shortcuts.subsection.mystery");
  });
});

describe("exportShortcutsFilename", () => {
  const date = new Date("2026-10-09T12:34:56.000Z");

  it("scrubs the fullname and stamps the ISO date", () => {
    expect(exportShortcutsFilename("Ada Lovelace", date)).toBe(
      "penpot-shortcuts-Ada_Lovelace-2026-10-09.json",
    );
    expect(exportShortcutsFilename("Jöhn Döe!", date)).toBe(
      "penpot-shortcuts-Jhn_De-2026-10-09.json",
    );
  });

  it("falls back to user only when the fullname is missing", () => {
    expect(exportShortcutsFilename(null, date)).toBe("penpot-shortcuts-user-2026-10-09.json");
    expect(exportShortcutsFilename(undefined, date)).toBe(
      "penpot-shortcuts-user-2026-10-09.json",
    );
    expect(exportShortcutsFilename("", date)).toBe("penpot-shortcuts--2026-10-09.json");
  });
});
