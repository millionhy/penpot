"use client";

// Trash section (F5.3). Port of app.main.ui.dashboard.deleted: the header with
// the layout toggle, the Recent/Deleted tab strip, the retention notice with
// its two bulk buttons, and one project row per project that still holds a
// deleted file. Every operation here runs over an SSE command and drives the
// progress widget.
//
// Deviations from the CLJS original, documented:
// - The retention notice uses the plan-derived day count only. The nitrate
//   branch (90 days behind a valid nitrate licence) needs the subscription
//   slice that arrives with F5.7.
// - dd/restore-files and dd/delete-files end with fetch-projects,
//   fetch-deleted-files and a second fetch-projects; the shell runs each
//   refresh once.
// - The telemetry events of restore-files-immediately,
//   delete-files-immediately and their project variants are dropped; the shell
//   has no analytics seam.
// - dashboard-content* swaps :dashboard-deleted for :dashboard-recent when the
//   profile cannot edit. The App Router picks the page from the URL, so this
//   page redirects instead.
// - The dashboard shortcuts registry arrives with F5.6.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DashboardMenu,
  menuAnchorFromElement,
  menuAnchorFromEvent,
  type MenuAnchor,
  type MenuEntry,
} from "@/components/dashboard-menu";
import { DashboardGrid, useDynamicGridItemWidth } from "@/components/dashboard-grid";
import { DeletedTabs } from "@/components/deleted-tabs";
import { useFileActions, type BulkFileFlows, type FileActions } from "@/components/file-menu";
import { LayoutToggle, useDashboardLayout } from "@/components/layout-toggle";
import { ConfirmDialog, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { useProgress } from "@/components/progress-notification";
import {
  dashboardHref,
  deletedFilesOf,
  deletedProjectsFor,
  deletionDays,
  getTeamDeletedFiles,
  permanentlyDeleteTeamFiles,
  restoreDeletedTeamFiles,
  subscriptionType,
  usedNames,
  visibleDeletedFiles,
  type DashboardLayout,
  type DeletedFile,
  type Project,
} from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { tr } from "@/lib/i18n";

interface BulkLabels {
  success: string;
  error: string;
}

interface DeletedProjectItemProps {
  project: Project;
  files: DeletedFile[];
  layout: DashboardLayout;
  teamId: string | null;
  actions: FileActions;
  onRestoreProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
}

// deleted-project-item*: the project header, whose options button only exists
// for a project that is itself deleted, plus the grid of its trashed files.
function DeletedProjectItem({
  project,
  files,
  layout,
  teamId,
  actions,
  onRestoreProject,
  onDeleteProject,
}: DeletedProjectItemProps) {
  const [rowRef, limit] = useDynamicGridItemWidth();
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);

  const projectDeleted = project["deleted-at"] !== null && project["deleted-at"] !== undefined;

  const entries: MenuEntry[] = [
    {
      type: "item",
      id: "project-restore",
      label: tr("dashboard.restore-project-button"),
      onSelect: () => onRestoreProject(project),
    },
    {
      type: "item",
      id: "project-delete",
      label: tr("dashboard.delete-project-button"),
      danger: true,
      onSelect: () => onDeleteProject(project),
    },
  ];

  const onMenuClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    // currentTarget must be read synchronously: React clears it before the
    // functional updater runs.
    const element = event.currentTarget;
    setMenuAnchor((current) =>
      current === null ? menuAnchorFromElement(element, "bottom-start") : null,
    );
  };

  return (
    <article className="pp-project-row" data-testid={"deleted-project-" + project.id}>
      <header className="pp-project pp-deleted-project">
        <div className="pp-project-name-wrapper">
          <h2 className="pp-project-name" title={project.name}>
            {project.name}
          </h2>
          {projectDeleted ? (
            <div className="pp-info-wrapper">
              <div className="pp-project-actions">
                <button
                  type="button"
                  className="pp-icon-btn"
                  title={tr("dashboard.options")}
                  aria-label={tr("dashboard.options")}
                  aria-haspopup="menu"
                  aria-expanded={menuAnchor !== null}
                  data-testid="project-options"
                  onClick={onMenuClick}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMenuAnchor(menuAnchorFromEvent(event));
                  }}
                >
                  <span aria-hidden="true">{"\u2026"}</span>
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </header>

      {menuAnchor !== null ? (
        <DashboardMenu
          anchor={menuAnchor}
          entries={entries}
          onClose={() => setMenuAnchor(null)}
          ariaLabel={tr("dashboard.options")}
        />
      ) : null}

      <div className="pp-grid-container" ref={rowRef}>
        {files.length === 0 ? (
          <div className="pp-empty-placeholder" data-testid="empty-placeholder">
            <h3 className="pp-empty-title">{tr("dashboard.empty-placeholder-files-title")}</h3>
            <p className="pp-empty-subtitle">{tr("dashboard.empty-placeholder-files-subtitle")}</p>
          </div>
        ) : (
          <DashboardGrid
            project={project}
            teamId={teamId}
            files={files}
            canEdit={false}
            canRestore
            layout={layout}
            limit={limit}
            actions={actions}
          />
        )}
      </div>
    </article>
  );
}

export default function DashboardDeletedPage() {
  const router = useRouter();
  const { team, teamId, canEdit, projects, refreshProjects, clearSelection } = useDashboard();
  const { success: notifySuccess, error: notifyError } = useNotifications();
  const { start: startProgress, update: updateProgress, clear: clearProgress } = useProgress();
  const modal = useModal();
  const [layout, onLayoutChange] = useDashboardLayout();
  const [deletedFiles, setDeletedFiles] = useState<DeletedFile[] | null>(null);

  // show-deleted? in dashboard-content*: without edit permission the trash is
  // not reachable and recent renders instead.
  useEffect(() => {
    if (canEdit || teamId === null) return;
    router.replace(dashboardHref("dashboard-recent", { teamId }));
  }, [canEdit, teamId, router]);

  const loadDeletedFiles = useCallback(async () => {
    if (teamId === null) return;
    try {
      const rows = await getTeamDeletedFiles(teamId);
      setDeletedFiles(visibleDeletedFiles(Array.isArray(rows) ? rows : []));
    } catch {
      setDeletedFiles([]);
    }
  }, [teamId]);

  // dd/fetch-projects + dd/fetch-deleted-files + dd/clear-selected-files on
  // every team change.
  useEffect(() => {
    setDeletedFiles(null);
    clearSelection();
    void loadDeletedFiles();
    void refreshProjects();
    // clearSelection is a stable callback; refreshProjects only depends on the
    // team, which this effect already keys on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, loadDeletedFiles]);

  const shown = useMemo(
    () => deletedProjectsFor(projects, deletedFiles ?? []),
    [projects, deletedFiles],
  );

  const days = deletionDays(subscriptionType(team?.subscription));

  // dd/restore-files and dd/delete-files: initialize the progress widget, feed
  // it every progress block, then refresh both lists and raise the toast. An
  // error clears the widget and raises the failure copy instead.
  const runBulk = useCallback(
    async (kind: "restore" | "delete", ids: string[], labels: BulkLabels) => {
      if (teamId === null || ids.length === 0) return;
      const restore = kind === "restore";
      startProgress({
        total: ids.length,
        hints: {
          progress: () =>
            restore
              ? tr("dashboard.progress-notification.restoring-files")
              : tr("dashboard.progress-notification.deleting-files"),
          slow: () =>
            restore
              ? tr("dashboard.progress-notification.slow-restore")
              : tr("dashboard.progress-notification.slow-delete"),
        },
      });
      const run = restore ? restoreDeletedTeamFiles : permanentlyDeleteTeamFiles;
      try {
        await run(teamId, ids, {
          onProgress: (payload) => {
            const { index, total } = payload;
            // The CLJS flow drops a progress block without both counters.
            if (typeof index !== "number" || typeof total !== "number") return;
            updateProgress(index, total);
          },
        });
        clearProgress();
        await Promise.all([refreshProjects(), loadDeletedFiles()]);
        notifySuccess(labels.success);
      } catch {
        clearProgress();
        notifyError(labels.error);
      }
    },
    [
      teamId,
      startProgress,
      updateProgress,
      clearProgress,
      refreshProjects,
      loadDeletedFiles,
      notifySuccess,
      notifyError,
    ],
  );

  const nameOf = useCallback(
    (id: string) => (deletedFiles ?? []).find((row) => row.id === id)?.name ?? "",
    [deletedFiles],
  );

  // restore-files-immediately and delete-files-immediately pick the copy from
  // the id count and read the single file's name out of the trash. Both are
  // resolved before the stream starts, because the refresh empties the list.
  const restoreLabels = useCallback(
    (ids: string[]): BulkLabels =>
      ids.length === 1
        ? {
            success: tr("dashboard.restore-success-notification", nameOf(ids[0] ?? "")),
            error: tr("dashboard.errors.error-on-restore-file", nameOf(ids[0] ?? "")),
          }
        : {
            success: tr("dashboard.restore-files-success-notification", ids.length),
            error: tr("dashboard.errors.error-on-restore-files"),
          },
    [nameOf],
  );

  const deleteLabels = useCallback(
    (ids: string[]): BulkLabels => ({
      success:
        ids.length === 1
          ? tr("dashboard.delete-success-notification", nameOf(ids[0] ?? ""))
          : tr("dashboard.delete-files-success-notification", ids.length),
      error: tr("dashboard.errors.error-on-delete-files"),
    }),
    [nameOf],
  );

  const bulk: BulkFileFlows = useMemo(
    () => ({
      restore: async (files) => {
        const ids = files.map((file) => file.id);
        await runBulk("restore", ids, restoreLabels(ids));
      },
      deleteForever: async (files) => {
        const ids = files.map((file) => file.id);
        await runBulk("delete", ids, deleteLabels(ids));
      },
    }),
    [runBulk, restoreLabels, deleteLabels],
  );

  const knownFileNames = useCallback(() => usedNames(deletedFiles ?? []), [deletedFiles]);
  const onFilesChanged = useCallback(async () => {
    await Promise.all([refreshProjects(), loadDeletedFiles()]);
  }, [refreshProjects, loadDeletedFiles]);
  const actions = useFileActions({ teamId, knownFileNames, onFilesChanged, bulk });

  const projectFileIds = useCallback(
    (projectId: string) =>
      (deletedFiles ?? [])
        .filter((row) => row["project-id"] === projectId)
        .map((row) => row.id),
    [deletedFiles],
  );

  // restore-project-immediately: the whole project rides on the same SSE
  // command as its files, so the toast names the project.
  const onRestoreProject = (project: Project) => {
    const ids = projectFileIds(project.id);
    modal.open(
      <ConfirmDialog
        title={tr("dashboard.restore-project-confirmation.title")}
        message={tr("dashboard.restore-project-confirmation.description", project.name)}
        acceptLabel={tr("labels.continue")}
        cancelLabel={tr("labels.cancel")}
        acceptTestId="restore-project-accept"
        onAccept={() => {
          void runBulk("restore", ids, {
            success: tr("dashboard.restore-success-notification", project.name),
            error: tr("dashboard.errors.error-on-restoring-project", project.name),
          });
        }}
      />,
    );
  };

  const onDeleteProject = (project: Project) => {
    const ids = projectFileIds(project.id);
    modal.open(
      <ConfirmDialog
        title={tr("dashboard.delete-forever-confirmation.title")}
        message={tr("dashboard.delete-project-forever-confirmation.description", project.name)}
        acceptLabel={tr("dashboard.delete-forever-confirmation.title")}
        cancelLabel={tr("labels.cancel")}
        destructive
        acceptTestId="delete-project-accept"
        onAccept={() => {
          void runBulk("delete", ids, {
            success: tr("dashboard.delete-success-notification", project.name),
            error: tr("dashboard.errors.error-on-delete-project", project.name),
          });
        }}
      />,
    );
  };

  const onRestoreAll = () => {
    const ids = (deletedFiles ?? []).map((row) => row.id);
    if (ids.length === 0) return;
    const labels = restoreLabels(ids);
    modal.open(
      <ConfirmDialog
        title={tr("dashboard.restore-all-confirmation.title")}
        message={tr("dashboard.restore-all-confirmation.description", ids.length)}
        acceptLabel={tr("labels.continue")}
        cancelLabel={tr("labels.cancel")}
        acceptTestId="restore-all-accept"
        onAccept={() => {
          void runBulk("restore", ids, labels);
        }}
      />,
    );
  };

  const onDeleteAll = () => {
    const ids = (deletedFiles ?? []).map((row) => row.id);
    if (ids.length === 0) return;
    const labels = deleteLabels(ids);
    modal.open(
      <ConfirmDialog
        title={tr("dashboard.delete-forever-confirmation.title")}
        message={tr("dashboard.delete-all-forever-confirmation.description", ids.length)}
        acceptLabel={tr("dashboard.delete-forever-confirmation.title")}
        cancelLabel={tr("labels.cancel")}
        destructive
        acceptTestId="clear-trash-accept"
        onAccept={() => {
          void runBulk("delete", ids, labels);
        }}
      />,
    );
  };

  if (!canEdit) return null;

  return (
    <>
      <header className="pp-dashboard-header" data-testid="dashboard-header">
        <div className="pp-dashboard-title" id="dashboard-deleted-title">
          <h1>{tr("dashboard.projects-title")}</h1>
        </div>
        <div className="pp-dashboard-header-actions">
          <LayoutToggle layout={layout} onChange={onLayoutChange} />
        </div>
      </header>

      <section
        className="pp-dashboard-container pp-dashboard-deleted"
        data-testid="deleted-page-section"
      >
        <DeletedTabs section="dashboard-deleted" teamId={teamId} />

        {shown.length > 0 ? (
          <>
            <div className="pp-deleted-info-content">
              <p className="pp-deleted-info">
                {tr("dashboard.trash-info-text-part1")}
                <span className="pp-info-text-highlight">
                  {tr("dashboard.trash-info-text-part2", days)}
                </span>
                {tr("dashboard.trash-info-text-part3")}
                <br />
                {tr("dashboard.trash-info-text-part4")}
              </p>
              <div className="pp-deleted-options">
                <button
                  type="button"
                  className="pp-btn-secondary"
                  data-testid="restore-all-button"
                  onClick={onRestoreAll}
                >
                  {tr("dashboard.restore-all-deleted-button")}
                </button>
                <button
                  type="button"
                  className="pp-btn-danger"
                  data-testid="clear-trash-button"
                  onClick={onDeleteAll}
                >
                  {tr("dashboard.clear-trash-button")}
                </button>
              </div>
            </div>

            {shown.map((project) => (
              <DeletedProjectItem
                key={project.id}
                project={project}
                files={deletedFilesOf(deletedFiles ?? [], project.id)}
                layout={layout}
                teamId={teamId}
                actions={actions}
                onRestoreProject={onRestoreProject}
                onDeleteProject={onDeleteProject}
              />
            ))}
          </>
        ) : (
          <div className="pp-deleted-info-content">
            <p className="pp-deleted-info" data-testid="deleted-empty-state">
              {tr("dashboard.deleted.empty-state-description")}
            </p>
          </div>
        )}
      </section>
    </>
  );
}
