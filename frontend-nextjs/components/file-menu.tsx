"use client";

// File menu (F5.2). Port of app.main.ui.dashboard.file-menu: the shared item
// list behind both the "..." button and the right-click context menu of a
// grid item, plus the mutation flows in app.main.data.dashboard that the
// items trigger (rename, duplicate, move, delete, publish/unpublish).
//
// Deviations from the CLJS original, documented:
// - "download-binary-file" / "export-binary-multi" open the binfile export
//   dialog, which arrives with the import/export slice (F5.6); the entries
//   are omitted until then.
// - The can-restore branch (deleted files view) arrives with F5.3.
// - set-file-shared no longer fetches get-file-summary a second time for the
//   telemetry event; the shell has no analytics seam.
// - get-all-projects is fetched when the menu opens instead of on every
//   mounted grid item.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DashboardMenu,
  type MenuAnchor,
  type MenuEntry,
  type MenuEntryItem,
  type MenuEntrySubmenu,
} from "@/components/dashboard-menu";
import { DeleteSharedDialog } from "@/components/delete-shared-dialog";
import { ConfirmDialog, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import {
  copySuffixFn,
  dashboardHref,
  deleteFile,
  duplicateFile,
  generateUniqueName,
  getFileSummary,
  getAllProjects,
  groupProjectsByTeam,
  moveFiles,
  renameFile,
  setFileShared,
  workspaceHref,
  type AllProject,
  type FileSummary,
} from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { tr } from "@/lib/i18n";

export interface FileActionDeps {
  teamId: string | null;
  // Names in scope for the duplicate unique-name computation (the CLJS event
  // reads the store's :files map; the pages pass the files they show).
  knownFileNames: () => Iterable<string>;
  // Re-fetch hook after mutations that do not navigate away.
  onFilesChanged: () => void | Promise<void>;
}

export interface FileActions {
  openNewTab: (file: FileSummary) => void;
  requestRename: (file: FileSummary) => void;
  rename: (file: FileSummary, name: string) => Promise<void>;
  duplicate: (files: FileSummary[]) => Promise<void>;
  requestDelete: (files: FileSummary[]) => void;
  requestMove: (files: FileSummary[], destTeamId: string, destProjectId: string) => void;
  requestPublish: (file: FileSummary) => void;
  requestUnpublish: (files: FileSummary[]) => void;
}

export function useFileActions(deps: FileActionDeps): FileActions {
  const { teamId, knownFileNames, onFilesChanged } = deps;
  const router = useRouter();
  const modal = useModal();
  const notifications = useNotifications();
  const { clearSelection, startEditFileName } = useDashboard();

  const openNewTab = (file: FileSummary) => {
    window.open(workspaceHref({ teamId, fileId: file.id }), "_blank", "noopener,noreferrer");
  };

  const requestRename = (file: FileSummary) => {
    startEditFileName(file.id);
  };

  const rename = async (file: FileSummary, name: string) => {
    try {
      await renameFile({ id: file.id, name });
      await onFilesChanged();
    } catch {
      notifications.error(tr("errors.generic"));
    }
  };

  // dd/duplicate-file: " Copy" / " Copy N" suffixes, computed sequentially so
  // duplicating a selection twice over itself keeps unique names.
  const duplicate = async (files: FileSummary[]) => {
    try {
      const names = new Set<string>(knownFileNames());
      const suffix = copySuffixFn(tr("dashboard.copy-suffix"));
      for (const file of files) {
        const newName = generateUniqueName(file.name, names, { suffixFn: suffix });
        await duplicateFile({ "file-id": file.id, name: newName });
        names.add(newName);
      }
      notifications.success(tr("dashboard.success-duplicate-file", files.length));
      await onFilesChanged();
    } catch {
      notifications.error(tr("errors.generic"));
    }
  };

  const doDelete = async (files: FileSummary[]) => {
    try {
      for (const file of files) await deleteFile({ id: file.id });
      notifications.success(tr("dashboard.success-delete-file", files.length));
      clearSelection();
      await onFilesChanged();
    } catch {
      notifications.error(tr("errors.generic"));
    }
  };

  const requestDelete = (files: FileSummary[]) => {
    const sharedCount = files.filter((file) => file["is-shared"] === true).length;
    const count = files.length;
    if (sharedCount > 0) {
      modal.open(
        <DeleteSharedDialog
          origin="delete"
          ids={files.map((file) => file.id)}
          countLibraries={sharedCount}
          onAccept={() => {
            void doDelete(files);
          }}
        />,
      );
      return;
    }
    if (count > 1) {
      modal.open(
        <ConfirmDialog
          title={tr("modals.delete-file-multi-confirm.title", count)}
          message={tr("modals.delete-file-multi-confirm.message", count)}
          acceptLabel={tr("modals.delete-file-multi-confirm.accept", count)}
          cancelLabel={tr("labels.cancel")}
          destructive
          acceptTestId="delete-file-accept"
          onAccept={() => {
            void doDelete(files);
          }}
        />,
      );
      return;
    }
    modal.open(
      <ConfirmDialog
        title={tr("modals.delete-file-confirm.title")}
        message={tr("modals.delete-file-confirm.message")}
        acceptLabel={tr("modals.delete-file-confirm.accept")}
        cancelLabel={tr("labels.cancel")}
        destructive
        acceptTestId="delete-file-accept"
        onAccept={() => {
          void doDelete(files);
        }}
      />,
    );
  };

  const doMove = async (files: FileSummary[], destTeamId: string, destProjectId: string) => {
    try {
      await moveFiles(
        files.map((file) => file.id),
        destProjectId,
      );
      notifications.success(
        files.length > 1 ? tr("dashboard.success-move-files") : tr("dashboard.success-move-file"),
      );
      clearSelection();
      await onFilesChanged();
      // on-move-success always navigates for the dashboard grids (navigate
      // is true in grid.cljs), even inside the same team.
      router.push(
        dashboardHref("dashboard-files", { teamId: destTeamId, projectId: destProjectId }),
      );
    } catch {
      notifications.error(tr("errors.generic"));
    }
  };

  const requestMove = (files: FileSummary[], destTeamId: string, destProjectId: string) => {
    const sharedCount = files.filter((file) => file["is-shared"] === true).length;
    if (sharedCount > 0 && destTeamId !== teamId) {
      modal.open(
        <DeleteSharedDialog
          origin="move"
          ids={files.map((file) => file.id)}
          countLibraries={sharedCount}
          onAccept={() => {
            void doMove(files, destTeamId, destProjectId);
          }}
        />,
      );
      return;
    }
    void doMove(files, destTeamId, destProjectId);
  };

  const doSetShared = async (files: FileSummary[], isShared: boolean) => {
    try {
      for (const file of files) await setFileShared({ id: file.id, "is-shared": isShared });
      await onFilesChanged();
    } catch {
      notifications.error(tr("errors.generic"));
    }
  };

  // dcm/show-shared-dialog: the confirm copy depends on how many assets the
  // file already has, and the cancel button is omitted when it has some.
  const requestPublish = (file: FileSummary) => {
    void (async () => {
      try {
        const summary = await getFileSummary(file.id);
        const count =
          (summary.components?.count ?? 0) +
          (summary.graphics?.count ?? 0) +
          (summary.colors?.count ?? 0) +
          (summary.typographies?.count ?? 0);
        modal.open(
          <ConfirmDialog
            title={tr("modals.add-shared-confirm.message", summary.name ?? file.name)}
            message={
              count === 0
                ? tr("modals.add-shared-confirm-empty.hint")
                : tr("modals.add-shared-confirm.hint")
            }
            acceptLabel={tr("modals.add-shared-confirm.accept")}
            cancelLabel={tr("labels.cancel")}
            hideCancel={count !== 0}
            acceptTestId="add-shared-accept"
            onAccept={() => {
              void doSetShared([file], true);
            }}
          />,
        );
      } catch {
        notifications.error(tr("errors.generic"));
      }
    })();
  };

  const requestUnpublish = (files: FileSummary[]) => {
    modal.open(
      <DeleteSharedDialog
        origin="unpublish"
        ids={files.map((file) => file.id)}
        countLibraries={files.length}
        onAccept={() => {
          void doSetShared(files, false);
        }}
      />,
    );
  };

  return {
    openNewTab,
    requestRename,
    rename,
    duplicate,
    requestDelete,
    requestMove,
    requestPublish,
    requestUnpublish,
  };
}

// file-menu-items*: the entry list, shared by the button menu and the
// context menu. allProjects stays null while get-all-projects is in flight,
// which hides the move-to entries exactly like the CLJS teams* state.
export function buildFileMenuEntries(options: {
  files: FileSummary[];
  canEdit: boolean;
  currentTeamId: string | null;
  allProjects: AllProject[] | null;
  actions: FileActions;
}): MenuEntry[] {
  const { files, canEdit, currentTeamId, allProjects, actions } = options;
  const file = files[0];
  const count = files.length;
  const multi = count > 1;

  const groups = allProjects === null ? [] : groupProjectsByTeam(allProjects);
  const currentTeam = groups.find((group) => group.id === currentTeamId);
  const otherTeams = groups.filter((group) => group.id !== currentTeamId);
  const fileProjectIds = new Set(files.map((row) => row["project-id"]));
  const currentProjects = (currentTeam?.projects ?? []).filter(
    (project) => !fileProjectIds.has(project.id),
  );

  const projectLabel = (project: AllProject) =>
    project["is-default"] === true ? tr("labels.drafts") : project.name;
  const teamLabel = (group: { name: string; isDefault: boolean }) =>
    group.isDefault ? tr("dashboard.personal-projects") : group.name;

  const moveEntries: MenuEntry[] = currentProjects.map(
    (project): MenuEntryItem => ({
      type: "item",
      id: "move-to-" + project.id,
      label: projectLabel(project),
      onSelect: () => {
        if (currentTeamId !== null) actions.requestMove(files, currentTeamId, project.id);
      },
    }),
  );
  if (otherTeams.length > 0) {
    moveEntries.push({
      type: "submenu",
      id: "move-to-other-team",
      label: tr("dashboard.move-to-other-team"),
      items: otherTeams.map(
        (group): MenuEntrySubmenu => ({
          type: "submenu",
          id: "move-to-team-" + group.id,
          label: teamLabel(group),
          items: group.projects.map(
            (project): MenuEntryItem => ({
              type: "item",
              id: "move-to-" + group.id + "-" + project.id,
              label: projectLabel(project),
              onSelect: () => actions.requestMove(files, group.id, project.id),
            }),
          ),
        }),
      ),
    });
  }

  const hasMoveTargets = currentProjects.length > 0 || otherTeams.length > 0;
  const entries: MenuEntry[] = [];

  if (multi) {
    if (canEdit) {
      entries.push({
        type: "item",
        id: "duplicate-multi",
        testId: "duplicate-multi",
        label: tr("dashboard.duplicate-multi", count),
        onSelect: () => {
          void actions.duplicate(files);
        },
      });
    }
    if (canEdit && hasMoveTargets) {
      entries.push({
        type: "submenu",
        id: "file-move-multi",
        label: tr("dashboard.move-to-multi", count),
        items: moveEntries,
      });
    }
    if (file["is-shared"] === true && canEdit) {
      entries.push({
        type: "item",
        id: "file-unpublish-multi",
        label: tr("labels.unpublish-multi-files", count),
        onSelect: () => actions.requestUnpublish(files),
      });
    }
    if (canEdit) {
      entries.push(
        { type: "separator", id: "delete-separator" },
        {
          type: "item",
          id: "file-delete-multi",
          label: tr("labels.delete-multi-files", count),
          danger: true,
          onSelect: () => actions.requestDelete(files),
        },
      );
    }
    return entries;
  }

  entries.push({
    type: "item",
    id: "file-open-new-tab",
    label: tr("dashboard.open-in-new-tab"),
    onSelect: () => actions.openNewTab(file),
  });
  if (canEdit) {
    entries.push({
      type: "item",
      id: "file-rename",
      label: tr("labels.rename"),
      onSelect: () => actions.requestRename(file),
    });
    entries.push({
      type: "item",
      id: "file-duplicate",
      label: tr("dashboard.duplicate"),
      onSelect: () => {
        void actions.duplicate([file]);
      },
    });
    if (hasMoveTargets) {
      entries.push({
        type: "submenu",
        id: "file-move-to",
        label: tr("dashboard.move-to"),
        items: moveEntries,
      });
    }
    entries.push(
      file["is-shared"] === true
        ? {
            type: "item",
            id: "file-shared-toggle",
            label: tr("dashboard.unpublish-shared"),
            onSelect: () => actions.requestUnpublish([file]),
          }
        : {
            type: "item",
            id: "file-shared-toggle",
            label: tr("dashboard.add-shared"),
            onSelect: () => actions.requestPublish(file),
          },
    );
    entries.push(
      { type: "separator", id: "delete-separator" },
      {
        type: "item",
        id: "file-delete",
        label: tr("labels.delete"),
        danger: true,
        onSelect: () => actions.requestDelete([file]),
      },
    );
  }
  return entries;
}

export interface FileMenuPopupProps {
  files: FileSummary[];
  anchor: MenuAnchor;
  canEdit: boolean;
  teamId: string | null;
  actions: FileActions;
  onClose: () => void;
}

export function FileMenuPopup({
  files,
  anchor,
  canEdit,
  teamId,
  actions,
  onClose,
}: FileMenuPopupProps) {
  const [allProjects, setAllProjects] = useState<AllProject[] | null>(null);

  useEffect(() => {
    let live = true;
    getAllProjects()
      .then((rows) => {
        if (live) setAllProjects(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        // Without the project list the move-to entries stay hidden, which is
        // how the CLJS menu behaves while its teams* state is nil.
        if (live) setAllProjects([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const entries = useMemo(
    () => buildFileMenuEntries({ files, canEdit, currentTeamId: teamId, allProjects, actions }),
    [files, canEdit, teamId, allProjects, actions],
  );

  return (
    <DashboardMenu anchor={anchor} entries={entries} onClose={onClose} ariaLabel={tr("dashboard.options")} />
  );
}
