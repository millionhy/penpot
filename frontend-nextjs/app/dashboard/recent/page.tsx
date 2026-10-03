"use client";

// Recent files / projects section (F5.1). Port of header*, project-item* and
// projects-section* in app.main.ui.dashboard.projects.
//
// The file grid is simplified to plain cards: grid.cljs (media-worker
// thumbnails, multi-select, context menus, drag & drop) arrives with F5.2, so
// a card is a link that navigates on click instead of joining a selection. The
// team hero (invite-members banner) waits for the invitations flow (F5.5), the
// templates section for F5.6 and the layout toggle for F5.2.
//
// Documented deviations:
// - dd/create-project puts the new row into inline rename right away; inline
//   edition arrives with F5.2, so the generated unique name stays.
// - dd/create-file computes name uniqueness from every file loaded for the
//   team; the shell only has the team recent files, so uniqueness is scoped to
//   those. The backend does not enforce unique file names.
// - project-item* renders a loading placeholder while count > 0 and the files
//   are still unfetched; the shell shows labels.loading in the same case.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useNotifications } from "@/components/notifications";
import {
  createFile,
  createProject,
  dashboardHref,
  fileFeatures,
  firstPageId,
  generateUniqueName,
  projectsTitleName,
  recentFilesOf,
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

function FileCard({ file, teamId }: { file: FileSummary; teamId: string | null }) {
  const href = workspaceHref({ teamId, fileId: file.id });
  const time = timeAgo(file["modified-at"]);
  return (
    <li className="pp-grid-item">
      <Link
        className="pp-grid-item-button"
        href={href}
        title={file.name}
        aria-label={file.name}
        data-testid={"file-" + file.id}
      >
        {/* The media-worker thumbnail slot arrives with the full grid (F5.2). */}
        <div className="pp-grid-item-thumbnail" aria-hidden="true" />
        <h3 className="pp-grid-item-name">{file.name}</h3>
        {file["is-shared"] === true ? (
          <span
            className="pp-grid-item-badge"
            aria-label={tr("workspace.assets.shared-library")}
            title={tr("workspace.assets.shared-library")}
          >
            {"\u29c9"}
          </span>
        ) : null}
        {time !== null ? (
          <span className="pp-grid-item-date" title={tr("dashboard.grid.last-modified-at", time)}>
            {time}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

function EmptyPlaceholder({ isDraft }: { isDraft: boolean }) {
  return (
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
  );
}

function ProjectSection({
  project,
  team,
  teamId,
  canEdit,
  files,
  allFileNames,
}: {
  project: Project;
  team: Team | null;
  teamId: string | null;
  canEdit: boolean;
  files: FileSummary[];
  allFileNames: Set<string>;
}) {
  const router = useRouter();
  const notifications = useNotifications();
  const { refreshProjects } = useDashboard();
  const [busy, setBusy] = useState(false);

  const isDraft = project["is-default"] === true;
  const name = isDraft ? tr("labels.drafts") : project.name;
  const fileCount = project.count ?? 0;
  const time = timeAgo(project["modified-at"]);
  const filesHref = dashboardHref("dashboard-files", { teamId, projectId: project.id });

  // dd/toggle-project-pin.
  const onTogglePin = async () => {
    if (teamId === null) return;
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

  // dd/create-file plus on-file-created: the new file opens straight in the
  // workspace on its first page.
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

  return (
    <article className="pp-project-row">
      <header className="pp-project">
        <div className="pp-project-name-wrapper">
          {/* The context-menu wrapper (rename, duplicate, move, delete) arrives
              with the full grid in F5.2; the name links to the files route the
              way on-nav does. */}
          <Link className="pp-project-name" href={filesHref} title={name}>
            <h2>{name}</h2>
          </Link>
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
                onClick={() => {
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
          </div>
        </div>
      </header>

      {files.length > 0 ? (
        <ul className="pp-grid-row">
          {files.map((file) => (
            <FileCard key={file.id} file={file} teamId={teamId} />
          ))}
        </ul>
      ) : fileCount > 0 ? (
        <p className="pp-muted pp-grid-loading" data-testid="files-loading">
          {tr("labels.loading")}
        </p>
      ) : (
        <EmptyPlaceholder isDraft={isDraft} />
      )}
    </article>
  );
}

export default function DashboardRecentPage() {
  const { team, projects, recentFiles, canEdit, teamId, refreshProjects } = useDashboard();
  const notifications = useNotifications();
  const [busy, setBusy] = useState(false);

  // The title effect in projects-section*.
  useDocumentTitle(
    tr("title.dashboard.projects", projectsTitleName(team, tr("dashboard.personal-projects"))),
  );

  const visible = useMemo(() => visibleProjects(projects), [projects]);
  const allFileNames = useMemo(() => usedNames(recentFiles), [recentFiles]);

  // dd/create-project: generate a unique name from the team's projects and
  // create the row right away (no modal in the CLJS original either).
  const onCreateProject = async () => {
    if (teamId === null) return;
    setBusy(true);
    try {
      await createProject({
        "team-id": teamId,
        name: generateUniqueName(tr("dashboard.new-project-prefix"), usedNames(projects), {
          immediateSuffix: true,
        }),
      });
      await refreshProjects();
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
        {visible.map((project) => (
          <ProjectSection
            key={project.id}
            project={project}
            team={team}
            teamId={teamId}
            canEdit={canEdit}
            files={recentFilesOf(recentFiles, project.id)}
            allFileNames={allFileNames}
          />
        ))}
      </div>
    </>
  );
}
