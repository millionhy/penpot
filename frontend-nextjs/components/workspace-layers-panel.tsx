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
// first locale. The Tokens label is a literal, like the CLJS original.
//
// The tree comes from the pure helpers of lib/workspace-layers: build in
// file order, filter by name keeping the ancestors, then flatten with the
// expanded set. While a query is active every remaining node shows, so the
// matching paths expand automatically; clearing the query restores the
// expanded set the user had before.
//
// Geometry follows the CLJS stylesheets (tab_switcher.scss, sidebar.scss,
// sitemap.scss, layers.scss, layer_item.scss): the 36px tab nav on a
// secondary background, the 200px sitemap above the tree, the 40px
// tool-window bar titled with the open page name, and the 36px layer rows
// with their 32px body, 24px indent steps and 16px shape icons.
//
// Deviations from the CLJS original, documented (AD10):
// - No filters menu, search-and-replace, focus mode, drag and drop or
//   visibility/lock controls; this slice browses and selects.
// - The sitemap resize strip is a fixed spacer: the pane cannot be dragged.
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

import {
  BoardIcon,
  ChevronIcon,
  CloseIcon,
  CurveIcon,
  EllipseIcon,
  GroupIcon,
  ImageIcon,
  LineIcon,
  PathIcon,
  RectangleIcon,
  SearchIcon,
  TextIcon,
} from "@/components/workspace-icons";
import { WorkspacePagesPanel } from "@/components/workspace-pages-panel";
import type { WorkspaceCanvasHandle } from "@/components/workspace-wasm-canvas";
import { tr } from "@/lib/i18n";
import { pageInfos } from "@/lib/workspace-pages";
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

// The shape icon of a layer row (layer_item's icon-shape): the frame board,
// the group folder, the basic shapes, the text and the image.
function LayerTypeIcon({ type }: { type: string }) {
  switch (type) {
    case "frame":
      return <BoardIcon />;
    case "group":
    case "bool":
      return <GroupIcon />;
    case "rect":
      return <RectangleIcon />;
    case "circle":
      return <EllipseIcon />;
    case "line":
      return <LineIcon />;
    case "curve":
      return <CurveIcon />;
    case "text":
      return <TextIcon />;
    case "image":
      return <ImageIcon />;
    default:
      return <PathIcon />;
  }
}

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

  // The Tokens label stays untranslated on purpose, like the CLJS tabs list
  // (sidebar.cljs: "This string is intentionally not translated.").
  const tabs: readonly { id: TabId; label: string }[] = [
    { id: "layers", label: tr("workspace.sidebar.layers") },
    { id: "assets", label: tr("workspace.toolbar.assets") },
    { id: "tokens", label: "Tokens" },
  ];

  const [tab, setTab] = useState<TabId>("layers");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // The tool-window bar is titled with the open page name, like the CLJS
  // (title-bar :title (:name page)).
  const pageName = useMemo(() => {
    if (state.file === null) return "";
    const page = pageInfos(state.file).find((entry) => entry.id === state.pageId);
    return page?.name ?? "";
  }, [state.file, state.pageId]);

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

  const closeSearch = (): void => {
    setSearchOpen(false);
    setQuery("");
  };

  return (
    <section
      className="pp-workspace-layers"
      aria-label={tr("workspace.sidebar.layers")}
    >
      <div className="pp-workspace-tabs-wrap">
        <nav className="pp-workspace-tabs">
          <button
            type="button"
            className="pp-workspace-tabs-collapse"
            title={tr("workspace.sidebar.collapse")}
            aria-label={tr("workspace.sidebar.collapse")}
            onClick={onCollapse}
          >
            <ChevronIcon />
          </button>
          <ul
            className="pp-workspace-tabs-list"
            role="tablist"
            aria-label={tr("workspace.sidebar.layers")}
          >
            {tabs.map((entry) => (
              <li key={entry.id} className="pp-workspace-tabs-item">
                <button
                  type="button"
                  role="tab"
                  className={
                    entry.id === tab
                      ? "pp-workspace-tab pp-workspace-tab--selected"
                      : "pp-workspace-tab"
                  }
                  aria-selected={entry.id === tab}
                  title={entry.label}
                  onClick={() => setTab(entry.id)}
                >
                  <span className="pp-workspace-tab-text">{entry.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <div className="pp-workspace-layers-tab">
        {tab === "layers" ? (
          <>
            <WorkspacePagesPanel
              canEdit={canEdit}
              canvas={canvas}
              onSelectPage={onSelectPage}
            />

            {/* .layers-tab-resize-area: the fixed 6px strip between the
                sitemap and the layers tree. */}
            <div className="pp-workspace-sitemap-resize" aria-hidden="true">
              <span className="pp-workspace-sitemap-resize-handle" />
            </div>

            <div className="pp-workspace-layers-toolbox">
              <div className="pp-workspace-tool-window-bar">
                {searchOpen ? (
                  <>
                    <div className="pp-workspace-layer-search">
                      <SearchIcon />
                      <input
                        type="search"
                        className="pp-workspace-layer-search-input"
                        value={query}
                        autoFocus
                        placeholder={tr("workspace.sidebar.layers.search")}
                        aria-label={tr("workspace.sidebar.layers.search")}
                        onChange={(event) => setQuery(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            closeSearch();
                          }
                        }}
                      />
                    </div>
                    <button
                      type="button"
                      className="pp-workspace-tool-window-icon"
                      title={tr("labels.close")}
                      aria-label={tr("labels.close")}
                      onClick={closeSearch}
                    >
                      <CloseIcon />
                    </button>
                  </>
                ) : (
                  <div className="pp-workspace-tool-window-title">
                    <span
                      className="pp-workspace-tool-window-name"
                      title={pageName}
                    >
                      {pageName}
                    </span>
                    <button
                      type="button"
                      className="pp-workspace-tool-window-icon"
                      title={tr("workspace.sidebar.layers.search")}
                      aria-label={tr("workspace.sidebar.layers.search")}
                      onClick={() => setSearchOpen(true)}
                    >
                      <SearchIcon />
                    </button>
                  </div>
                )}
              </div>

              <div
                className="pp-workspace-tool-window-content"
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
                  <div className="pp-workspace-element-list">
                    {rows.map(({ node, depth }) => {
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
                          <div className="pp-workspace-layer-indent" />
                          <div className="pp-workspace-layer-body">
                            <div className="pp-workspace-layer-content">
                              {hasChildren ? (
                                <button
                                  type="button"
                                  className={
                                    isExpanded
                                      ? "pp-workspace-layer-toggle pp-workspace-layer-toggle--expanded"
                                      : "pp-workspace-layer-toggle"
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
                                // Leaf rows keep the toggle slot so the
                                // icons of the same depth align.
                                <span
                                  className="pp-workspace-layer-toggle pp-workspace-layer-toggle--leaf"
                                  aria-hidden="true"
                                />
                              )}
                              <span className="pp-workspace-layer-icon">
                                <LayerTypeIcon type={node.type} />
                              </span>
                            </div>
                            <span
                              className="pp-workspace-layer-name"
                              title={node.name}
                            >
                              {node.name}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="pp-workspace-layers-empty">
            <p className="pp-workspace-empty">{tr("labels.empty")}</p>
          </div>
        )}
      </div>
    </section>
  );
}
