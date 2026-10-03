"use client";

// Project menu (F5.2). Port of app.main.ui.dashboard.project-menu plus the
// project mutation events in app.main.data.dashboard (duplicate-project,
// move-project, delete-project). Shared by the "..." button and the
// right-click menu of a project title in the recent and files views.
//
// Deviations: the "Import files" entry needs the binfile import flow (F5.6)
// and is omitted; telemetry events are dropped like elsewhere in the shell.

import { useRouter } from "next/navigation";
import { DashboardMenu, type MenuAnchor, type MenuEntry } from "@/components/dashboard-menu";
import { ConfirmDialog, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import {
  copySuffixFn,
  dashboardHref,
  deleteProject,
  duplicateProject,
  generateUniqueName,
  moveProject,
  updateProjectPin,
  usedNames,
  type Project,
  type Team,
} from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { tr } from "@/lib/i18n";

export interface ProjectActionDeps {
  project: Project;
  projects: Project[];
  // Enter inline rename mode for this project's title.
  onRename: () => void;
  // Re-fetch the project list after pin/duplicate/delete mutations.
  onProjectsChanged: () => Promise<void> | void;
}

export function useProjectActions(deps: ProjectActionDeps) {
  const { project, projects, onRename, onProjectsChanged } = deps;
  const router = useRouter();
  const modal = useModal();
  const notifications = useNotifications();
  const { clearSelection } = useDashboard();

  const duplicate = async () => {
    try {
      const created = await duplicateProject({
        "project-id": project.id,
        name: generateUniqueName(project.name, usedNames(projects), {
          suffixFn: copySuffixFn(tr("dashboard.copy-suffix")),
        }),
      });
      notifications.success(tr("dashboard.success-duplicate-project"));
      await onProjectsChanged();
      router.push(
        dashboardHref("dashboard-files", {
          teamId: created["team-id"] ?? project["team-id"],
          projectId: created.id,
        }),
      );
    } catch {
      notifications.error(tr("errors.generic"));
    }
  };

  const togglePin = async () => {
    try {
      await updateProjectPin({
        "team-id": project["team-id"],
        id: project.id,
        "is-pinned": project["is-pinned"] !== true,
      });
      await onProjectsChanged();
    } catch {
      notifications.error(tr("errors.generic"));
    }
  };

  const moveTo = async (teamId: string) => {
    try {
      await moveProject({ "project-id": project.id, "team-id": teamId });
      notifications.success(tr("dashboard.success-move-project"));
      clearSelection();
      router.push(dashboardHref("dashboard-recent", { teamId }));
    } catch {
      notifications.error(tr("errors.generic"));
    }
  };

  const requestDelete = () => {
    modal.open(
      <ConfirmDialog
        title={tr("modals.delete-project-confirm.title")}
        message={tr("modals.delete-project-confirm.message")}
        acceptLabel={tr("modals.delete-project-confirm.accept")}
        cancelLabel={tr("labels.cancel")}
        destructive
        acceptTestId="delete-project-accept"
        onAccept={() => {
          void (async () => {
            try {
              await deleteProject({ id: project.id });
              notifications.success(tr("dashboard.success-delete-project"));
              clearSelection();
              router.push(dashboardHref("dashboard-recent", { teamId: project["team-id"] }));
              await onProjectsChanged();
            } catch {
              notifications.error(tr("errors.generic"));
            }
          })();
        }}
      />,
    );
  };

  return { duplicate, togglePin, moveTo, requestDelete, onRename };
}

// project-menu-items*: every entry is gated on a non-default project except
// the (deferred) import, so the Drafts row has no menu at all in the shell.
export function buildProjectMenuEntries(options: {
  otherTeams: Team[];
  actions: {
    onRename: () => void;
    duplicate: () => Promise<void>;
    togglePin: () => Promise<void>;
    moveTo: (teamId: string) => Promise<void>;
    requestDelete: () => void;
  };
}): MenuEntry[] {
  const { otherTeams, actions } = options;
  const entries: MenuEntry[] = [
    { type: "item", id: "project-rename", label: tr("labels.rename"), onSelect: actions.onRename },
    {
      type: "item",
      id: "project-duplicate",
      label: tr("dashboard.duplicate"),
      onSelect: () => {
        void actions.duplicate();
      },
    },
    {
      type: "item",
      id: "project-pin",
      label: tr("dashboard.pin-unpin"),
      onSelect: () => {
        void actions.togglePin();
      },
    },
  ];
  if (otherTeams.length > 0) {
    entries.push({
      type: "submenu",
      id: "project-move-to",
      label: tr("dashboard.move-to"),
      items: otherTeams.map((team) => ({
        type: "item",
        id: "move-to-" + team.id,
        label: team.name,
        onSelect: () => {
          void actions.moveTo(team.id);
        },
      })),
    });
  }
  entries.push(
    { type: "separator", id: "project-delete-separator" },
    {
      type: "item",
      id: "project-delete",
      label: tr("labels.delete"),
      danger: true,
      onSelect: actions.requestDelete,
    },
  );
  return entries;
}

export interface ProjectMenuPopupProps {
  otherTeams: Team[];
  anchor: MenuAnchor;
  actions: ReturnType<typeof useProjectActions>;
  onClose: () => void;
}

export function ProjectMenuPopup({
  otherTeams,
  anchor,
  actions,
  onClose,
}: ProjectMenuPopupProps) {
  const entries = buildProjectMenuEntries({ otherTeams, actions });
  return (
    <DashboardMenu anchor={anchor} entries={entries} onClose={onClose} ariaLabel={tr("dashboard.options")} />
  );
}
