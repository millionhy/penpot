// Settings / shortcuts page logic (F5.6). Headless port of what the
// settings/shortcuts page and its two modals keep outside their views:
// - app.main.ui.settings.shortcuts: filter-shortcuts-tree,
//   collect-open-section-ids, known-shortcut-keys, validate-imported-shortcuts,
//   the three tab filters and the export filename.
// - app.main.ui.shortcuts: translation-keyname (the section/subsection label
//   tables), add-translation, build-all-shortcuts-without-basics (the tree
//   walk and the original-command capture), import-context-group,
//   import-custom-shortcuts and shortcut->command-string.
// - app.main.ui.settings.restore-shortcuts-modal: extract-shortcut-keys.
// - app.main.ui.settings.import-shortcuts-diff-modal: compute-diff.
// - app.util.strings: matches-search.
//
// i18n keys travel in labelKey fields; scripts/extract-translations.mjs scans
// them via trFieldRe. Do not spell the pattern out in prose here, the regex is
// not comment-aware.
//
// Scope: the shell has no workspace/viewer shortcut registries yet (those
// pages are not migrated), so the settings page renders the dashboard context
// only, and the import validation checks the workspace/viewer contexts by
// shape only. The data model carries all three contexts, so migrating the
// registries later only fills values in.
//
// Deviations from the CLJS original, documented:
// - validate-imported-shortcuts rejects unknown keys only for the dashboard
//   context (the base registry lives in the shell); workspace/viewer keys
//   pass a shape-only check. Error messages are plain strings where the CLJS
//   app prints malli-humanized output; the error paths match the original.
// - compute-shortcuts-diff and extract-shortcut-keys fall back to a null
//   default for workspace/viewer keys the shell cannot know, where the CLJS
//   app reads the full registries (the tables render those as "-").
// - filter-shortcuts-tree takes a ready row predicate instead of the
//   (filter key node search-term) triple: the shell tree is a typed structure
//   and the three tab filters live in tabRowFilter.

import { dashboardShortcutSet } from "@/lib/dashboard-shortcuts";
import {
  findConflict,
  shortcutCommandString,
  splitSc,
  type CustomShortcuts,
  type ShortcutDefinitionShape,
} from "@/lib/shortcuts";

// --- Search (app.util.strings/matches-search) ------------------------------

// matches-search: case-insensitive substring match, trimming both sides; an
// empty (or missing) term matches everything.
export function matchesSearch(
  name: string | null | undefined,
  term: string | null | undefined,
): boolean {
  if (term === null || term === undefined || term === "") return true;
  return (name ?? "").trim().toLowerCase().includes(term.trim().toLowerCase());
}

// cuerdas str/blank?: nil, "" and whitespace-only strings.
function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

// --- Labels (ui/shortcuts.cljs translation-keyname) ------------------------

const sectionDefinitions: Record<string, { labelKey: string }> = {
  basics: { labelKey: "shortcuts.section.basics" },
  workspace: { labelKey: "shortcuts.section.workspace" },
  dashboard: { labelKey: "shortcuts.section.dashboard" },
  viewer: { labelKey: "shortcuts.section.viewer" },
};

const subsectionDefinitions: Record<string, { labelKey: string }> = {
  alignment: { labelKey: "shortcuts.subsection.alignment" },
  edit: { labelKey: "shortcuts.subsection.edit" },
  generic: { labelKey: "shortcuts.subsection.generic" },
  "main-menu": { labelKey: "shortcuts.subsection.main-menu" },
  "modify-layers": { labelKey: "shortcuts.subsection.modify-layers" },
  "navigation-dashboard": { labelKey: "shortcuts.subsection.navigation-dashboard" },
  "navigation-viewer": { labelKey: "shortcuts.subsection.navigation-viewer" },
  "navigation-workspace": { labelKey: "shortcuts.subsection.navigation-workspace" },
  panels: { labelKey: "shortcuts.subsection.panels" },
  "path-editor": { labelKey: "shortcuts.subsection.path-editor" },
  shape: { labelKey: "shortcuts.subsection.shape" },
  "text-editor": { labelKey: "shortcuts.subsection.text-editor" },
  tools: { labelKey: "shortcuts.subsection.tools" },
  "zoom-viewer": { labelKey: "shortcuts.subsection.zoom-viewer" },
  "zoom-workspace": { labelKey: "shortcuts.subsection.zoom-workspace" },
};

// translation-keyname: the i18n key of a section/subsection/shortcut; the
// tables cover the migrated names, the fallback mirrors the CLJS concat.
export function sectionLabelKey(name: string): string {
  return sectionDefinitions[name]?.labelKey ?? "shortcuts.section." + name;
}

export function subsectionLabelKey(name: string): string {
  return subsectionDefinitions[name]?.labelKey ?? "shortcuts.subsection." + name;
}

export function shortcutLabelKey(key: string): string {
  return "shortcuts." + key;
}

// --- Tree (build-all-shortcuts-without-basics) -----------------------------

// A shortcut definition as it reaches the tree: the dashboard registry
// definitions plus the group metadata the tree walk needs. The command is the
// effective one (applyCustomOverrides already ran), originalCommand the
// registry default.
export interface ShortcutPageDefinition extends ShortcutDefinitionShape {
  labelKey?: string;
  section?: readonly string[];
  subsections?: readonly string[];
  customizable?: boolean;
}

// shortcut-row*'s customized? is a plain membership test over the group map;
// a member whose command is blank renders as disabled, everything else as a
// customized binding.
export type ShortcutCustomState = "default" | "customized" | "disabled";

export interface ShortcutTreeRow {
  key: string;
  id: string;
  labelKey: string;
  translation: string;
  command: string | string[] | null;
  originalCommand: string | string[] | null;
  customState: ShortcutCustomState;
  customizable: boolean;
}

export interface ShortcutTreeSubsection {
  key: string;
  id: string;
  labelKey: string;
  translation: string;
  rows: ShortcutTreeRow[];
}

export interface ShortcutTreeSection {
  key: string;
  id: string;
  labelKey: string;
  translation: string;
  subsections: ShortcutTreeSubsection[];
}

export interface ShortcutsTree {
  sections: ShortcutTreeSection[];
}

// The CLJS tree ids are vectors ([:dashboard :generic]); the shell uses
// "dashboard/generic" strings in the same role: membership tests against the
// open-sections list and react keys.
function customStateOf(customValue: string | undefined): ShortcutCustomState {
  if (customValue === undefined) return "default";
  return isBlank(customValue) ? "disabled" : "customized";
}

function byTranslation(a: { translation: string }, b: { translation: string }): number {
  if (a.translation < b.translation) return -1;
  if (a.translation > b.translation) return 1;
  return 0;
}

// build-all-shortcuts-without-basics: groups definitions into
// section -> subsection -> rows, translating labels and sorting subsections
// and rows by their translated name (the CLJS sorted-map-of-translations
// walk). Rows keep the effective command plus the registry original.
export function buildShortcutsTree(
  definitions: Record<string, ShortcutPageDefinition>,
  translate: (key: string) => string,
  customs: CustomShortcuts,
  groupKey: string,
): ShortcutsTree {
  const groupMap: Record<string, string> = customs[groupKey] ?? {};
  const sections = new Map<string, Map<string, ShortcutTreeRow[]>>();

  for (const [key, definition] of Object.entries(definitions)) {
    const sectionKey = definition.section?.[0] ?? "workspace";
    const labelKey = definition.labelKey ?? shortcutLabelKey(key);
    const row: ShortcutTreeRow = {
      key,
      id: "",
      labelKey,
      translation: translate(labelKey),
      command: definition.showCommand ?? definition.command ?? null,
      originalCommand: definition.originalCommand ?? definition.command ?? null,
      customState: customStateOf(groupMap[key]),
      customizable: definition.customizable !== false,
    };
    for (const subsectionKey of definition.subsections ?? []) {
      let subsectionMap = sections.get(sectionKey);
      if (subsectionMap === undefined) {
        subsectionMap = new Map();
        sections.set(sectionKey, subsectionMap);
      }
      let rows = subsectionMap.get(subsectionKey);
      if (rows === undefined) {
        rows = [];
        subsectionMap.set(subsectionKey, rows);
      }
      rows.push({ ...row, id: sectionKey + "/" + subsectionKey + "/" + key });
    }
  }

  const out: ShortcutTreeSection[] = [];
  for (const [sectionKey, subsectionMap] of sections) {
    const subsections: ShortcutTreeSubsection[] = [];
    for (const [subsectionKey, rows] of subsectionMap) {
      rows.sort(byTranslation);
      const labelKey = subsectionLabelKey(subsectionKey);
      subsections.push({
        key: subsectionKey,
        id: sectionKey + "/" + subsectionKey,
        labelKey,
        translation: translate(labelKey),
        rows,
      });
    }
    subsections.sort(byTranslation);
    out.push({
      key: sectionKey,
      id: sectionKey,
      labelKey: sectionLabelKey(sectionKey),
      translation: translate(sectionLabelKey(sectionKey)),
      subsections,
    });
  }
  return { sections: out };
}

// filter-shortcuts-tree: keeps rows the predicate accepts and prunes a
// subsection/section whose children all went away.
export function filterShortcutsTree(
  tree: ShortcutsTree,
  rowFilter: (row: ShortcutTreeRow) => boolean,
): ShortcutsTree {
  const sections: ShortcutTreeSection[] = [];
  for (const section of tree.sections) {
    const subsections: ShortcutTreeSubsection[] = [];
    for (const subsection of section.subsections) {
      const rows = subsection.rows.filter(rowFilter);
      if (rows.length > 0) subsections.push({ ...subsection, rows });
    }
    if (subsections.length > 0) sections.push({ ...section, subsections });
  }
  return { sections };
}

// collect-open-section-ids: the ids of every node that has children (sections
// and subsections), used by expand-all and by search.
export function collectOpenSectionIds(tree: ShortcutsTree): string[] {
  const ids: string[] = [];
  for (const section of tree.sections) {
    if (section.subsections.length > 0) ids.push(section.id);
    for (const subsection of section.subsections) {
      if (subsection.rows.length > 0) ids.push(subsection.id);
    }
  }
  return ids;
}

// --- Tab filters (settings/shortcuts.cljs filter-all et al.) ---------------

export type ShortcutsTab = "all" | "personalized" | "disabled";

// The three tab filters as one row predicate: match is by translated name or
// command string; the personalized/disabled tabs additionally require the
// row's custom state (customized = a non-blank override, disabled = a blank
// one) and a customizable definition.
export function tabRowFilter(
  tab: ShortcutsTab,
  searchTerm: string | null | undefined,
): (row: ShortcutTreeRow) => boolean {
  const search = (row: ShortcutTreeRow): boolean =>
    isBlank(searchTerm) ||
    matchesSearch(row.translation, searchTerm) ||
    matchesSearch(shortcutCommandString({ command: row.command ?? undefined }), searchTerm);

  return (row) => {
    switch (tab) {
      case "all":
        return search(row);
      case "personalized":
        return row.customizable && row.customState === "customized" && search(row);
      case "disabled":
        return row.customizable && row.customState === "disabled" && search(row);
    }
  };
}

// --- Import validation (settings/shortcuts.cljs) ---------------------------

export interface ImportValidationError {
  path: string;
  message: string;
}

export type ImportValidationResult =
  | { valid: true }
  | { valid: false; errors: ImportValidationError[] };

export const shortcutContexts = ["workspace", "dashboard", "viewer"] as const;

export type ShortcutContext = (typeof shortcutContexts)[number];

// Known shortcut keys per context; a null entry means the registry is not
// migrated yet and the context passes a shape-only check.
export type KnownShortcutKeys = Record<string, readonly string[] | null>;

// known-shortcut-keys: the keys of the default registries, minus definitions
// marked customizable:false. The dashboard entry is the base set
// (= dsc/shortcuts).
export const knownShortcutKeys: KnownShortcutKeys = {
  workspace: null,
  dashboard: Object.keys(dashboardShortcutSet("base", false)),
  viewer: null,
};

// JSON values only: rejects arrays, dates, sets and functions, so a parsed
// payload with unexpected shapes fails validation instead of crashing later.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// validate-imported-shortcuts: shape check of a parsed custom-shortcuts
// payload. The top level is a closed map of the three contexts; each context
// maps known shortcut keys to command strings (an empty string legally
// disables the binding). Never throws.
export function validateImportedShortcuts(
  data: unknown,
  knownKeys: KnownShortcutKeys = knownShortcutKeys,
): ImportValidationResult {
  if (!isPlainObject(data)) {
    return {
      valid: false,
      errors: [{ path: "", message: "Expected a map of shortcut contexts" }],
    };
  }

  const errors: ImportValidationError[] = [];
  for (const context of Object.keys(data)) {
    if (!(shortcutContexts as readonly string[]).includes(context)) {
      errors.push({ path: context, message: "Unknown shortcut context" });
    }
  }
  for (const context of shortcutContexts) {
    const value = data[context];
    if (value === undefined) continue;
    if (!isPlainObject(value)) {
      errors.push({ path: context, message: "Expected a map of shortcut commands" });
      continue;
    }
    const known = knownKeys[context] ?? null;
    for (const [key, command] of Object.entries(value)) {
      if (known !== null && !known.includes(key)) {
        errors.push({ path: context + "/" + key, message: "Unknown shortcut key" });
      }
      if (typeof command !== "string") {
        errors.push({ path: context + "/" + key, message: "Expected a string command" });
      }
    }
  }

  if (errors.length === 0) return { valid: true };
  return { valid: false, errors };
}

// --- Import diff (import-shortcuts-diff-modal.cljs compute-diff) -----------

export interface ShortcutDiffEntry {
  context: string;
  key: string;
  current: string | string[] | null;
  imported: string;
  customized: boolean;
}

// The registry defaults of a context; null when the registry is not migrated.
export type ShortcutDefaults = Record<
  string,
  Record<string, ShortcutPageDefinition> | null | undefined
>;

// compute-diff: the imported bindings that differ from what is effective now
// (custom override, else registry default). customized? marks the current
// value as a non-blank override that differs from the default.
export function computeShortcutsDiff(
  imported: Record<string, Record<string, string> | undefined>,
  customs: CustomShortcuts,
  defaults: ShortcutDefaults,
): ShortcutDiffEntry[] {
  const entries: ShortcutDiffEntry[] = [];
  for (const context of shortcutContexts) {
    const importedGroup = imported[context];
    if (importedGroup === undefined || importedGroup === null) continue;
    const currentGroup: Record<string, string> = customs[context] ?? {};
    const defaultsGroup = defaults[context] ?? null;
    for (const [key, importedBinding] of Object.entries(importedGroup)) {
      const currentBinding: string | undefined = currentGroup[key];
      const defaultCommand = defaultsGroup?.[key]?.command ?? null;
      const effective = currentBinding ?? defaultCommand;
      const customized =
        currentBinding !== undefined &&
        currentBinding !== null &&
        currentBinding !== "" &&
        currentBinding !== (defaultCommand as string | string[] | null);
      if (effective !== importedBinding) {
        entries.push({
          context,
          key,
          current: effective ?? null,
          imported: importedBinding,
          customized,
        });
      }
    }
  }
  return entries;
}

const contextOrder: Record<string, number> = { workspace: 0, dashboard: 1, viewer: 2 };

// The diff modal order: by context (workspace, dashboard, viewer), then by
// shortcut key.
export function sortShortcutDiffEntries(entries: ShortcutDiffEntry[]): ShortcutDiffEntry[] {
  return [...entries].sort((a, b) => {
    const order = (contextOrder[a.context] ?? 99) - (contextOrder[b.context] ?? 99);
    if (order !== 0) return order;
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
  });
}

// context-name: the hardcoded table of the diff modal (not translated in the
// CLJS original either).
export function contextDisplayName(context: string): string {
  switch (context) {
    case "workspace":
      return "Workspace";
    case "dashboard":
      return "Dashboard";
    case "viewer":
      return "Viewer";
    default:
      return context;
  }
}

// --- Import merge (ui/shortcuts.cljs import-custom-shortcuts) --------------

// import-context-group: the custom-shortcuts map of one imported context. A
// default shortcut whose command collides with an imported one is disabled
// (""), and so is an earlier entry of the same batch that holds a duplicate
// command; later duplicates survive.
export function importContextGroup(
  group: Record<string, string>,
  contextShortcuts: Record<string, ShortcutPageDefinition>,
): Record<string, string> {
  let acc: Record<string, string> = {};
  for (const [command, recordedCommand] of Object.entries(group)) {
    const defaultConflict = findConflict(recordedCommand, contextShortcuts, command);
    let batchConflict: string | null = null;
    for (const [existingKey, existingCommand] of Object.entries(acc)) {
      if (existingKey !== command && existingCommand === recordedCommand) {
        batchConflict = existingKey;
        break;
      }
    }
    acc = { ...acc, [command]: recordedCommand };
    if (defaultConflict !== null) acc = { ...acc, [defaultConflict.key]: "" };
    if (batchConflict !== null) acc = { ...acc, [batchConflict]: "" };
  }
  return acc;
}

// import-custom-shortcuts: replaces each imported context wholesale (an empty
// map clears it) and keeps the contexts the payload does not mention. The
// conflict baseline per context is the registry with the current overrides
// already applied (contextShortcuts).
export function importShortcutsMerge(
  imported: Record<string, Record<string, string> | undefined>,
  currentCustoms: CustomShortcuts,
  contextShortcuts: Record<
    string,
    Record<string, ShortcutPageDefinition> | null | undefined
  >,
): CustomShortcuts {
  const next: CustomShortcuts = { ...currentCustoms };
  for (const context of shortcutContexts) {
    const group = imported[context];
    if (group === undefined || group === null) continue;
    next[context] = importContextGroup(group, contextShortcuts[context] ?? {});
  }
  return next;
}

// --- Restore parts (restore-shortcuts-modal.cljs extract-shortcut-keys) ----

export interface ShortcutParts {
  defaultChars: string[][];
  defaultLast: string[] | null;
  defaultShort: string[][];
  currentCommand: string | string[] | null;
  currentChars: string[][];
  currentLast: string[] | null;
  currentShort: string[][];
  customized: boolean;
}

// split-sc over a command: a vector command (alternative bindings or a key
// sequence) keeps its parts, a string command becomes one part, a missing
// command an empty list (the shell prints "-" for it).
function shortcutCharsList(command: string | string[] | null | undefined): string[][] {
  if (command === null || command === undefined) return [];
  const parts = Array.isArray(command) ? command : [command];
  return parts.map((part) => splitSc(part));
}

// extract-shortcut-keys: everything the restore table shows for one key. The
// current command is the custom override when present (an empty override
// stays empty: it is truthy in CLJS, and the table draws "-" for it), the
// registry default otherwise. customized? needs a non-blank override that
// differs from the default.
export function extractShortcutParts(
  shortcutKey: string,
  customs: CustomShortcuts,
  context: string,
  defaults: ShortcutDefaults,
): ShortcutParts {
  const defaultCommand = defaults[context]?.[shortcutKey]?.command ?? null;
  const customValue: string | undefined = customs[context]?.[shortcutKey];
  const currentCommand = customValue ?? defaultCommand;
  const customized =
    customValue !== undefined &&
    customValue !== null &&
    customValue !== "" &&
    customValue !== (defaultCommand as string | string[] | null);

  const defaultChars = shortcutCharsList(defaultCommand);
  const currentChars = shortcutCharsList(currentCommand);
  return {
    defaultChars,
    defaultLast: defaultChars.length > 0 ? defaultChars[defaultChars.length - 1] : null,
    defaultShort: defaultChars.length <= 1 ? defaultChars : defaultChars.slice(0, -1),
    currentCommand,
    currentChars,
    currentLast: currentChars.length > 0 ? currentChars[currentChars.length - 1] : null,
    currentShort: currentChars.length <= 1 ? currentChars : currentChars.slice(0, -1),
    customized,
  };
}

// --- Export (settings/shortcuts.cljs on-export) ----------------------------

// The export filename: "penpot-shortcuts-<fullname>-<date>.json". The name is
// scrubbed to [a-zA-Z0-9-_ ] with runs of whitespace folded to "_"; a missing
// fullname falls back to "user" (an empty one stays empty, like the CLJS or).
export function exportShortcutsFilename(
  fullname: string | null | undefined,
  date: Date,
): string {
  const name = (fullname ?? "user").replace(/[^a-zA-Z0-9\-_ ]/g, "").replace(/\s+/g, "_");
  return "penpot-shortcuts-" + name + "-" + date.toISOString().slice(0, 10) + ".json";
}
