"use client";

// Settings / shortcuts (F5.6). Port of app.main.ui.settings.shortcuts: the
// tab strip (all / personalized / disabled), the search bar with its
// restore-all trigger, the collapsible shortcut tree with the editable rows
// of components/shortcut-row, and the import/export footer.
//
// Scope: only the dashboard context registry is migrated
// (lib/dashboard-shortcuts), so the tree and the import diff cover the
// dashboard context, and the import validation checks the workspace and
// viewer contexts by shape only (see lib/shortcuts-page). Their registries
// arrive with their pages (F9).
//
// Deviations from the CLJS original, documented:
// - The tab strip is a local control (pp-shortcuts-tab); the shell has no ds
//   tab-switcher yet.
// - Import and export are two footer buttons; the CLJS groups them in a
//   dropdown-menu.
// - The expand-all effect runs on tree or term changes only; the CLJS effect
//   keeps open-sections in its deps, so collapsing a section on the
//   personalized/disabled tabs springs it back open.
// - Collapsed bodies unmount where the CLJS toggles the hidden attribute;
//   the visible result is the same.
// - The footer sits after the tree; the CLJS pins it to the viewport.
// - The rows get no conflicts map, like the CLJS page, which never builds
//   one (the conflict feedback happens while recording, inside the row).
// - The default open section is "dashboard": the CLJS default ([:workspace])
//   names a section the shell tree does not carry yet.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ImportShortcutsDiffModal } from "@/components/import-shortcuts-diff-modal";
import { useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { RestoreShortcutsModal } from "@/components/restore-shortcuts-modal";
import { ShortcutRow, type ShortcutContextMap } from "@/components/shortcut-row";
import { dashboardShortcutSet } from "@/lib/dashboard-shortcuts";
import { useDashboardShortcuts } from "@/lib/dashboard-shortcuts-context";
import { pickFiles, triggerDownload } from "@/lib/dom";
import { tr } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { applyCustomOverrides } from "@/lib/shortcuts";
import {
  buildShortcutsTree,
  collectOpenSectionIds,
  exportShortcutsFilename,
  filterShortcutsTree,
  importShortcutsMerge,
  tabRowFilter,
  validateImportedShortcuts,
  type ShortcutsTab,
  type ShortcutsTree,
} from "@/lib/shortcuts-page";

// str/blank? over the search term.
function isBlankTerm(term: string): boolean {
  return term.trim() === "";
}

// The CLJS open-sections default is [[:workspace]]; the shell tree carries
// the dashboard section only, so "dashboard" plays that role.
const defaultOpenSections = ["dashboard"];

interface ShortcutsTabSectionProps {
  tab: ShortcutsTab;
  tree: ShortcutsTree;
  contextShortcuts: ShortcutContextMap;
  macos: boolean;
  expandAllByDefault: boolean;
  emptyStr: string;
  hasCustomShortcuts: boolean;
  openSections: string[];
  onOpenSectionsChange: (ids: string[]) => void;
  onRestoreAll: () => void;
  onSave: (key: string, command: string, conflictKey: string | null) => void;
  onDisable: (key: string) => void;
  onReset: (key: string, defaultCommand: string | string[] | null) => void;
}

// shortcuts-tab-section*: one tab body with its local search term, the
// filtered tree and the collapsible sections.
function ShortcutsTabSection({
  tab,
  tree,
  contextShortcuts,
  macos,
  expandAllByDefault,
  emptyStr,
  hasCustomShortcuts,
  openSections,
  onOpenSectionsChange,
  onRestoreAll,
  onSave,
  onDisable,
  onReset,
}: ShortcutsTabSectionProps) {
  const [filterTerm, setFilterTerm] = useState("");

  const filtered = useMemo(
    () => filterShortcutsTree(tree, tabRowFilter(tab, filterTerm)),
    [tree, tab, filterTerm],
  );

  // expand-all: the personalized/disabled tabs open every node while the
  // term is empty. The effect re-runs when the tree or the term change; a
  // manual collapse is not overridden (see the module header).
  useEffect(() => {
    if (!expandAllByDefault || !isBlankTerm(filterTerm)) return;
    const ids = collectOpenSectionIds(filtered);
    if (ids.length === 0) return;
    onOpenSectionsChange(ids);
  }, [filtered, filterTerm, expandAllByDefault, onOpenSectionsChange]);

  const onSearchTermChange = (term: string) => {
    setFilterTerm(term);
    if (!isBlankTerm(term)) {
      // Searching opens every node of the filtered tree.
      onOpenSectionsChange(
        collectOpenSectionIds(filterShortcutsTree(tree, tabRowFilter(tab, term))),
      );
    } else if (!expandAllByDefault) {
      onOpenSectionsChange(defaultOpenSections);
    }
    // A cleared term on the expand-all tabs lands in the effect above.
  };

  const onToggleSection = (id: string) => {
    const present = openSections.includes(id);
    onOpenSectionsChange(
      present ? openSections.filter((item) => item !== id) : [...openSections, id],
    );
  };

  const emptyText =
    hasCustomShortcuts && !isBlankTerm(filterTerm) ? tr("shortcuts.no-shortcuts") : emptyStr;

  return (
    <div className="pp-shortcuts-section">
      <div className="pp-shortcuts-search-section">
        <input
          className="pp-shortcuts-search-input"
          type="text"
          value={filterTerm}
          placeholder={tr("shortcuts.title")}
          aria-label={tr("shortcuts.title")}
          autoFocus
          onChange={(event) => onSearchTermChange(event.target.value)}
        />
        {filterTerm !== "" ? (
          <button
            type="button"
            className="pp-shortcuts-search-clear"
            aria-label="shortcuts-clear-search"
            onClick={() => onSearchTermChange("")}
          >
            {"\u00D7"}
          </button>
        ) : null}
        {hasCustomShortcuts ? (
          <button type="button" className="pp-btn-secondary" onClick={onRestoreAll}>
            {tr("dashboard.restore-all-deleted-button")}
          </button>
        ) : null}
      </div>

      {filtered.sections.length > 0 ? (
        <div className="pp-shortcuts-list" aria-label={tr("shortcuts.title")}>
          {filtered.sections.map((section) => {
            const sectionVisible = openSections.includes(section.id);
            return (
              <section key={section.id} className="pp-shortcut-section">
                <h3 className="pp-shortcut-section-header">
                  <button
                    type="button"
                    className="pp-shortcut-section-title"
                    aria-expanded={sectionVisible}
                    aria-controls={section.id + "-menu"}
                    onClick={() => onToggleSection(section.id)}
                  >
                    <span aria-hidden="true">{sectionVisible ? "\u25BE" : "\u25B8"}</span>
                    <span className="pp-shortcut-section-name">{section.translation}</span>
                  </button>
                </h3>
                {sectionVisible ? (
                  <ul className="pp-shortcut-subsection-menu" id={section.id + "-menu"}>
                    {section.subsections.map((subsection) => {
                      const subsectionVisible = openSections.includes(subsection.id);
                      return (
                        <li key={subsection.id}>
                          <h4 className="pp-shortcut-subsection-header">
                            <button
                              type="button"
                              className="pp-shortcut-subsection-title"
                              aria-expanded={subsectionVisible}
                              aria-controls={subsection.id + "-menu"}
                              onClick={() => onToggleSection(subsection.id)}
                            >
                              <span aria-hidden="true">
                                {subsectionVisible ? "\u25BE" : "\u25B8"}
                              </span>
                              <span className="pp-shortcut-subsection-name">
                                {subsection.translation}
                              </span>
                            </button>
                          </h4>
                          {subsectionVisible ? (
                            <ul className="pp-shortcut-sub-menu" id={subsection.id + "-menu"}>
                              {subsection.rows.map((row) => (
                                <ShortcutRow
                                  key={row.id}
                                  row={row}
                                  contextShortcuts={contextShortcuts}
                                  editable
                                  macos={macos}
                                  onSave={onSave}
                                  onDisable={onDisable}
                                  onReset={onReset}
                                />
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="pp-shortcuts-empty-state">{emptyText}</div>
      )}
    </div>
  );
}

function emptyStrForTab(tab: ShortcutsTab): string {
  switch (tab) {
    case "all":
      return tr("shortcuts.no-shortcuts");
    case "personalized":
      return tr("shortcuts.no-personalized");
    case "disabled":
      return tr("shortcuts.no-disabled");
  }
}

export default function SettingsShortcutsPage() {
  const { profile } = useSession();
  const {
    customShortcuts,
    macos,
    setCustomShortcut,
    resetCustomShortcut,
    resetAllCustomShortcuts,
    persistCustomShortcuts,
  } = useDashboardShortcuts();
  const modal = useModal();
  const notifications = useNotifications();

  const [tab, setTab] = useState<ShortcutsTab>("all");
  const [openSectionsByTab, setOpenSectionsByTab] = useState<Record<string, string[]>>({});

  // The base set (dsc/shortcuts) with the overrides applied: what the tree
  // renders and what the restore table lists as defaults.
  const defaults = useMemo(() => dashboardShortcutSet("base", macos), [macos]);

  // Only the dashboard registry is migrated; the other two contexts stay
  // absent, and the modals draw "-" for their unknown defaults.
  const contextDefaults = useMemo(() => ({ dashboard: defaults }), [defaults]);

  const tree = useMemo(
    () =>
      buildShortcutsTree(
        applyCustomOverrides(defaults, customShortcuts, "dashboard"),
        (key) => tr(key),
        customShortcuts,
        "dashboard",
      ),
    [defaults, customShortcuts],
  );

  // (some #(seq (val %)) custom-shortcuts): any override, in any context.
  const hasCustomShortcuts = useMemo(
    () => Object.values(customShortcuts).some((group) => Object.keys(group).length > 0),
    [customShortcuts],
  );

  const openSections = openSectionsByTab[tab] ?? defaultOpenSections;

  const updateOpenSections = useCallback(
    (ids: string[]) => {
      setOpenSectionsByTab((prev) => ({ ...prev, [tab]: ids }));
    },
    [tab],
  );

  const onRestoreAll = () => {
    modal.open(
      <RestoreShortcutsModal
        customShortcuts={customShortcuts}
        defaults={contextDefaults}
        macos={macos}
        onRestore={resetAllCustomShortcuts}
      />,
    );
  };

  const onImportFile = async () => {
    const files = await pickFiles({ accept: ".json,application/json" });
    const file = files?.[0] ?? null;
    if (file === null) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const validation = validateImportedShortcuts(parsed);
      if (!validation.valid) {
        notifications.error(tr("errors.invalid-data"));
        return;
      }
      const imported = parsed as Record<string, Record<string, string> | undefined>;
      modal.open(
        <ImportShortcutsDiffModal
          imported={imported}
          customShortcuts={customShortcuts}
          defaults={contextDefaults}
          macos={macos}
          onApply={() => {
            persistCustomShortcuts(importShortcutsMerge(imported, customShortcuts, contextDefaults));
          }}
        />,
      );
    } catch {
      // Parse errors take the same notification as validation errors, like
      // the CLJS try/catch.
      notifications.error(tr("errors.invalid-data"));
    }
  };

  const onExport = () => {
    if (!hasCustomShortcuts) return;
    // The CLJS json/encode over the profile value with d/name keys; the
    // shell customs are already string-keyed plain objects.
    const blob = new Blob([JSON.stringify(customShortcuts, null, 2)], {
      type: "application/json",
    });
    triggerDownload(exportShortcutsFilename(profile?.fullname ?? null, new Date()), blob);
  };

  const tabs: Array<{ id: ShortcutsTab; label: string; testId?: string }> = [
    { id: "all", label: tr("labels.all") },
    { id: "personalized", label: tr("shortcuts.personalized"), testId: "personalized" },
    { id: "disabled", label: tr("shortcuts.disabled"), testId: "disabled" },
  ];

  return (
    <section className="pp-dashboard-settings" aria-labelledby="shortcuts-section-title">
      <div className="pp-form-container">
        <h2 id="shortcuts-section-title">{tr("label.shortcuts")}</h2>
        <p className="pp-shortcuts-description">{tr("shortcuts.reload-hint")}</p>

        <div className="pp-shortcuts-tabs" role="tablist" aria-label={tr("shortcuts.page")}>
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              data-testid={item.testId}
              className={tab === item.id ? "pp-shortcuts-tab selected" : "pp-shortcuts-tab"}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <ShortcutsTabSection
          key={tab}
          tab={tab}
          tree={tree}
          contextShortcuts={defaults}
          macos={macos}
          expandAllByDefault={tab !== "all"}
          emptyStr={emptyStrForTab(tab)}
          hasCustomShortcuts={hasCustomShortcuts}
          openSections={openSections}
          onOpenSectionsChange={updateOpenSections}
          onRestoreAll={onRestoreAll}
          onSave={(key, command, conflictKey) => setCustomShortcut(key, command, conflictKey)}
          onDisable={(key) => setCustomShortcut(key, "", null)}
          onReset={(key, defaultCommand) => resetCustomShortcut(key, defaultCommand)}
        />

        <footer className="pp-shortcuts-footer">
          <div className="pp-shortcuts-info">
            <div className="pp-shortcuts-info-wrapper">
              <span className="pp-shortcuts-customized-dot" aria-hidden="true" />
              <p className="pp-shortcuts-text">{tr("shortcuts.personalized")}</p>
            </div>
            <div className="pp-shortcuts-info-wrapper">
              <span className="pp-shortcuts-detach-icon" aria-hidden="true">
                {"\u26D3"}
              </span>
              <p className="pp-shortcuts-text">{tr("shortcuts.disabled")}</p>
            </div>
          </div>

          <div className="pp-shortcuts-footer-actions">
            <button
              type="button"
              className="pp-btn-secondary"
              onClick={() => {
                void onImportFile();
              }}
            >
              {tr("labels.import")}
            </button>
            {hasCustomShortcuts ? (
              <button type="button" className="pp-btn-secondary" onClick={onExport}>
                {tr("labels.export")}
              </button>
            ) : null}
          </div>
        </footer>
      </div>
    </section>
  );
}
