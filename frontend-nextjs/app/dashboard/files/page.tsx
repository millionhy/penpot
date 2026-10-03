"use client";

// Files section (F5.2). Port of app.main.ui.dashboard.files: the project
// header (title with double-click inline rename, layout toggle, new-file,
// pin, project menu) and the full file grid fed by get-project-files.
//
// Deviations from the CLJS original, documented:
// - The templates section under the grid is F5.6; the dashboard shortcuts
//   registry (select-all etc.) is F5.6 too.
// - The import entries (header menu item and drag & drop of .penpot files)
//   wait for the binfile flow in F5.6.
// - dashboard-content* renders files-section* only when the project param
//   resolves; the shell does the same and renders nothing otherwise.
// - create-file name uniqueness is computed from this project's loaded
//   files (the CLJS store may also hold files of previously visited
//   projects); the backend does not enforce unique file names.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DashboardGrid, useDynamicGridItemWidth } from "@/components/dashboard-grid";
import { useFileActions } from "@/components/file-menu";
import { InlineEdition } from "@/components/inline-edition";
import { LayoutToggle, useDashboardLayout } from "@/components/layout-toggle";
import { useNotifications } from "@/components/notifications";
import { ProjectMenuPopup, useProjectActions } from "@/components/project-menu";
import { menuAnchorFromElement, menuAnchorFromEvent, type MenuAnchor } from "@/components/dashboard-menu";
import {
  createFile,
  fileFeatures,
  firstPageId,
  generateUniqueName,
  getProjectFiles,
  renameProject,
  updateProjectPin,
  usedNames,
  workspaceHref,
  type FileSummary,
} from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { useDocumentTitle } from "@/lib/dom";
import { tr } from "@/lib/i18n";

// files-section*: modified-at descending, the order the CLJS memo applies.
function sortFiles(files: FileSummary[]): FileSummary[] {
  return [...files].sort((left, right) => {
    const leftMs = new Date(left["modified-at"] ?? 0).getTime();
    const rightMs = new Date(right["modified-at"] ?? 0).getTime();
    return rightMs - leftMs;
  });
}

export default function DashboardFilesPage() {
  const {
    team,
    project,
    projects,
    teams,
    teamId,
    canEdit,
    recentFiles,
    clearSelection,
    refreshProjects,
    refreshRecentFiles,
  } = useDashboard();
  const router = useRouter();
  const notifications = useNotifications();

  const [files, setFiles] = useState<FileSummary[] | null>(null);
  const [layout, onLayoutChange] = useDashboardLayout();
  const [titleEdition, setTitleEdition] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  const [sectionRef, limit] = useDynamicGridItemWidth();
  const [busy, setBusy] = useState(false);

  const projectId = project?.id ?? null;

  // dpj/fetch-files + dd/clear-selected-files on every project change.
  useEffect(() => {
    if (projectId === null) return;
    let live = true;
    setFiles(null);
    clearSelection();
    getProjectFiles(projectId)
      .then((rows) => {
        if (live) setFiles(sortFiles(Array.isArray(rows) ? rows : []));
      })
      .catch(() => {
        if (live) setFiles([]);
      });
    return () => {
      live = false;
    };
    // clearSelection is a stable callback; running this effect again on its
    // identity would refetch on every selection change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const isDraft = project?.["is-default"] === true;
  const projectName = isDraft ? tr("labels.drafts") : (project?.name ?? "");
  useDocumentTitle(project === null ? "" : tr("title.dashboard.files", projectName));

  const onFilesChanged = useCallback(async () => {
    if (projectId === null) return;
    try {
      const rows = await getProjectFiles(projectId);
      setFiles(sortFiles(Array.isArray(rows) ? rows : []));
    } catch {
      setFiles([]);
    }
    await Promise.all([refreshProjects(), refreshRecentFiles()]);
  }, [projectId, refreshProjects, refreshRecentFiles]);

  const knownFileNames = useCallback(
    () => usedNames(files ?? []),
    [files],
  );

  const actions = useFileActions({ teamId, knownFileNames, onFilesChanged });

  // header* create-file: unique name from the loaded project files, then
  // straight into the workspace on the first page.
  const onCreateFile = async () => {
    if (project === undefined || project === null) return;
    setBusy(true);
    try {
      const created = await createFile({
        "project-id": project.id,
        name: generateUniqueName(tr("dashboard.new-file-prefix"), knownFileNames(), {
          immediateSuffix: true,
        }),
        features: fileFeatures(team),
      });
      router.push(
        workspaceHref({ teamId, fileId: created.id, pageId: firstPageId(created) }),
      );
    } catch {
      notifications.error(tr("errors.generic"));
      setBusy(false);
    }
  };

  const onTitleEditEnd = async (name: string) => {
    setTitleEdition(false);
    const trimmed = name.trim();
    if (trimmed === "" || project === null || project === undefined) return;
    if (trimmed === project.name) return;
    try {
      await renameProject({ id: project.id, name: trimmed });
      await refreshProjects();
    } catch {
      notifications.error(tr("errors.generic"));
    }
  };

  const onTogglePin = async () => {
    if (project === null || project === undefined || teamId === null) return;
    setBusy(true);
    try {
      await updateProjectPin({
        "team-id": teamId,
        id: project.id,
        "is-pinned": project["is-pinned"] !== true,
      });
      await refreshProjects();
    } catch {
      notifications.error(tr("errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  const projectActions = useProjectActions({
    project: project ?? { id: "", name: "", "team-id": teamId ?? "" },
    projects,
    onRename: () => {
      setMenuAnchor(null);
      setTitleEdition(true);
    },
    onProjectsChanged: refreshProjects,
  });

  const otherTeams = useMemo(
    () => teams.filter((row) => row.id !== teamId),
    [teams, teamId],
  );

  const fileCount = files?.length ?? 0;
  // loading? in files-section*: the project row knows the live count, so a
  // mismatch means the fetch has not caught up yet.
  const loading = project?.count !== undefined && project?.count !== null && project.count !== fileCount;
  const emptyStateViewer = !canEdit && fileCount === 0 && !loading;
  const hasOther = useMemo(
    () =>
      projects.some((row) => row["is-default"] !== true) ||
      recentFiles.some((row) => row["project-id"] !== projectId),
    [projects, recentFiles, projectId],
  );

  if (project === null || project === undefined) return null;

  return (
    <>
      <header className="pp-dashboard-header" data-testid="dashboard-header">
        {isDraft ? (
          <div className="pp-dashboard-title" id="dashboard-drafts-title">
            <h1>{tr("labels.drafts")}</h1>
          </div>
        ) : titleEdition && canEdit ? (
          <InlineEdition content={project.name} onEnd={(name) => void onTitleEditEnd(name)} maxLength={250} />
        ) : (
          <div className="pp-dashboard-title">
            <h1
              data-testid="project-title"
              id={project.id}
              onDoubleClick={() => {
                if (canEdit) setTitleEdition(true);
              }}
            >
              {project.name}
            </h1>
          </div>
        )}

        <div className="pp-dashboard-header-actions">
          <LayoutToggle layout={layout} onChange={onLayoutChange} />
          {canEdit ? (
            <button
              type="button"
              className="pp-btn-secondary"
              disabled={busy}
              data-testid="new-file"
              onClick={() => {
                void onCreateFile();
              }}
            >
              {tr("dashboard.new-file")}
            </button>
          ) : null}
          {!isDraft ? (
            <button
              type="button"
              className="pp-icon-btn"
              disabled={busy}
              aria-label={tr("dashboard.pin-unpin")}
              aria-pressed={project["is-pinned"] === true}
              data-testid={"pin-" + project.id}
              onClick={() => {
                void onTogglePin();
              }}
            >
              {"\u2691"}
            </button>
          ) : null}
          {canEdit && !isDraft ? (
            <>
              <button
                type="button"
                className="pp-icon-btn"
                aria-label={tr("dashboard.options")}
                aria-haspopup="menu"
                aria-expanded={menuAnchor !== null}
                data-testid="project-options"
                onClick={(event) => {
                  event.stopPropagation();
                  // currentTarget must be read synchronously: React clears it
                  // before the functional updater runs.
                  const element = event.currentTarget;
                  setMenuAnchor((current) =>
                    current === null ? menuAnchorFromElement(element, "bottom-end") : null,
                  );
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setMenuAnchor(menuAnchorFromEvent(event));
                }}
              >
                <span aria-hidden="true">…</span>
              </button>
              {menuAnchor !== null ? (
                <ProjectMenuPopup
                  otherTeams={otherTeams}
                  anchor={menuAnchor}
                  actions={projectActions}
                  onClose={() => setMenuAnchor(null)}
                />
              ) : null}
            </>
          ) : null}
        </div>
      </header>

      <section className="pp-dashboard-container" ref={sectionRef} data-testid="files-section">
        {emptyStateViewer ? (
          <div className="pp-empty-placeholder" data-testid="empty-placeholder">
            <h3 className="pp-empty-title">
              {isDraft
                ? tr("dashboard.empty-placeholder-drafts-title")
                : tr("dashboard.empty-placeholder-files-title")}
            </h3>
            <p className="pp-empty-subtitle">
              {isDraft
                ? tr("dashboard.empty-placeholder-drafts-subtitle")
                : tr("dashboard.empty-placeholder-files-subtitle")}
            </p>
          </div>
        ) : (
          <DashboardGrid
            project={project}
            teamId={teamId}
            files={loading ? null : files}
            canEdit={canEdit}
            layout={layout}
            limit={limit}
            actions={actions}
            onCreateFile={() => {
              void onCreateFile();
            }}
            hasOther={hasOther}
          />
        )}
      </section>
    </>
  );
}
