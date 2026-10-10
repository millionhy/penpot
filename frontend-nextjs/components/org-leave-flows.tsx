"use client";

// Leave-organization flow (F5.7a): use-organization-leave plus
// show-leave-organization-modal and the leave-organization event of
// app.main.data.nitrate, wrapped as a hook. The switcher's options menu and
// its organization context menu both open it.
//
// Deviations from the CLJS original, documented:
// - The nitrate-audit event is telemetry; the shell does not send it (see
//   lib/nitrate.ts).
// - The success chain (fetch-teams, go-to-dashboard-recent, modal/hide,
//   toast) runs as an async sequence instead of emitted events, in the same
//   order.
// - org-leave-on-error refreshes the teams and hides the modal before the
//   error toast; an unmapped code falls back to the generic error message,
//   the way the shell's team-leave flows already do (the CLJS rx/throw hands
//   it to the notification layer instead).
// - The CLJS confirm accepts carry the default :danger style; the shell's
//   ConfirmDialog keeps the primary accept its leave/delete confirms already
//   use (the same documented deviation as team-leave-flows).

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { LeaveAndReassignOrgModal } from "@/components/leave-and-reassign-org-modal";
import { ConfirmDialog, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { dashboardHref } from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { RpcError } from "@/lib/errors";
import { tr } from "@/lib/i18n";
import {
  buildTeamsToLeave,
  getLeaveOrganizationSummary,
  leaveOrganization,
  leaveOrganizationModalKind,
  orgLeaveErrorMessage,
  organizationLeaveInfo,
  organizationTeams,
  type LeaveOrganizationSummary,
} from "@/lib/nitrate";
import { useSession } from "@/lib/session";
import type { TeamOrganization } from "@/lib/team";

export interface OrganizationLeaveFlows {
  onLeaveOrganization: (organization: TeamOrganization) => void;
}

export function useOrganizationLeaveFlows(): OrganizationLeaveFlows {
  const { teams, refreshTeams } = useDashboard();
  const { profile } = useSession();
  const modal = useModal();
  const notifications = useNotifications();
  const router = useRouter();

  // org-leave-on-error: the team-leave codes plus the two organization ones;
  // a code without a mapped message keeps the shell's generic fallback.
  const onLeaveError = useCallback(
    (err: unknown) => {
      const code = err instanceof RpcError ? err.data.code : undefined;
      notifications.error(orgLeaveErrorMessage(code) ?? tr("errors.generic"));
    },
    [notifications],
  );

  // leave-organization: run the command, then the success chain — refresh
  // the teams so the left organization drops out, land on the profile's
  // default team, close the modal and toast.
  const runLeave = useCallback(
    async (
      organization: TeamOrganization,
      summary: LeaveOrganizationSummary,
      teamsToTransfer: Array<{ id: string; "reassign-to"?: string }>,
    ) => {
      const { defaultTeamId, notOwnedTeams } = organizationLeaveInfo(
        organizationTeams(teams, organization.id),
      );
      // An organization always carries its default team in the teams list;
      // the summary call already required the same id.
      if (defaultTeamId === undefined) return;
      try {
        await leaveOrganization({
          id: organization.id,
          name: organization.name ?? "",
          "default-team-id": defaultTeamId,
          "teams-to-delete": summary["team-ids-to-delete"],
          "teams-to-leave": buildTeamsToLeave(notOwnedTeams, teamsToTransfer),
        });
        await refreshTeams();
        router.push(
          dashboardHref("dashboard-recent", { teamId: profile?.["default-team-id"] ?? null }),
        );
        modal.close();
        notifications.success(
          tr("dashboard.leave-organization.toast", organization.name ?? ""),
        );
      } catch (err) {
        // org-leave-on-error: refresh and hide first, then toast.
        await refreshTeams();
        modal.close();
        onLeaveError(err);
      }
    },
    [teams, refreshTeams, router, profile, modal, notifications, onLeaveError],
  );

  // show-leave-organization-modal: the summary decides the dialog; the
  // transfer branch hands the selected successors to the same leave command.
  const onLeaveOrganization = useCallback(
    async (organization: TeamOrganization) => {
      const { defaultTeamId } = organizationLeaveInfo(
        organizationTeams(teams, organization.id),
      );
      if (defaultTeamId === undefined) return;
      let summary: LeaveOrganizationSummary;
      try {
        summary = await getLeaveOrganizationSummary(organization.id, defaultTeamId);
      } catch (err) {
        onLeaveError(err);
        return;
      }
      switch (leaveOrganizationModalKind(summary)) {
        case "reassign":
          modal.open(
            <LeaveAndReassignOrgModal
              teams={summary["transferable-teams"]}
              numTeamsToDelete={summary["teams-to-delete"]}
              profileEmail={profile?.email ?? null}
              onAccept={(teamsToTransfer) => {
                void runLeave(organization, summary, teamsToTransfer);
              }}
            />,
          );
          return;
        case "warning":
          modal.open(
            <ConfirmDialog
              title={tr("modals.before-leave-organization.title", organization.name ?? "")}
              message={tr("modals.before-leave-organization.message")}
              errorMessage={tr("modals.before-leave-organization.warning")}
              acceptLabel={tr("modals.leave-organization-confirm.accept")}
              cancelLabel={tr("labels.cancel")}
              onAccept={() => {
                void runLeave(organization, summary, []);
              }}
            />,
          );
          return;
        default:
          modal.open(
            <ConfirmDialog
              title={tr("modals.leave-organization-confirm.title", organization.name ?? "")}
              message={tr("modals.leave-organization-confirm.message")}
              acceptLabel={tr("modals.leave-organization-confirm.accept")}
              cancelLabel={tr("labels.cancel")}
              onAccept={() => {
                void runLeave(organization, summary, []);
              }}
            />,
          );
      }
    },
    [teams, profile, modal, runLeave, onLeaveError],
  );

  return { onLeaveOrganization };
}
