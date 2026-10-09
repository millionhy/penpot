"use client";

// Dashboard file grid (F5.2). Port of app.main.ui.dashboard.grid: grid-item*
// (card + list row), grid* (the files view) and line-grid* (the recent view),
// plus the dynamic-width hook that derives how many cards fit per row.
//
// Deviations from the CLJS original, documented:
// - Thumbnails only display a stored thumbnail-id through assets/by-id
//   (cf/resolve-media). The client-side regeneration through the media worker
//   (render-thumbnail + rasterizer + create-file-thumbnail) needs the F9
//   renderer and is deferred; cards without a stored thumbnail show the file
//   background color and a loader slot.
// - use-visible (IntersectionObserver) gating of the thumbnail is replaced by
//   native loading="lazy".
// - The drag image counter element is dropped; the HTML5 default drag image
//   is used. The "penpot/files" drag type and the cross-project drop that
//   calls move-files are ported, so drag-to-move works in the recent view.
// - Dropping OS files (the binfile import) is deferred to F5.6 together with
//   import.cljs; drops are swallowed to keep the browser from navigating.
// - The component samples of grid-item-library* render through
//   render/component-svg, which needs the F9 renderer; the card draws the same
//   icon box empty and keeps the component name.
// - Loading the custom fonts behind the typography samples re-runs when the
//   dashboard font slice changes (fonts/ensure-loaded! over the rows
//   lib/dashboard-context.tsx registers), so the samples load even when the
//   shared files resolved before the fonts; the CLJS with-effect only runs
//   on the file.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  menuAnchorFromElement,
  menuAnchorFromEvent,
  type MenuAnchor,
} from "@/components/dashboard-menu";
import { FileMenuPopup, type FileActions, type FileMenuOrigin } from "@/components/file-menu";
import { InlineEdition } from "@/components/inline-edition";
import { Tr } from "@/components/tr";
import {
  colorSampleValue,
  computeGridLayout,
  moveFiles,
  resolveMediaUri,
  timeAgo,
  workspaceHref,
  type DashboardLayout,
  type DeletedFile,
  type FileSummary,
  type Project,
  type SharedFile,
} from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { ensureLoaded } from "@/lib/fonts";
import { config } from "@/lib/config";
import { tr } from "@/lib/i18n";
import { useNotifications } from "@/components/notifications";

// --- Dynamic width hook -------------------------------------------------------

// use-dynamic-grid-item-width (app.main.ui.hooks): measure the row container
// and export how many cards fit (limit) while writing the thumbnail box into
// the --thumbnail-width/--thumbnail-height CSS variables. `minWidth` is the
// itemsize argument only the libraries grid passes (350px cards).
export function useDynamicGridItemWidth(minWidth?: number | null): [
  React.RefObject<HTMLDivElement | null>,
  number,
] {
  const [width, setWidth] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const layout = computeGridLayout(width, minWidth);
  const { thumbnailWidth, thumbnailHeight } = layout;

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const observer = new ResizeObserver((entries) => {
      const row = entries[0];
      if (row !== undefined) setWidth(row.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (node === null || thumbnailWidth === null || thumbnailHeight === null) return;
    node.style.setProperty("--thumbnail-width", thumbnailWidth + "px");
    node.style.setProperty("--thumbnail-height", thumbnailHeight + "px");
  }, [thumbnailWidth, thumbnailHeight]);

  return [ref, layout.limit];
}

// --- Pieces ---------------------------------------------------------------------

function GridItemThumbnail({
  file,
  canEdit,
  canRestore,
}: {
  file: FileSummary;
  canEdit: boolean;
  canRestore?: boolean;
}) {
  const background = file.data?.background ?? "var(--color-background-quaternary)";
  const thumbnailId = file["thumbnail-id"];
  const src =
    typeof thumbnailId === "string" && thumbnailId.length > 0
      ? resolveMediaUri(config.publicUri, thumbnailId)
      : null;
  return (
    <div
      className={
        canRestore === true ? "pp-grid-item-thumbnail is-deleted" : "pp-grid-item-thumbnail"
      }
      style={{ backgroundColor: background }}
    >
      {src !== null ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote media id, no next/image optimization
        <img
          className="pp-grid-item-thumbnail-image"
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={canEdit}
        />
      ) : canEdit ? (
        <div className="pp-grid-loader" title={tr("labels.loading")} aria-label={tr("labels.loading")}>
          <span aria-hidden="true" />
        </div>
      ) : null}
    </div>
  );
}

// --- Shared-library card (grid-item-library*, F5.3) ---------------------------

function LibrarySection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children?: ReactNode;
}) {
  return (
    <div className="pp-library-asset-section">
      <div className="pp-library-asset-title">
        <span>{title}</span>
        {/* U+00A0 keeps the count glued to the label, as the CLJS card does. */}
        <span className="pp-library-num-assets">{"\u00a0(" + String(count) + ")"}</span>
      </div>
      <div className="pp-library-asset-list">{children}</div>
    </div>
  );
}

function LibraryMoreItem() {
  return (
    <div className="pp-library-asset-item">
      <div className="pp-library-name-block">
        <span className="pp-library-item-name">{"(...)"}</span>
      </div>
    </div>
  );
}

export function LibraryCard({ file, canRestore }: { file: SharedFile; canRestore?: boolean }) {
  const { fonts } = useDashboard();
  const summary = file["library-summary"];
  const components = summary?.components;
  const colors = summary?.colors;
  const typographies = summary?.typographies;

  const componentCount = components?.count ?? 0;
  const colorCount = colors?.count ?? 0;
  const typographyCount = typographies?.count ?? 0;
  const componentSample = components?.sample ?? [];
  const colorSample = colors?.sample ?? [];
  const typographySample = typographies?.sample ?? [];
  const empty = componentCount === 0 && colorCount === 0 && typographyCount === 0;

  // grid-item-library*: load the custom fonts its typography samples render
  // with (fonts/ensure-loaded!, a no-op for ids outside the custom registry).
  useEffect(() => {
    const sample = file["library-summary"]?.typographies?.sample ?? [];
    for (const typography of sample) {
      if (typography["font-id"] !== undefined) ensureLoaded(typography["font-id"]);
    }
  }, [file, fonts]);

  return (
    <div
      className={canRestore === true ? "pp-library-thumbnail is-deleted" : "pp-library-thumbnail"}
      data-testid={"library-card-" + file.id}
    >
      {/* An empty library still names its three sections, each with a zero
          count, which is the (zero? ...) branch of grid-item-library*. */}
      {empty ? (
        <>
          <LibrarySection title={tr("workspace.assets.components")} count={0} />
          <LibrarySection title={tr("workspace.assets.colors")} count={0} />
          <LibrarySection title={tr("workspace.assets.typography")} count={0} />
        </>
      ) : null}

      {componentCount > 0 ? (
        <LibrarySection title={tr("workspace.assets.components")} count={componentCount}>
          {componentSample.map((component) => (
            <div className="pp-library-asset-item" key={"assets-component-" + component.id}>
              <span className="pp-library-asset-icon" aria-hidden="true" />
              <div className="pp-library-name-block">
                <span className="pp-library-item-name" title={component.name}>
                  {component.name}
                </span>
              </div>
            </div>
          ))}
          {componentCount > componentSample.length ? <LibraryMoreItem /> : null}
        </LibrarySection>
      ) : null}

      {colorCount > 0 ? (
        <LibrarySection title={tr("workspace.assets.colors")} count={colorCount}>
          {colorSample.map((color) => (
            <div
              className="pp-library-asset-item pp-library-color-item"
              key={"assets-color-" + color.id}
            >
              <span
                className="pp-color-bullet"
                aria-hidden="true"
                style={{
                  backgroundColor: color.color ?? "transparent",
                  opacity: color.opacity ?? 1,
                }}
              />
              <div className="pp-library-name-block">
                <span className="pp-library-color-name">{color.name}</span>
                {color.name !== colorSampleValue(color) ? (
                  <span className="pp-library-color-value">{color.color}</span>
                ) : null}
              </div>
            </div>
          ))}
          {colorCount > colorSample.length ? <LibraryMoreItem /> : null}
        </LibrarySection>
      ) : null}

      {typographyCount > 0 ? (
        <LibrarySection title={tr("workspace.assets.typography")} count={typographyCount}>
          {typographySample.map((typography) => (
            <div className="pp-library-asset-item" key={"assets-typography-" + typography.id}>
              <div
                className="pp-library-typography-sample"
                style={{
                  fontFamily: typography["font-family"],
                  fontWeight: typography["font-weight"],
                  fontStyle: typography["font-style"],
                }}
              >
                {tr("workspace.assets.typography.sample")}
              </div>
              <div className="pp-library-name-block">
                <span className="pp-library-item-name" title={typography.name}>
                  {typography.name}
                </span>
              </div>
            </div>
          ))}
          {typographyCount > typographySample.length ? <LibraryMoreItem /> : null}
        </LibrarySection>
      ) : null}
    </div>
  );
}

// grid-item-metadata*: a trashed file shows when it leaves the trash for good
// instead of when it was last modified.
function GridItemDate({ file, layout }: { file: DeletedFile; layout: DashboardLayout }) {
  const className = layout === "list" ? "pp-list-item-date" : "pp-grid-item-date";
  const deadline = file["will-be-deleted-at"];
  if (deadline !== null && deadline !== undefined) {
    const time = timeAgo(deadline);
    if (time === null) return null;
    return (
      <span className={className} title={tr("dashboard.deleted.will-be-deleted-at", time)}>
        {time}
      </span>
    );
  }
  const time = timeAgo(file["modified-at"]);
  if (time === null) return null;
  return <span className={className} title={tr("dashboard.grid.last-modified-at", time)}>{time}</span>;
}

export interface GridItemProps {
  file: FileSummary;
  // The sibling files of this grid, used to resolve the selection into full
  // rows for the menu (menu-files in grid-item*).
  files: FileSummary[];
  teamId: string | null;
  canEdit: boolean;
  canRestore?: boolean;
  origin?: FileMenuOrigin;
  layout: DashboardLayout;
  actions: FileActions;
}

export function GridItem({
  file,
  files,
  teamId,
  canEdit,
  canRestore,
  origin,
  layout,
  actions,
}: GridItemProps) {
  const router = useRouter();
  const { selection, toggleFileSelect, clearSelection, editingFileId, stopEditFileName } =
    useDashboard();
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);

  const selected = selection.ids.has(file.id);
  const selectedCount = selection.ids.size;
  const editing = editingFileId === file.id;
  const list = layout === "list";
  // library-view? in grid-item*: the libraries route swaps the thumbnail for
  // the summary card and hides the shared badge, which would be redundant.
  const libraryView = origin === "libraries";
  const trashed = canRestore === true;

  // menu-files in grid-item*: the whole selection when this file is part of
  // it, otherwise just this file.
  const menuFiles = selected ? files.filter((row) => selection.ids.has(row.id)) : [file];

  const navigate = () => {
    // on-navigate in grid-item* is a no-op for a trashed file: opening it
    // would land on a workspace whose file is soft-deleted.
    if (trashed) return;
    router.push(workspaceHref({ teamId, fileId: file.id }));
  };

  const select = (event: React.MouseEvent) => {
    if (!selected || selectedCount > 1) {
      event.stopPropagation();
      if (!event.shiftKey) clearSelection();
      toggleFileSelect(file);
    }
    // A plain click on the single selected file bubbles to the content div,
    // which clears the selection (dashboard-content*).
  };

  const onDoubleClick = (event: React.MouseEvent) => {
    if ((event.target as Element).closest("button") !== null) return;
    navigate();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Enter") navigate();
  };

  const onDragStart = (event: React.DragEvent) => {
    setMenuAnchor(null);
    if (!canEdit) return;
    if (!selected) {
      clearSelection();
      toggleFileSelect(file);
    }
    event.dataTransfer.setData("penpot/files", "dummy");
    event.dataTransfer.effectAllowed = "move";
  };

  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    if (!selected) {
      if (!event.shiftKey) clearSelection();
      toggleFileSelect(file);
    }
    setMenuAnchor(menuAnchorFromEvent(event));
  };

  const onMenuClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!selected) {
      if (!event.shiftKey) clearSelection();
      toggleFileSelect(file);
    }
    // currentTarget must be read synchronously: React clears it before the
    // functional updater runs.
    const element = event.currentTarget;
    setMenuAnchor((current) =>
      current === null
        ? menuAnchorFromElement(element, list ? "bottom-end" : "bottom-start")
        : null,
    );
  };

  const onEditEnd = (name: string) => {
    const trimmed = name.trim();
    if (trimmed !== "") void actions.rename(file, trimmed);
    stopEditFileName();
  };

  const sharedBadge =
    file["is-shared"] === true && !libraryView ? (
      list ? (
        <span
          className="pp-list-item-badge"
          aria-label={tr("workspace.assets.shared-library")}
          title={tr("workspace.assets.shared-library")}
        >
          <span aria-hidden="true">⧉</span>
        </span>
      ) : (
        <div className="pp-grid-item-badge" aria-label={tr("workspace.assets.shared-library")}>
          <span aria-hidden="true">⧉</span>
        </div>
      )
    ) : null;

  const menuButton = (
    <div className={list ? "pp-project-thumbnail-actions pp-list-actions" : "pp-project-thumbnail-actions"}>
      <button
        type="button"
        id={file.id + "-action-menu"}
        className="pp-icon-btn"
        aria-label={tr("dashboard.options")}
        aria-haspopup="menu"
        aria-expanded={menuAnchor !== null}
        data-testid={"file-menu-" + file.id}
        onClick={onMenuClick}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <span aria-hidden="true">…</span>
      </button>
    </div>
  );

  const popup =
    menuAnchor !== null ? (
      <FileMenuPopup
        files={menuFiles}
        anchor={menuAnchor}
        canEdit={canEdit}
        canRestore={canRestore}
        origin={origin}
        teamId={teamId}
        actions={actions}
        onClose={() => setMenuAnchor(null)}
      />
    ) : null;

  const sharedHandlers = {
    onClick: select,
    onDoubleClick,
    onKeyDown,
    onDragStart,
    onContextMenu,
    draggable: canEdit,
    role: "button",
    title: file.name,
    "aria-label": file.name,
  };

  if (list) {
    return (
      <li
        className={libraryView ? "pp-grid-item pp-list-item pp-library-item" : "pp-grid-item pp-list-item"}
        data-testid={"file-" + file.id}
      >
        <div
          className={selected ? "pp-list-item-row is-selected" : "pp-list-item-row"}
          {...sharedHandlers}
        >
          {editing ? (
            <InlineEdition content={file.name} onEnd={onEditEnd} maxLength={250} />
          ) : (
            <h3 className="pp-list-item-name">{file.name}</h3>
          )}
          {sharedBadge}
          <GridItemDate file={file} layout="list" />
          {menuButton}
        </div>
        {popup}
      </li>
    );
  }

  return (
    <li
      className={
        libraryView
          ? "pp-grid-item pp-project-thumbnail pp-library-item"
          : "pp-grid-item pp-project-thumbnail"
      }
      data-testid={"file-" + file.id}
    >
      <div
        className={selected ? "pp-grid-item-button is-selected" : "pp-grid-item-button"}
        {...sharedHandlers}
      >
        {libraryView ? (
          <LibraryCard file={file} canRestore={canRestore} />
        ) : (
          <GridItemThumbnail file={file} canEdit={canEdit} canRestore={canRestore} />
        )}
        {sharedBadge}
        <div className="pp-grid-item-info">
          <div className="pp-grid-item-meta">
            {editing ? (
              <InlineEdition content={file.name} onEnd={onEditEnd} maxLength={250} />
            ) : (
              <h3 className="pp-grid-item-title">{file.name}</h3>
            )}
            <GridItemDate file={file} layout="grid" />
          </div>
          {menuButton}
        </div>
      </div>
      {popup}
    </li>
  );
}

// --- Placeholders ------------------------------------------------------------------

export function LoadingPlaceholder() {
  return (
    <div className="pp-placeholder-loader" data-testid="loading-placeholder">
      <span className="pp-placeholder-spinner" aria-hidden="true" />
      <span className="pp-placeholder-text">{tr("dashboard.loading-files")}</span>
    </div>
  );
}

export interface EmptyGridPlaceholderProps {
  canEdit: boolean;
  onCreateFile: () => void;
  // make-has-other-files-or-projects-ref: without any other project or file
  // the team shows the big starter cards instead of the small "+" tile.
  hasOther: boolean;
}

export function EmptyGridPlaceholder({ canEdit, onCreateFile, hasOther }: EmptyGridPlaceholderProps) {
  const [showText, setShowText] = useState(false);

  if (!hasOther) {
    return (
      <div className="pp-empty-project-container" data-testid="empty-project-placeholder">
        <div
          className="pp-empty-project-card"
          role="button"
          tabIndex={0}
          title={tr("dashboard.add-file")}
          data-testid="empty-create-file"
          onClick={onCreateFile}
          onKeyDown={(event) => {
            if (event.key === "Enter") onCreateFile();
          }}
        >
          <div className="pp-empty-project-card-title">{tr("dashboard.empty-project.create")}</div>
          <div className="pp-empty-project-card-subtitle">{tr("dashboard.empty-project.start")}</div>
        </div>
        {/* The import card arrives with the binfile flow (F5.6). */}
        <div
          className="pp-empty-project-card"
          role="link"
          tabIndex={0}
          title={tr("dashboard.empty-project.go-to-libraries")}
          onClick={() => window.open("https://penpot.app/penpothub/libraries-templates", "_blank", "noopener,noreferrer")}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              window.open("https://penpot.app/penpothub/libraries-templates", "_blank", "noopener,noreferrer");
            }
          }}
        >
          <div className="pp-empty-project-card-title">{tr("dashboard.empty-project.add-library")}</div>
          <div className="pp-empty-project-card-subtitle">{tr("dashboard.empty-project.explore")}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="pp-grid-empty-placeholder" data-testid="empty-grid-placeholder">
      {canEdit ? (
        <button
          type="button"
          className="pp-create-new"
          data-testid="create-new-file"
          onClick={onCreateFile}
          onMouseEnter={() => setShowText(true)}
          onMouseLeave={() => setShowText(false)}
        >
          {showText ? tr("dashboard.empty-project.create") : <span aria-hidden="true">+</span>}
        </button>
      ) : null}
    </div>
  );
}

// --- Grids ------------------------------------------------------------------------

// The (= :libraries origin) branch of empty-grid-placeholder*: the starter
// card, whose markdown body only editors see.
export function LibrariesEmptyPlaceholder({ canEdit }: { canEdit: boolean }) {
  return (
    <div
      className="pp-empty-placeholder pp-empty-placeholder-libraries"
      data-testid="empty-placeholder"
    >
      <h3 className="pp-empty-title">{tr("dashboard.empty-placeholder-libraries-title")}</h3>
      {canEdit ? (
        <Tr k="dashboard.empty-placeholder-libraries" tagName="span" className="pp-placeholder-markdown" />
      ) : (
        <p className="pp-empty-subtitle">
          {tr("dashboard.empty-placeholder-libraries-subtitle-viewer-role")}
        </p>
      )}
    </div>
  );
}

export interface DashboardGridProps {
  // search-page* calls grid* without a project; the id only feeds the testid.
  project?: Project | null;
  teamId: string | null;
  // null while the files are still loading (loading-placeholder*).
  files: FileSummary[] | null;
  canEdit: boolean;
  canRestore?: boolean;
  origin?: FileMenuOrigin;
  layout: DashboardLayout;
  limit: number;
  actions: FileActions;
  onCreateFile?: () => void;
  hasOther?: boolean;
}

function partition<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

// grid*: the files view grid; rows of `limit` cards, or one list.
export function DashboardGrid({
  project,
  teamId,
  files,
  canEdit,
  canRestore,
  origin,
  layout,
  limit,
  actions,
  onCreateFile,
  hasOther,
}: DashboardGridProps) {
  // OS file drops (binfile import) are swallowed until F5.6.
  const swallowDrop = {
    onDragOver: (event: React.DragEvent) => event.preventDefault(),
    onDrop: (event: React.DragEvent) => event.preventDefault(),
  };

  const testId = "grid-" + (project?.id ?? origin ?? "all");
  const noopCreate = () => undefined;

  if (files === null) {
    return (
      <div className="pp-dashboard-grid" data-testid={testId} {...swallowDrop}>
        <LoadingPlaceholder />
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <div className="pp-dashboard-grid" data-testid={testId} {...swallowDrop}>
        {origin === "libraries" ? (
          <LibrariesEmptyPlaceholder canEdit={canEdit} />
        ) : (
          <EmptyGridPlaceholder
            canEdit={canEdit}
            onCreateFile={onCreateFile ?? noopCreate}
            hasOther={hasOther ?? false}
          />
        )}
      </div>
    );
  }

  if (layout === "list") {
    return (
      <div className="pp-dashboard-grid" data-testid={testId} {...swallowDrop}>
        <ul className="pp-grid-row pp-list-view">
          {files.map((file) => (
            <GridItem
              key={file.id}
              file={file}
              files={files}
              teamId={teamId}
              canEdit={canEdit}
              canRestore={canRestore}
              origin={origin}
              layout="list"
              actions={actions}
            />
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="pp-dashboard-grid" data-testid={testId} {...swallowDrop}>
      {partition(files, limit).map((row, index) => (
        <ul className="pp-grid-row" key={index}>
          {row.map((file) => (
            <GridItem
              key={file.id}
              file={file}
              files={files}
              teamId={teamId}
              canEdit={canEdit}
              canRestore={canRestore}
              origin={origin}
              layout="grid"
              actions={actions}
            />
          ))}
        </ul>
      ))}
    </div>
  );
}

export interface LineGridProps {
  project: Project;
  teamId: string | null;
  files: FileSummary[] | null;
  canEdit: boolean;
  layout: DashboardLayout;
  limit: number;
  actions: FileActions;
  onCreateFile: () => void;
  hasOther: boolean;
  // dd/fetch-recent-files + dd/fetch-projects after a successful drop.
  onFilesMoved: () => Promise<void> | void;
}

// line-grid*: one row of at most `limit` files, and the drop target that
// moves the current selection into this project.
export function LineGrid({
  project,
  teamId,
  files,
  canEdit,
  layout,
  limit,
  actions,
  onCreateFile,
  hasOther,
  onFilesMoved,
}: LineGridProps) {
  const [dragging, setDragging] = useState(false);
  const { selection, clearSelection } = useDashboard();
  const notifications = useNotifications();

  const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes("penpot/files");

  const fromChild = (event: React.DragEvent) =>
    event.currentTarget.contains(event.relatedTarget as Node);

  const onDragEnter = (event: React.DragEvent) => {
    if (!canEdit || !hasFiles(event)) return;
    event.preventDefault();
    if (!fromChild(event) && selection.projectId !== project.id) setDragging(true);
  };

  const onDragOver = (event: React.DragEvent) => {
    if (hasFiles(event)) event.preventDefault();
  };

  const onDragLeave = (event: React.DragEvent) => {
    if (!fromChild(event)) setDragging(false);
  };

  const onDrop = (event: React.DragEvent) => {
    if (!canEdit) {
      event.preventDefault();
      return;
    }
    if (!hasFiles(event)) {
      // OS file drops (binfile import) arrive with F5.6; swallow them so the
      // browser does not navigate away.
      event.preventDefault();
      return;
    }
    event.preventDefault();
    setDragging(false);
    const ids = [...selection.ids];
    if (selection.projectId === project.id || ids.length === 0) return;
    void (async () => {
      try {
        await moveFiles(ids, project.id);
        notifications.success(
          ids.length > 1 ? tr("dashboard.success-move-files") : tr("dashboard.success-move-file"),
        );
        clearSelection();
        await onFilesMoved();
      } catch {
        notifications.error(tr("errors.generic"));
      }
    })();
  };

  const dragHandlers = { onDragEnter, onDragOver, onDragLeave, onDrop };

  if (files === null) {
    return (
      <div className="pp-dashboard-grid" {...dragHandlers} data-testid={"line-grid-" + project.id}>
        <LoadingPlaceholder />
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <div className="pp-dashboard-grid" {...dragHandlers} data-testid={"line-grid-" + project.id}>
        <EmptyGridPlaceholder canEdit={canEdit} onCreateFile={onCreateFile} hasOther={hasOther} />
      </div>
    );
  }

  const shown = files.slice(0, dragging ? Math.max(1, limit - 1) : limit);

  if (layout === "list") {
    return (
      <div className="pp-dashboard-grid" {...dragHandlers} data-testid={"line-grid-" + project.id}>
        <ul className="pp-grid-row pp-list-view">
          {dragging ? <li className="pp-list-item-dragged" /> : null}
          {shown.map((file) => (
            <GridItem
              key={file.id}
              file={file}
              files={files}
              teamId={teamId}
              canEdit={canEdit}
              layout="list"
              actions={actions}
            />
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="pp-dashboard-grid" {...dragHandlers} data-testid={"line-grid-" + project.id}>
      <ul
        className="pp-grid-row pp-no-wrap"
        style={{ gridTemplateColumns: "repeat(" + String(limit) + ", 1fr)" }}
      >
        {dragging ? <li className="pp-grid-item is-dragged" /> : null}
        {shown.map((file) => (
          <GridItem
            key={file.id}
            file={file}
            files={files}
            teamId={teamId}
            canEdit={canEdit}
            layout="grid"
            actions={actions}
          />
        ))}
      </ul>
    </div>
  );
}
