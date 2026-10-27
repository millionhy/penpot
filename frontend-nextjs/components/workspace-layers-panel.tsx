"use client";

// The workspace Layers panel (F9.4): the tab switcher of the left sidebar
// (Layers, Assets, Tokens), the page list and the layers tree. Port of
// app.main.ui.workspace.sidebar.layers and the left-sidebar tabs.
//
// The panel owns its UI state (review correction to AD5): the active tab,
// the search query and the expanded set are local, so the module store
// keeps only the file, page, viewport, objects and selection slice.
//
// The tabs are built on every render: lib/i18n reads the locale from a
// module variable, so a module-scope array would keep the labels of the
// first locale. The Tokens label is workspace.sidebar.tokens, added to the
// upstream catalogs so the tab follows the locale too.
//
// The tree comes from the pure helpers of lib/workspace-layers: build in
// file order, filter by name keeping the ancestors, then flatten with the
// expanded set. While a query is active every remaining node shows, so the
// matching paths expand automatically; clearing the query restores the
// expanded set the user had before.
//
// Deviations from the CLJS original, documented (AD10):
// - No filters menu, search-and-replace, focus mode, drag and drop or
//   visibility/lock controls; this slice browses and selects.
// - Assets and Tokens render an empty state instead of their toolboxes.

import {
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";

import { ChevronIcon } from "@/components/workspace-icons";
import { WorkspacePagesPanel } from "@/components/workspace-pages-panel";
import type { WorkspaceCanvasHandle } from "@/components/workspace-wasm-canvas";
import { tr } from "@/lib/i18n";
import {
  buildLayerTree,
  filterLayerTree,
  visibleLayerRows,
} from "@/lib/workspace-layers";
import {
  clearSelection,
  getInitialWorkspaceState,
  getWorkspaceState,
  subscribeWorkspace,
  toggleSelection,
} from "@/lib/workspace-store";

type TabId = "layers" | "assets" | "tokens";

export interface WorkspaceLayersPanelProps {
  canEdit: boolean;
  canvas: RefObject<WorkspaceCanvasHandle | null>;
  // Collapse the whole left sidebar (the CLJS :collapse-left-sidebar).
  onCollapse: () => void;
  // Open a page: the shell writes ?page-id= so the route re-resolves it.
  onSelectPage: (id: string) => void;
}

export function WorkspaceLayersPanel({
  canEdit,
  canvas,
  onCollapse,
  onSelectPage,
}: WorkspaceLayersPanelProps) {
  const state = useSyncExternalStore(
    subscribeWorkspace,
    getWorkspaceState,
    getInitialWorkspaceState,
  );

  const tabs: readonly { id: TabId; label: string }[] = [
    { id: "layers", label: tr("workspace.sidebar.layers") },
    { id: "assets", label: tr("workspace.toolbar.assets") },
    { id: "tokens", label: tr("workspace.sidebar.tokens") },
  ];

  const [tab, setTab] = useState<TabId>("layers");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const tree = useMemo(
    () => buildLayerTree(state.objects ?? {}),
    [state.objects],
  );
  const filtered = query.trim() !== "";
  const filteredTree = useMemo(
    () => filterLayerTree(tree, query),
    [tree, query],
  );
  // A filtered tree shows every remaining node, so the matching paths open
  // without touching the expanded set.
  const rows = useMemo(
    () => visibleLayerRows(filteredTree, expanded, filtered),
    [filteredTree, expanded, filtered],
  );
  const selection = useMemo(() => new Set(state.selection), [state.selection]);

  const toggleExpanded = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectRow = (id: string, shiftKey: boolean): void => {
    toggleSelection(id, shiftKey);
  };

  const onRowKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    id: string,
  ): void => {
    // Ignore keys aimed at the chevron button.
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectRow(id, event.shiftKey);
    }
  };

  const clearOnBlankClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-layer-row]") === null) clearSelection();
  };

  return (
    <section
      className="pp-workspace-layers"
      aria-label={tr("workspace.sidebar.layers")}
    >
      <div className="pp-workspace-layers-tabs">
        <button
          type="button"
          className="pp-workspace-tabs-collapse"
          title={tr("workspace.sidebar.collapse")}
          aria-label={tr("workspace.sidebar.collapse")}
          onClick={onCollapse}
        >
          <ChevronIcon />
        </button>
        <div
          className="pp-workspace-layers-tablist"
          role="tablist"
          aria-label={tr("workspace.sidebar.layers")}
        >
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className={
                entry.id === tab
                  ? "pp-workspace-layers-tab pp-workspace-layers-tab--active"
                  : "pp-workspace-layers-tab"
              }
              aria-selected={entry.id === tab}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "layers" ? (
        <>
          <WorkspacePagesPanel
            canEdit={canEdit}
            canvas={canvas}
            onSelectPage={onSelectPage}
          />

          <div className="pp-workspace-layers-search">
            <input
              type="search"
              className="pp-workspace-layers-search-input"
              value={query}
              placeholder={tr("workspace.sidebar.layers.search")}
              aria-label={tr("workspace.sidebar.layers.search")}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>

          <div
            className="pp-workspace-layers-tree"
            role="tree"
            aria-label={tr("workspace.sidebar.layers")}
            onClick={clearOnBlankClick}
          >
            {rows.length === 0 ? (
              <p className="pp-workspace-empty">
                {filtered
                  ? tr("workspace.sidebar.layers.no-matches")
                  : tr("labels.empty")}
              </p>
            ) : (
              rows.map(({ node, depth }) => {
                const hasChildren = node.children.length > 0;
                const isExpanded = filtered || expanded.has(node.id);
                const isSelected = selection.has(node.id);
                const style = {
                  "--pp-layer-depth": depth,
                } as CSSProperties;

                return (
                  <div
                    key={node.id}
                    role="treeitem"
                    aria-level={depth + 1}
                    aria-selected={isSelected}
                    aria-expanded={hasChildren ? isExpanded : undefined}
                    tabIndex={0}
                    data-layer-row=""
                    className="pp-workspace-layer-row"
                    style={style}
                    onClick={(event) => {
                      event.stopPropagation();
                      selectRow(node.id, event.shiftKey);
                    }}
                    onKeyDown={(event) => onRowKeyDown(event, node.id)}
                  >
                    {hasChildren ? (
                      <button
                        type="button"
                        className={
                          isExpanded
                            ? "pp-workspace-layer-chevron pp-workspace-layer-chevron--expanded"
                            : "pp-workspace-layer-chevron"
                        }
                        aria-label={node.name}
                        tabIndex={-1}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleExpanded(node.id);
                        }}
                      >
                        <ChevronIcon />
                      </button>
                    ) : (
                      // Leaf rows reserve the chevron slot so names of the
                      // same depth align.
                      <span
                        className="pp-workspace-layer-chevron pp-workspace-layer-chevron--leaf"
                        aria-hidden="true"
                      />
                    )}
                    <span
                      className="pp-workspace-layer-name"
                      title={node.name}
                    >
                      {node.name}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </>
      ) : (
        <div className="pp-workspace-layers-empty">
          <p className="pp-workspace-empty">{tr("labels.empty")}</p>
        </div>
      )}
    </section>
  );
}
