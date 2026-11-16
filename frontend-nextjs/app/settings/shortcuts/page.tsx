"use client";

// Settings / shortcuts (F5.6). Port of app.main.ui.settings.shortcuts: the
// tab strip (all / personalized / disabled), the search bar with its
// restore-all trigger, the collapsible shortcut tree with the editable rows
// of components/shortcut-row, and the import/export footer.
//
// Scope: all three contexts are migrated (lib/workspace-shortcuts,
// lib/dashboard-shortcuts, lib/viewer-shortcuts), so the tree carries the
// workspace, dashboard and viewer sections, and the import validation knows
// every key (see lib/shortcuts-page).
//
// Deviations from the CLJS original, documented:
// - The tab strip and the search bar are local controls
//   (pp-shortcuts-tab, pp-shortcuts-search-*); the shell has no ds
//   tab-switcher or search-bar, so they copy the ds geometry instead of the
//   components.
// - The import/export dropdown reuses the dashboard menu (DashboardMenu),
//   which opens 4px from its trigger where the CLJS menu uses 6px.
// - The expand-all effect runs on tree or term changes only; the CLJS effect
//   keeps open-sections in its deps, so collapsing a section on the
//   personalized/disabled tabs springs it back open.
// - Collapsed bodies unmount where the CLJS toggles the hidden attribute;
//   the visible result is the same.
// - The footer is fixed to the viewport like the CLJS one, but the page keeps
//   its own bottom padding instead of reserving room for it.
// - The rows get no conflicts map, like the CLJS page, which never builds
//   one (the conflict feedback happens while recording, inside the row).
// - The tree is the concatenation of three per-context builds. The CLJS
//   builder takes the four maps at once and reads one custom-shortcuts group
//   per row; here each build gets the group its rows belong to, and the
//   workspace one gets an ordered entry list so the path-editor rows survive
//   next to the base rows that share their keys.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DashboardMenu,
  menuAnchorFromElement,
  type MenuAnchor,
  type MenuEntry,
} from "@/components/dashboard-menu";
import { ImportShortcutsDiffModal } from "@/components/import-shortcuts-diff-modal";
import { useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { RestoreShortcutsModal } from "@/components/restore-shortcuts-modal";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  BrokenLinkIcon,
  DeleteTextIcon,
  ImportExportIcon,
  InfoIcon,
  ReloadIcon,
  SearchIcon,
} from "@/components/settings-icons";
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
  type ShortcutDefinitionEntries,
  type ShortcutsTab,
  type ShortcutsTree,
} from "@/lib/shortcuts-page";
import { viewerShortcuts } from "@/lib/viewer-shortcuts";
import { pathShortcuts, workspaceShortcuts } from "@/lib/workspace-shortcuts";

// str/blank? over the search term.
function isBlankTerm(term: string): boolean {
  return term.trim() === "";
}

// The CLJS open-sections default is [[:workspace]].
const defaultOpenSections = ["workspace"];

interface ShortcutsTabSectionProps {
  tab: ShortcutsTab;
  tree: ShortcutsTree;
  sectionShortcuts: Record<string, ShortcutContextMap>;
  macos: boolean;
  expandAllByDefault: boolean;
  emptyStr: string;
  hasCustomShortcuts: boolean;
  openSections: string[];
  onOpenSectionsChange: (ids: string[]) => void;
  onRestoreAll: () => void;
  onSave: (group: string, key: string, command: string, conflictKey: string | null) => void;
  onDisable: (group: string, key: string) => void;
  onReset: (group: string, key: string, defaultCommand: string | string[] | null) => void;
}

// shortcuts-tab-section*: one tab body with its local search term, the
// filtered tree and the collapsible sections.
function ShortcutsTabSection({
  tab,
  tree,
  sectionShortcuts,
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
        <div className="pp-shortcuts-search-box">
          <div className="pp-shortcuts-search-input-wrapper">
            <span className="pp-shortcuts-icon-box">
              <SearchIcon small />
            </span>
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
                <span className="pp-shortcuts-icon-box">
                  <DeleteTextIcon small />
                </span>
              </button>
            ) : null}
          </div>
        </div>
        {hasCustomShortcuts ? (
          <button
            type="button"
            className="pp-btn-secondary pp-shortcuts-restore-button"
            onClick={onRestoreAll}
          >
            <ReloadIcon />
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
                    <span className="pp-shortcuts-icon-box">
                      {sectionVisible ? <ArrowDownIcon small /> : <ArrowRightIcon small />}
                    </span>
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
                              <span className="pp-shortcuts-icon-box">
                                {subsectionVisible ? (
                                  <ArrowDownIcon small />
                                ) : (
                                  <ArrowRightIcon small />
                                )}
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
                                  contextShortcuts={sectionShortcuts[section.key] ?? {}}
                                  editable
                                  macos={macos}
                                  onSave={(key, command, conflictKey) =>
                                    onSave(section.key, key, command, conflictKey)
                                  }
                                  onDisable={(key) => onDisable(section.key, key)}
                                  onReset={(key, defaultCommand) =>
                                    onReset(section.key, key, defaultCommand)
                                  }
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
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);

  // The three registries (dsc/shortcuts; wsc/shortcuts + psc/shortcuts;
  // vsc/shortcuts) with the overrides applied: what the tree renders and what
  // the restore/import modals list as defaults.
  const dashboardDefaults = useMemo(() => dashboardShortcutSet("base", macos), [macos]);
  const workspaceDefaults = useMemo(() => workspaceShortcuts(macos), [macos]);
  const pathDefaults = useMemo(() => pathShortcuts(macos), [macos]);
  const viewerDefaults = useMemo(() => viewerShortcuts(macos), [macos]);

  // The conflict search of a workspace row spans both registries, and the
  // modals read one map per context (the CLJS all-shortcuts-raw).
  const workspaceMerged = useMemo(
    () => ({ ...workspaceDefaults, ...pathDefaults }),
    [workspaceDefaults, pathDefaults],
  );

  const contextDefaults = useMemo(
    () => ({
      workspace: workspaceMerged,
      dashboard: dashboardDefaults,
      viewer: viewerDefaults,
    }),
    [workspaceMerged, dashboardDefaults, viewerDefaults],
  );

  const sectionShortcuts = useMemo<Record<string, ShortcutContextMap>>(
    () => ({
      workspace: workspaceMerged,
      dashboard: dashboardDefaults,
      viewer: viewerDefaults,
    }),
    [workspaceMerged, dashboardDefaults, viewerDefaults],
  );

  const tree = useMemo<ShortcutsTree>(() => {
    // build-all-shortcuts-without-basics: the workspace section merges the
    // base and the path map per subsection, so its entries are concatenated.
    // Seven keys live in both maps under different subsections, and a Record
    // would keep one of them.
    const workspaceEntries: ShortcutDefinitionEntries = [
      ...Object.entries(applyCustomOverrides(workspaceDefaults, customShortcuts, "workspace")),
      ...Object.entries(applyCustomOverrides(pathDefaults, customShortcuts, "workspace")),
    ];
    const translate = (key: string) => tr(key);
    return {
      sections: [
        ...buildShortcutsTree(workspaceEntries, translate, customShortcuts, "workspace")
          .sections,
        ...buildShortcutsTree(
          applyCustomOverrides(dashboardDefaults, customShortcuts, "dashboard"),
          translate,
          customShortcuts,
          "dashboard",
        ).sections,
        ...buildShortcutsTree(
          applyCustomOverrides(viewerDefaults, customShortcuts, "viewer"),
          translate,
          customShortcuts,
          "viewer",
        ).sections,
      ],
    };
  }, [workspaceDefaults, pathDefaults, dashboardDefaults, viewerDefaults, customShortcuts]);

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

  // dropdown-menu*: the footer groups import and export behind one trigger,
  // and the CLJS only lists the export entry when there is something to
  // export.
  const menuEntries: MenuEntry[] = [
    {
      type: "item",
      id: "import",
      label: tr("labels.import"),
      onSelect: () => {
        void onImportFile();
      },
    },
    ...(hasCustomShortcuts
      ? [
          {
            type: "item" as const,
            id: "export",
            label: tr("labels.export"),
            onSelect: onExport,
          },
        ]
      : []),
  ];

  return (
    <section
      className="pp-dashboard-settings pp-dashboard-settings-shortcuts"
      aria-labelledby="shortcuts-section-title"
    >
      <div className="pp-form-container">
        <h2 id="shortcuts-section-title">{tr("label.shortcuts")}</h2>
        <p className="pp-shortcuts-description">
          <InfoIcon />
          {tr("shortcuts.reload-hint")}
        </p>

        <nav className="pp-shortcuts-tabs">
          <ul className="pp-shortcuts-tab-list" role="tablist" aria-label={tr("shortcuts.page")}>
            {tabs.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  title={item.label}
                  tabIndex={tab === item.id ? undefined : -1}
                  data-testid={item.testId}
                  className={tab === item.id ? "pp-shortcuts-tab selected" : "pp-shortcuts-tab"}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <ShortcutsTabSection
          key={tab}
          tab={tab}
          tree={tree}
          sectionShortcuts={sectionShortcuts}
          macos={macos}
          expandAllByDefault={tab !== "all"}
          emptyStr={emptyStrForTab(tab)}
          hasCustomShortcuts={hasCustomShortcuts}
          openSections={openSections}
          onOpenSectionsChange={updateOpenSections}
          onRestoreAll={onRestoreAll}
          onSave={(group, key, command, conflictKey) =>
            setCustomShortcut(key, command, conflictKey, group)
          }
          onDisable={(group, key) => setCustomShortcut(key, "", null, group)}
          onReset={(group, key, defaultCommand) =>
            resetCustomShortcut(key, defaultCommand, group)
          }
        />

        <footer className="pp-shortcuts-footer">
          <div className="pp-shortcuts-info">
            <div className="pp-shortcuts-info-wrapper">
              <span className="pp-shortcuts-dot-wrapper" aria-hidden="true">
                <span className="pp-shortcuts-customized-dot" />
              </span>
              <p className="pp-shortcuts-text">{tr("shortcuts.personalized")}</p>
            </div>
            <div className="pp-shortcuts-info-wrapper">
              <BrokenLinkIcon className="pp-shortcuts-not-assigned-icon" />
              <p className="pp-shortcuts-text">{tr("shortcuts.disabled")}</p>
            </div>
          </div>

          <div className="pp-shortcuts-footer-actions">
            <button
              type="button"
              className="pp-btn-secondary"
              onClick={(event) =>
                setMenuAnchor(menuAnchorFromElement(event.currentTarget, "bottom-end"))
              }
            >
              <ImportExportIcon />
              {tr("shortcuts.import-export")}
            </button>
            {menuAnchor !== null ? (
              <DashboardMenu
                anchor={menuAnchor}
                entries={menuEntries}
                ariaLabel={tr("shortcuts.import-export")}
                onClose={() => setMenuAnchor(null)}
              />
            ) : null}
          </div>
        </footer>
      </div>
    </section>
  );
}
