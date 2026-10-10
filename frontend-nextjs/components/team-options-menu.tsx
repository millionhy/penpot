"use client";

// options-dropdown* in app.main.ui.dashboard.organization-team-switch-menus
// (F5.7a): the "..." team-management menu of the dashboard sidebar:
// team members/invitations/webhooks/settings/rename/leave/delete, plus
// "leave organization" when the profile may leave the active organization.
// In CLJS the button hangs off the organization/team switcher's closed
// control; the shell keeps it as a self-contained component that the
// switcher renders in its button row.
//
// Deviations from the CLJS original, documented:
// - The switcher and this button close each other through the CLJS
//   :dropdown/open store event; the shell passes onOpen down so the switcher
//   can close its own dropdown when this menu opens.
// - The navigation items keep the dashboard-local navigation contract, like
//   the team header entries.
// - The menu counts the fresh member rows before the leave branches, because
//   the shell's team rows carry no member list; the CLJS menu reads the
//   members attached to the store's team.
// - "Leave organization" opens the same flow as the switcher's organization
//   context menu (components/org-leave-flows.tsx).

import { useCallback, useMemo, useState } from "react";
import {
  DashboardMenu,
  menuAnchorFromElement,
  type MenuAnchor,
  type MenuEntry,
} from "@/components/dashboard-menu";
import { useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { useOrganizationLeaveFlows } from "@/components/org-leave-flows";
import { NoPermissionModal } from "@/components/team-invite";
import { TeamFormModal } from "@/components/team-form-modal";
import { useTeamLeaveFlows } from "@/components/team-leave-flows";
import { hasFlag } from "@/lib/config";
import { useDashboard } from "@/lib/dashboard-context";
import { tr } from "@/lib/i18n";
import {
  canLeaveOrganization,
  showTeamOptionsButton,
  teamToOrganization,
} from "@/lib/org-switch";
import type { RouteName } from "@/lib/routes";
import { useSession } from "@/lib/session";
import { getTeamMembers } from "@/lib/team";

export interface TeamOptionsButtonProps {
  // Called just before the menu opens so the switcher can close its own
  // dropdown (see the :dropdown/open note above).
  onOpen?: () => void;
}

export function TeamOptionsButton({ onOpen }: TeamOptionsButtonProps) {
  const { team, teamId, members, navigate, refreshTeams } = useDashboard();
  const { profile } = useSession();
  const { onLeave, onDeleteTeam } = useTeamLeaveFlows();
  const { onLeaveOrganization } = useOrganizationLeaveFlows();
  const notifications = useNotifications();
  const modal = useModal();
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);

  // The active team's organization; team->organization resolves it through
  // the team's own id, default team or not.
  const currentOrganization = useMemo(() => teamToOrganization(team), [team]);

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
              organizationName={currentOrganization?.name ?? null}
            />,
          )
        }
        onTeamsChanged={refreshTeams}
      />,
    );
  }, [team, modal, notifications, refreshTeams, currentOrganization]);

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

  const onLeaveOrganizationClick = useCallback(() => {
    if (currentOrganization === null) return;
    onLeaveOrganization(currentOrganization);
  }, [currentOrganization, onLeaveOrganization]);

  // show-team-options-button? in organization-team-switch*: a default team
  // has no members/settings of its own to manage, and the button only stays
  // when there is at least a "leave organization" action behind it.
  const canLeave = canLeaveOrganization(currentOrganization, profile?.id);
  if (team === null || !showTeamOptionsButton(team, canLeave)) return null;

  const canRename =
    team.permissions?.["is-owner"] === true || team.permissions?.["is-admin"] === true;
  const isOwner = team.permissions?.["is-owner"] === true;

  // show-team-management?: a default team (the personal "my teams" bucket,
  // or an organization's own default team) isn't a real, manageable team.
  const showManagement = team["is-default"] !== true;

  const go = (route: RouteName) => navigate(route, { projectId: null, searchTerm: null });

  const entries: MenuEntry[] = [
    ...(showManagement
      ? ([
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
        ] satisfies MenuEntry[])
      : []),
    ...(canLeave
      ? ([
          ...(showManagement
            ? [{ type: "separator" as const, id: "leave-organization-separator" }]
            : []),
          {
            type: "item",
            id: "leave-organization",
            label: tr("dashboard.leave-organization"),
            onSelect: onLeaveOrganizationClick,
          },
        ] satisfies MenuEntry[])
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
          if (anchor !== null) {
            setAnchor(null);
            return;
          }
          onOpen?.();
          setAnchor(menuAnchorFromElement(event.currentTarget, "bottom-end"));
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
