"use client";

// Members section (F5.5). Port of the members slice of
// app.main.ui.dashboard.team: team-members-page*, team-members*, team-member*,
// member-info*, rol-info* and member-actions*. The three leave flows (plain
// leave, change-owner-and-leave, leave-and-close) live in
// components/team-leave-flows.tsx, shared with the sidebar team menu.
//
// Deviations from the CLJS original, documented:
// - The role and actions dropdowns use DashboardMenu instead of the CLJS ds
//   dropdown, like every migrated menu.
// - update-member-role and delete-member failures surface as errors.generic
//   (the CLJS events let the error reach the global handler).

import { useCallback, useEffect, useState } from "react";
import {
  DashboardMenu,
  menuAnchorFromElement,
  type MenuAnchor,
  type MenuEntry,
} from "@/components/dashboard-menu";
import { MemberAvatar } from "@/components/member-avatar";
import { ConfirmDialog, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { MembersCta } from "@/components/subscription";
import { TeamHeader } from "@/components/team-header";
import { useInviteMembers } from "@/components/team-invite";
import { useTeamLeaveFlows } from "@/components/team-leave-flows";
import { hasFlag } from "@/lib/config";
import { useDashboard } from "@/lib/dashboard-context";
import { useDocumentTitle } from "@/lib/dom";
import { tr } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import {
  showSubscriptionMembersBanner,
  type SubscriptionProfile,
} from "@/lib/subscription";
import {
  canChangeMemberRole,
  canLeaveFromMenu,
  canRemoveFromMenu,
  deleteMember,
  isYou,
  memberRole,
  orderedMembers,
  roleLabel,
  showMemberMenu,
  updateMemberRole,
  type TeamMember,
  type TeamRole,
} from "@/lib/team";

interface MemberMenu {
  memberId: string;
  anchor: MenuAnchor;
}

export default function DashboardMembersPage() {
  const { team, teamId, members, invitations, refreshMembers, refreshTeams } = useDashboard();
  const { profile, refresh: refreshProfile } = useSession();
  const modal = useModal();
  const notifications = useNotifications();
  const { openInvite } = useInviteMembers(team, profile?.id);
  const { onLeave } = useTeamLeaveFlows();
  const [roleMenu, setRoleMenu] = useState<MemberMenu | null>(null);
  const [actionsMenu, setActionsMenu] = useState<MemberMenu | null>(null);

  const viewerId = profile?.id ?? null;

  // team-members-page*: fetch-members on every team change.
  useEffect(() => {
    void refreshMembers();
  }, [teamId, refreshMembers]);

  useDocumentTitle(
    team === null
      ? ""
      : tr(
          "title.team-members",
          team["is-default"] === true ? tr("dashboard.personal-projects") : team.name,
        ),
  );

  // dtm/update-member-role: the role starts on "owner" from the promote-owner
  // confirm and the profile refresh keeps the permissions in sync.
  const onSetRole = useCallback(
    async (memberId: string, role: TeamRole) => {
      if (teamId === null) return;
      try {
        await updateMemberRole(teamId, memberId, role);
        await Promise.all([refreshProfile(), refreshMembers(), refreshTeams()]);
      } catch {
        notifications.error(tr("errors.generic"));
      }
    },
    [teamId, refreshProfile, refreshMembers, refreshTeams, notifications],
  );

  // on-set-owner of rol-info*: the promote-owner confirm with its scd-message.
  const onSetOwner = useCallback(
    (member: TeamMember) => {
      modal.open(
        <ConfirmDialog
          title={tr("modals.promote-owner-confirm.title")}
          message={tr("modals.promote-owner-confirm.message", member.name ?? member.email)}
          hint={tr("modals.promote-owner-confirm.hint")}
          acceptLabel={tr("modals.promote-owner-confirm.accept")}
          cancelLabel={tr("labels.cancel")}
          onAccept={() => {
            void onSetRole(member.id, "owner");
          }}
        />,
      );
    },
    [modal, onSetRole],
  );

  // on-delete of member-actions*: confirm, then dtm/delete-member.
  const onDeleteMember = useCallback(
    (memberId: string) => {
      modal.open(
        <ConfirmDialog
          title={tr("modals.delete-team-member-confirm.title")}
          message={tr("modals.delete-team-member-confirm.message")}
          acceptLabel={tr("modals.delete-team-member-confirm.accept")}
          cancelLabel={tr("labels.cancel")}
          onAccept={() => {
            void (async () => {
              if (teamId === null) return;
              try {
                await deleteMember(teamId, memberId);
                await Promise.all([refreshProfile(), refreshMembers(), refreshTeams()]);
              } catch {
                notifications.error(tr("errors.generic"));
              }
            })();
          }}
        />,
      );
    },
    [modal, teamId, refreshProfile, refreshMembers, refreshTeams, notifications],
  );

  if (team === null || teamId === null) return null;

  const runtime = (profile ?? null) as SubscriptionProfile | null;
  const rows = orderedMembers(members ?? []);
  const totalMembers = rows.length;

  // The roles-dropdown entries of rol-info*: viewer/editor/admin for the team
  // owner or admin, plus owner for the team owner.
  const roleEntriesFor = (memberId: string): MenuEntry[] => {
    const entries: MenuEntry[] = (["viewer", "editor", "admin"] as TeamRole[]).map((role) => ({
      type: "item",
      id: "member-role-" + memberId + "-" + role,
      label: roleLabel(role),
      onSelect: () => {
        setRoleMenu(null);
        void onSetRole(memberId, role);
      },
    }));
    if (team.permissions?.["is-owner"] === true) {
      entries.push({
        type: "item",
        id: "member-role-" + memberId + "-owner",
        label: roleLabel("owner"),
        onSelect: () => {
          const member = rows.find((row) => row.id === memberId);
          setRoleMenu(null);
          if (member !== undefined) onSetOwner(member);
        },
      });
    }
    return entries;
  };

  // The actions-dropdown entries of member-actions*.
  const actionEntriesFor = (member: TeamMember): MenuEntry[] => {
    const entries: MenuEntry[] = [];
    if (canLeaveFromMenu(member, viewerId)) {
      entries.push({
        type: "item",
        id: "member-leave",
        label: tr("dashboard.leave-team"),
        onSelect: () => {
          setActionsMenu(null);
          onLeave(totalMembers);
        },
      });
    }
    if (canRemoveFromMenu(team, member, viewerId)) {
      entries.push({
        type: "item",
        id: "member-remove",
        label: tr("labels.remove-member"),
        onSelect: () => {
          setActionsMenu(null);
          onDeleteMember(member.id);
        },
      });
    }
    return entries;
  };

  const roleMenuMember =
    roleMenu === null ? null : rows.find((row) => row.id === roleMenu.memberId) ?? null;
  const actionsMenuMember =
    actionsMenu === null ? null : rows.find((row) => row.id === actionsMenu.memberId) ?? null;

  return (
    <>
      <TeamHeader
        section="members"
        team={team}
        profileId={viewerId}
        invitations={invitations}
        onInvite={(inviteEmail) => {
          void openInvite(inviteEmail);
        }}
      />

      <section
        className="pp-dashboard-container pp-dashboard-team-members"
        data-testid="team-members-section"
      >
        <div className="pp-team-table pp-team-members">
          <div className="pp-team-table-header">
            <div className="pp-team-field pp-field-name">{tr("labels.member")}</div>
            <div className="pp-team-field pp-field-role">{tr("labels.role")}</div>
          </div>

          <div className="pp-team-table-rows">
            {rows.map((member) => {
              const role = memberRole(member);
              const you = isYou(member, viewerId);
              const canChangeRole = canChangeMemberRole(team, member, viewerId);
              const showActions = showMemberMenu(team, member, viewerId);
              const roleOpen = roleMenu !== null && roleMenu.memberId === member.id;
              const actionsOpen = actionsMenu !== null && actionsMenu.memberId === member.id;
              return (
                <div className="pp-team-table-row" key={member.id}>
                  <div className="pp-team-field pp-field-name">
                    <MemberAvatar member={member} className="pp-member-image" />
                    <div className="pp-member-info">
                      <div className="pp-member-name">
                        {member.name}
                        {you ? <span className="pp-you">{tr("labels.you")}</span> : null}
                      </div>
                      <div className="pp-member-email">{member.email}</div>
                    </div>
                  </div>

                  <div className="pp-team-field pp-field-role">
                    {canChangeRole ? (
                      <button
                        type="button"
                        className="pp-role-selector pp-has-priv"
                        aria-haspopup="menu"
                        aria-expanded={roleOpen}
                        data-testid={"member-role-" + member.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          const element = event.currentTarget;
                          setRoleMenu((current) =>
                            current !== null && current.memberId === member.id
                              ? null
                              : { memberId: member.id, anchor: menuAnchorFromElement(element) },
                          );
                        }}
                      >
                        <span className="pp-role-label">{roleLabel(role)}</span>
                        <span aria-hidden="true">{"\u25be"}</span>
                      </button>
                    ) : (
                      <div className="pp-role-selector">
                        <span className="pp-role-label">{roleLabel(role)}</span>
                      </div>
                    )}
                  </div>

                  <div className="pp-team-field pp-field-actions">
                    {showActions ? (
                      <button
                        type="button"
                        className="pp-icon-btn"
                        aria-label={tr("dashboard.options")}
                        aria-haspopup="menu"
                        aria-expanded={actionsOpen}
                        data-testid={"member-options-" + member.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          const element = event.currentTarget;
                          setActionsMenu((current) =>
                            current !== null && current.memberId === member.id
                              ? null
                              : {
                                  memberId: member.id,
                                  anchor: menuAnchorFromElement(element, "bottom-end"),
                                },
                          );
                        }}
                      >
                        <span aria-hidden="true">…</span>
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {hasFlag("subscriptions") &&
        showSubscriptionMembersBanner(team.subscription, team.permissions, runtime) ? (
          <MembersCta />
        ) : null}
      </section>

      {roleMenu !== null && roleMenuMember !== null ? (
        <DashboardMenu
          anchor={roleMenu.anchor}
          entries={roleEntriesFor(roleMenuMember.id)}
          onClose={() => setRoleMenu(null)}
        />
      ) : null}

      {actionsMenu !== null && actionsMenuMember !== null ? (
        <DashboardMenu
          anchor={actionsMenu.anchor}
          entries={actionEntriesFor(actionsMenuMember)}
          onClose={() => setActionsMenu(null)}
        />
      ) : null}
    </>
  );
}
