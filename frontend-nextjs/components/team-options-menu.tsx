"use client";

// The "..." team-management menu of the dashboard sidebar (F5.5 follow-up):
// options-dropdown* in app.main.ui.dashboard.organization-team-switch-menus.
// In CLJS the button hangs off the organization/team switcher's closed
// control; the switcher itself (the two-column dropdown with its
// organizations column) arrives with F5.7, so the button sits next to the
// sidebar's team header and carries the team-management items only. The
// "leave organization" entry and the organization branches behind it arrive
// with F5.7 together with the switcher.
//
// Deviations from the CLJS original, documented:
// - The button renders without the switcher control it belongs to; its
//   visibility rule (a default team has no options of its own, and without
//   organizations there is no "leave organization" action either) is kept.
// - The navigation items keep the dashboard-local navigation contract, like
//   the team header entries.
// - The menu counts the fresh member rows before the leave branches, because
//   the shell's team rows carry no member list; the CLJS menu reads the
//   members attached to the store's team.

import { useCallback, useState } from "react";
import {
  DashboardMenu,
  menuAnchorFromElement,
  type MenuAnchor,
  type MenuEntry,
} from "@/components/dashboard-menu";
import { useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { NoPermissionModal } from "@/components/team-invite";
import { TeamFormModal } from "@/components/team-form-modal";
import { useTeamLeaveFlows } from "@/components/team-leave-flows";
import { hasFlag } from "@/lib/config";
import { useDashboard } from "@/lib/dashboard-context";
import { tr } from "@/lib/i18n";
import type { RouteName } from "@/lib/routes";
import { getTeamMembers } from "@/lib/team";

export function TeamOptionsButton() {
  const { team, teamId, members, navigate, refreshTeams } = useDashboard();
  const { onLeave, onDeleteTeam } = useTeamLeaveFlows();
  const notifications = useNotifications();
  const modal = useModal();
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);

  const openRename = useCallback(() => {
    if (team === null) return;
    modal.open(
      <TeamFormModal
        team={{ id: team.id, name: team.name }}
        onToast={(message) => notifications.success(message)}
        onNoPermission={() =>
          modal.open(
            <NoPermissionModal
              permissionType="create-team"
              organizationName={team["organization-name"] ?? null}
            />,
          )
        }
        onTeamsChanged={refreshTeams}
      />,
    );
  }, [team, modal, notifications, refreshTeams]);

  // The leave branches need a member count; fetch the fresh rows like the
  // reassign flow does, falling back to whatever the dashboard already has.
  const onLeaveClick = useCallback(async () => {
    if (teamId === null) return;
    let rows = members ?? [];
    try {
      const fresh = await getTeamMembers(teamId);
      if (Array.isArray(fresh)) rows = fresh;
    } catch {
      // Keep the rows the dashboard already has, like the CLJS store would.
    }
    onLeave(rows.length);
  }, [teamId, members, onLeave]);

  // show-team-options-button? in organization-team-switch*: a default team
  // has no members/settings of its own to manage.
  if (team === null || team["is-default"] === true) return null;

  const canRename =
    team.permissions?.["is-owner"] === true || team.permissions?.["is-admin"] === true;
  const isOwner = team.permissions?.["is-owner"] === true;

  const go = (route: RouteName) => navigate(route, { projectId: null, searchTerm: null });

  const entries: MenuEntry[] = [
    {
      type: "item",
      id: "team-members",
      label: tr("labels.members"),
      onSelect: () => go("dashboard-members"),
    },
    {
      type: "item",
      id: "team-invitations",
      label: tr("labels.invitations"),
      onSelect: () => go("dashboard-invitations"),
    },
    ...(hasFlag("webhooks")
      ? [
          {
            type: "item" as const,
            id: "team-webhooks",
            label: tr("labels.webhooks"),
            onSelect: () => go("dashboard-webhooks"),
          },
        ]
      : []),
    {
      type: "item",
      id: "team-settings",
      label: tr("labels.settings"),
      onSelect: () => go("dashboard-settings"),
    },
    { type: "separator", id: "team-options-separator" },
    ...(canRename
      ? [
          {
            type: "item" as const,
            id: "rename-team",
            label: tr("labels.rename"),
            onSelect: openRename,
          },
        ]
      : []),
    {
      type: "item",
      id: "leave-team",
      label: tr("dashboard.leave-team"),
      onSelect: () => {
        void onLeaveClick();
      },
    },
    ...(isOwner
      ? [
          {
            type: "item" as const,
            id: "delete-team",
            label: tr("dashboard.delete-team"),
            danger: true,
            onSelect: () => {
              void onDeleteTeam();
            },
          },
        ]
      : []),
  ];

  return (
    <>
      <button
        type="button"
        className="pp-icon-btn"
        aria-label={tr("labels.team-management")}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        data-testid="team-options-button"
        onClick={(event) => {
          const element = event.currentTarget;
          setAnchor((current) =>
            current !== null ? null : menuAnchorFromElement(element, "bottom-end"),
          );
        }}
      >
        <span aria-hidden="true">…</span>
      </button>

      {anchor !== null ? (
        <DashboardMenu anchor={anchor} entries={entries} onClose={() => setAnchor(null)} />
      ) : null}
    </>
  );
}
