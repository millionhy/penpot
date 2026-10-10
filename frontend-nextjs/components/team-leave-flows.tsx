"use client";

// Leave and delete flows of the team pages (F5.5 follow-up), shared between
// the members page and the sidebar's team-management menu. Port of the
// leave/delete slice of app.main.ui.dashboard.team (the three on-leave
// branches with their confirm modals) and of check-and-delete-team in
// app.main.data.team.
//
// Deviations from the CLJS original, documented:
// - check-and-delete-team resolves can-delete? on the freshly fetched team
//   row: the organization rules of cto/allowed? behind the :admin-console
//   flag, the is-owner fallback otherwise (see onDeleteTeam).
// - on-change-owner-and-leave emits fetch-members then opens the modal in one
//   tick in CLJS; the shell's modal host lives outside the dashboard
//   providers, so the flow fetches the member rows and hands them to the
//   modal as a snapshot.
// - go-to-dashboard-recent :team-id :default refreshes get-teams first and
//   pushes the profile's default-team-id, because navigate() keeps the
//   current team.

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { LeaveAndReassignModal } from "@/components/leave-and-reassign-modal";
import { ConfirmDialog, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { NoPermissionModal } from "@/components/team-invite";
import { hasFlag } from "@/lib/config";
import { dashboardHref } from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { RpcError } from "@/lib/errors";
import { tr } from "@/lib/i18n";
import { organizationAllowed } from "@/lib/org-switch";
import { useSession } from "@/lib/session";
import {
  deleteTeam,
  getTeamMembers,
  leaveTeam,
  refreshTeamPermissions,
  type TeamMember,
  type TeamWithOrganization,
} from "@/lib/team";

export function useTeamLeaveFlows() {
  const { team, teamId, members, refreshTeams } = useDashboard();
  const { profile } = useSession();
  const modal = useModal();
  const notifications = useNotifications();
  const router = useRouter();

  // go-to-dashboard-recent :team-id :default: refresh the teams first so the
  // left/deleted team leaves the context, then land on the default team.
  const goToDefaultTeam = useCallback(async () => {
    await refreshTeams();
    router.push(
      dashboardHref("dashboard-recent", { teamId: profile?.["default-team-id"] ?? null }),
    );
  }, [refreshTeams, router, profile]);

  // on-error of team-member*: the team-leave error codes plus the generic
  // fallback the CLJS (rx/throw) resolves to at the notification layer.
  const onLeaveError = useCallback(
    (err: unknown) => {
      const code = err instanceof RpcError ? err.data.code : undefined;
      if (code === "no-enough-members-for-leave") {
        notifications.error(tr("errors.team-leave.insufficient-members"));
      } else if (code === "member-does-not-exist") {
        notifications.error(tr("errors.team-leave.member-does-not-exists"));
      } else if (code === "owner-cant-leave-team") {
        notifications.error(tr("errors.team-leave.owner-cant-leave"));
      } else {
        notifications.error(tr("errors.generic"));
      }
    },
    [notifications],
  );

  // on-leave-accepted: :reassign-to only travels from the reassign modal.
  const onLeaveAccepted = useCallback(
    async (reassignTo: string | null) => {
      if (teamId === null) return;
      try {
        await leaveTeam(teamId, reassignTo);
        await goToDefaultTeam();
      } catch (err) {
        onLeaveError(err);
      }
    },
    [teamId, goToDefaultTeam, onLeaveError],
  );

  // on-delete-accepted of the leave-and-close step: delete-team runs with the
  // same success/error contract as the leave.
  const onDeleteTeamAccepted = useCallback(async () => {
    if (teamId === null) return;
    try {
      await deleteTeam(teamId);
      await goToDefaultTeam();
    } catch (err) {
      onLeaveError(err);
    }
  }, [teamId, goToDefaultTeam, onLeaveError]);

  const onLeaveAndClose = useCallback(() => {
    if (team === null) return;
    modal.open(
      <ConfirmDialog
        title={tr("modals.leave-confirm.title")}
        message={tr("modals.leave-and-close-confirm.message", team.name)}
        hint={tr("modals.leave-and-close-confirm.hint")}
        acceptLabel={tr("modals.leave-confirm.accept")}
        cancelLabel={tr("labels.cancel")}
        onAccept={() => {
          void onDeleteTeamAccepted();
        }}
      />,
    );
  }, [team, modal, onDeleteTeamAccepted]);

  // on-change-owner-and-leave: the fresh member rows go to the modal snapshot
  // (the CLJS modal reads the store reactively; the shell cannot).
  const onChangeOwnerAndLeave = useCallback(async () => {
    if (team === null || teamId === null) return;
    let rows: TeamMember[] = members ?? [];
    try {
      const fresh = await getTeamMembers(teamId);
      if (Array.isArray(fresh)) rows = fresh;
    } catch {
      // Keep the rows the page already has, like the CLJS store would.
    }
    modal.open(
      <LeaveAndReassignModal
        teamName={team.name}
        members={rows}
        profileEmail={profile?.email ?? null}
        onAccept={(memberId) => {
          void onLeaveAccepted(memberId);
        }}
      />,
    );
  }, [team, teamId, members, profile, modal, onLeaveAccepted]);

  // on-leave' of team-member*: one member left means the team goes with it;
  // the owner picks a successor; everyone else confirms a plain leave.
  const onLeave = useCallback(
    (totalMembers: number) => {
      const isOwner = team?.permissions?.["is-owner"] === true;
      if (totalMembers === 1) {
        onLeaveAndClose();
        return;
      }
      if (isOwner) {
        void onChangeOwnerAndLeave();
        return;
      }
      modal.open(
        <ConfirmDialog
          title={tr("modals.leave-confirm.title")}
          message={tr("modals.leave-confirm.message")}
          acceptLabel={tr("modals.leave-confirm.accept")}
          cancelLabel={tr("labels.cancel")}
          onAccept={() => {
            void onLeaveAccepted(null);
          }}
        />,
      );
    },
    [team, modal, onLeaveAndClose, onChangeOwnerAndLeave, onLeaveAccepted],
  );

  // check-and-delete-team: fetch the teams, decide can-delete? on the fresh
  // row (the organization rules when the admin-console runs and the team has
  // an organization, the is-owner fallback otherwise), then confirm or open
  // the no-permission modal.
  const onDeleteTeam = useCallback(async () => {
    if (teamId === null) return;
    let freshTeam: TeamWithOrganization | null = null;
    try {
      const result = await refreshTeamPermissions(teamId, profile?.id);
      freshTeam = result.team;
    } catch {
      // with-refreshed-team fails the whole event when get-teams fails; the
      // shell opens nothing, same as CLJS.
      return;
    }
    // teams-fetched: the same answer updates the stored teams list.
    void refreshTeams();
    const organization = freshTeam?.organization ?? null;
    const inOrganization =
      hasFlag("admin-console") && organization !== null && organization !== undefined;
    const canDelete =
      freshTeam !== null &&
      (inOrganization
        ? organizationAllowed("delete-team", {
            organizationPerms: organization,
            profileId: profile?.id,
            teamPerms: freshTeam.permissions,
          })
        : freshTeam.permissions?.["is-owner"] === true);
    if (!canDelete) {
      modal.open(
        <NoPermissionModal
          permissionType="delete-team"
          organizationName={freshTeam?.organization?.name ?? null}
        />,
      );
      return;
    }
    modal.open(
      <ConfirmDialog
        title={tr("modals.delete-team-confirm.title")}
        message={
          inOrganization
            ? tr("modals.delete-organization-team-confirm.message", organization.name ?? "")
            : tr("modals.delete-team-confirm.message")
        }
        acceptLabel={tr("modals.delete-team-confirm.accept")}
        cancelLabel={tr("labels.cancel")}
        onAccept={() => {
          void onDeleteTeamAccepted();
        }}
      />,
    );
  }, [teamId, profile, modal, refreshTeams, onDeleteTeamAccepted]);

  return { onLeave, onDeleteTeam };
}
