"use client";

// Recent files / projects section (F5.1 shell, F5.2 full grid). Port of
// header*, project-item* and projects-section* in
// app.main.ui.dashboard.projects, now with the real line-grid (selection,
// context menus, drag-to-move between projects, layout toggle, inline
// project rename) and, from F5.3, the Recent/Deleted tab strip that
// projects-section* renders above the rows for a profile that can edit.
//
// Deviations from the CLJS original, documented:
// - team-hero (invite-members banner) waits for F5.5, the templates section
//   and the dashboard shortcuts registry for F5.6.
// - The project menu omits the import entry (binfile flow, F5.6); with every
//   other entry gated on a non-default project, the Drafts row has no menu.
// - create-project enters inline rename through the page-level
//   editingProjectId (the CLJS dashboard-local :project-for-edit), but the
//   generated unique name stays until the user edits it, same as F5.1.

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { menuAnchorFromElement, menuAnchorFromEvent, type MenuAnchor } from "@/components/dashboard-menu";
import { LineGrid, useDynamicGridItemWidth } from "@/components/dashboard-grid";
import { DeletedTabs } from "@/components/deleted-tabs";
import { useFileActions } from "@/components/file-menu";
import { InlineEdition } from "@/components/inline-edition";
import { LayoutToggle, useDashboardLayout } from "@/components/layout-toggle";
import { useNotifications } from "@/components/notifications";
import { ProjectMenuPopup, useProjectActions } from "@/components/project-menu";
import {
  createFile,
  createProject,
  dashboardHref,
  fileFeatures,
  firstPageId,
  generateUniqueName,
  projectsTitleName,
  recentFilesOf,
  renameProject,
  timeAgo,
  updateProjectPin,
  usedNames,
  visibleProjects,
  workspaceHref,
  type FileSummary,
  type Project,
  type Team,
} from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { useDocumentTitle } from "@/lib/dom";
import { tr } from "@/lib/i18n";

interface ProjectItemProps {
  project: Project;
  team: Team | null;
  teams: Team[];
  projects: Project[];
  teamId: string | null;
  canEdit: boolean;
  layout: "grid" | "list";
  files: FileSummary[];
  allFileNames: Set<string>;
  editingProjectId: string | null;
  onProjectsChanged: () => Promise<void>;
  onFilesChanged: () => Promise<void>;
  actions: ReturnType<typeof useFileActions>;
}

function ProjectItem({
  project,
  team,
  teams,
  projects,
  teamId,
  canEdit,
  layout,
  files,
  allFileNames,
  editingProjectId,
  onProjectsChanged,
  onFilesChanged,
  actions,
}: ProjectItemProps) {
  const router = useRouter();
  const notifications = useNotifications();
  const [rowRef, limit] = useDynamicGridItemWidth();
  // project-item* initializes :edition from dashboard-local :project-for-edit,
  // which dd/create-project sets for the row it just created.
  const [edition, setEdition] = useState(project.id === editingProjectId);
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  const [busy, setBusy] = useState(false);

  const isDraft = project["is-default"] === true;
  const name = isDraft ? tr("labels.drafts") : project.name;
  const fileCount = project.count ?? 0;
  const time = timeAgo(project["modified-at"]);
  const showMenu = canEdit && !isDraft;

  const onNav = () => {
    router.push(dashboardHref("dashboard-files", { teamId, projectId: project.id }));
  };

  const otherTeams = useMemo(() => teams.filter((row) => row.id !== teamId), [teams, teamId]);

  const projectActions = useProjectActions({
    project,
    projects,
    onRename: () => {
      setMenuAnchor(null);
      setEdition(true);
    },
    onProjectsChanged,
  });

  const onEditEnd = async (value: string) => {
    setEdition(false);
    const trimmed = value.trim();
    if (trimmed === "") return;
    try {
      await renameProject({ id: project.id, name: trimmed });
      await onProjectsChanged();
    } catch {
      notifications.error(tr("errors.generic"));
    }
  };

  const onTogglePin = async () => {
    if (teamId === null) return;
    setBusy(true);
    try {
      await updateProjectPin({
        "team-id": teamId,
        id: project.id,
        "is-pinned": project["is-pinned"] !== true,
      });
      await onProjectsChanged();
    } catch {
      notifications.error(tr("errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  // header* create-file (dd/create-file + on-file-created).
  const onCreateFile = async () => {
    setBusy(true);
    try {
      const created = await createFile({
        "project-id": project.id,
        name: generateUniqueName(tr("dashboard.new-file-prefix"), allFileNames, {
          immediateSuffix: true,
        }),
        features: fileFeatures(team),
      });
      router.push(workspaceHref({ teamId, fileId: created.id, pageId: firstPageId(created) }));
    } catch {
      notifications.error(tr("errors.generic"));
      setBusy(false);
    }
  };

  // loading? in project-item*: the row shows the loading placeholder while
  // the count says there are files but none arrived yet.
  const loading = (project.count ?? 0) > 0 && files.length === 0;
  const emptyViewer = !canEdit && fileCount === 0;
  const hasOther =
    projects.some((row) => row["is-default"] !== true) || files.length > 0 || fileCount > 0;

  return (
    <article className="pp-project-row">
      <header className="pp-project">
        <div className="pp-project-name-wrapper">
          {edition && canEdit ? (
            <InlineEdition content={project.name} onEnd={(value) => void onEditEnd(value)} maxLength={250} />
          ) : (
            <h2
              className="pp-project-name"
              title={name}
              data-testid={"project-title-" + project.id}
              onClick={onNav}
              onContextMenu={(event) => {
                if (!showMenu) return;
                event.preventDefault();
                setMenuAnchor(menuAnchorFromEvent(event));
              }}
            >
              {name}
            </h2>
          )}
        </div>
        <div className="pp-info-wrapper">
          <div className="pp-project-info">
            <span className="pp-info">{tr("labels.num-of-files", fileCount)}</span>
            {time !== null ? <span className="pp-info">{", " + time}</span> : null}
          </div>
          <div
            className={
              project["is-pinned"] === true
                ? "pp-project-actions pp-pinned-project"
                : "pp-project-actions"
            }
          >
            {isDraft ? null : (
              <button
                type="button"
                className="pp-icon-btn"
                disabled={busy}
                aria-label={tr("dashboard.pin-unpin")}
                aria-pressed={project["is-pinned"] === true}
                data-testid={"pin-" + project.id}
                onClick={(event) => {
                  event.stopPropagation();
                  void onTogglePin();
                }}
              >
                {"\u2691"}
              </button>
            )}
            {canEdit ? (
              <button
                type="button"
                className="pp-icon-btn"
                disabled={busy}
                aria-label={tr("dashboard.new-file")}
                data-testid={"new-file-" + project.id}
                onClick={() => {
                  void onCreateFile();
                }}
              >
                +
              </button>
            ) : null}
            {showMenu ? (
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
                    current === null ? menuAnchorFromElement(element, "bottom-start") : null,
                  );
                }}
              >
                <span aria-hidden="true">…</span>
              </button>
            ) : null}
          </div>
          {limit > 0 && fileCount > limit ? (
            <button type="button" className="pp-show-more" data-testid="show-all-files" onClick={onNav}>
              {tr("dashboard.show-all-files")}
              <span aria-hidden="true">→</span>
            </button>
          ) : null}
        </div>
      </header>

      {menuAnchor !== null && showMenu ? (
        <ProjectMenuPopup
          otherTeams={otherTeams}
          anchor={menuAnchor}
          actions={projectActions}
          onClose={() => setMenuAnchor(null)}
        />
      ) : null}

      <div className="pp-grid-container" ref={rowRef}>
        {emptyViewer ? (
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
          <LineGrid
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
            onFilesMoved={onFilesChanged}
          />
        )}
      </div>
    </article>
  );
}

export default function DashboardRecentPage() {
  const {
    team,
    teams,
    projects,
    recentFiles,
    canEdit,
    teamId,
    refreshProjects,
    refreshRecentFiles,
  } = useDashboard();
  const notifications = useNotifications();
  const [busy, setBusy] = useState(false);
  const [layout, onLayoutChange] = useDashboardLayout();
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);

  // The title effect in projects-section*.
  useDocumentTitle(
    tr("title.dashboard.projects", projectsTitleName(team, tr("dashboard.personal-projects"))),
  );

  const visible = useMemo(() => visibleProjects(projects), [projects]);
  const allFileNames = useMemo(() => usedNames(recentFiles), [recentFiles]);

  const onFilesChanged = useCallback(async () => {
    await Promise.all([refreshProjects(), refreshRecentFiles()]);
  }, [refreshProjects, refreshRecentFiles]);

  const knownFileNames = useCallback(() => allFileNames, [allFileNames]);

  const actions = useFileActions({ teamId, knownFileNames, onFilesChanged });

  // dd/create-project: create the row and open inline rename on it (the CLJS
  // event stores the new id in dashboard-local :project-for-edit).
  const onCreateProject = async () => {
    if (teamId === null) return;
    setBusy(true);
    try {
      const created = await createProject({
        "team-id": teamId,
        name: generateUniqueName(tr("dashboard.new-project-prefix"), usedNames(projects), {
          immediateSuffix: true,
        }),
      });
      await refreshProjects();
      setEditingProjectId(created.id);
    } catch {
      notifications.error(tr("errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="pp-dashboard-header" data-testid="dashboard-header">
        <div className="pp-dashboard-title" id="dashboard-projects-title">
          <h1>
            {team?.["is-default"] === true
              ? tr("dashboard.personal-projects")
              : tr("dashboard.projects-title")}
          </h1>
        </div>
        <div className="pp-dashboard-header-actions">
          <LayoutToggle layout={layout} onChange={onLayoutChange} />
          {canEdit ? (
            <button
              type="button"
              className="pp-btn-secondary"
              disabled={busy}
              data-testid="new-project-button"
              onClick={() => {
                void onCreateProject();
              }}
            >
              {tr("dashboard.new-project")}
            </button>
          ) : null}
        </div>
      </header>

      <div className="pp-dashboard-projects" data-testid="projects-container">
        {canEdit ? <DeletedTabs section="dashboard-recent" teamId={teamId} /> : null}
        {visible.map((project) => (
          <ProjectItem
            key={project.id}
            project={project}
            team={team}
            teams={teams}
            projects={projects}
            teamId={teamId}
            canEdit={canEdit}
            layout={layout}
            files={recentFilesOf(recentFiles, project.id)}
            allFileNames={allFileNames}
            editingProjectId={editingProjectId}
            onProjectsChanged={refreshProjects}
            onFilesChanged={onFilesChanged}
            actions={actions}
          />
        ))}
      </div>
    </>
  );
}
