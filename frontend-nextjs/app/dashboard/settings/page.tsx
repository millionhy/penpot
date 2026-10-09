"use client";

// Settings section (F5.5). Port of team-settings-page* of
// app.main.ui.dashboard.team: the team photo (upload for owners and admins),
// the team info block, the owner row and the member/project counters.
//
// Deviations from the CLJS original, documented:
// - The organization block and the subscriptions team* block sit behind the
//   :admin-console and :subscriptions flags; the shell runs with the flags
//   off, so both wait for F5.7.
// - The CLJS fetch effect is []; the shell depends on teamId because App
//   Router keeps a mounted page across search-param navigation.
// - (dec (:projects stats)) would throw on the nil stats of a first render;
//   the shell paints the counters only once stats arrive.
// - The ds icons of the counter rows are omitted (text-only blocks) until
//   @penpot/ui is wired.

import { useCallback, useEffect, useRef, useState } from "react";
import { MemberAvatar } from "@/components/member-avatar";
import { useNotifications } from "@/components/notifications";
import { TeamHeader } from "@/components/team-header";
import { useInviteMembers } from "@/components/team-invite";
import { generateAvatar } from "@/lib/avatars";
import { config } from "@/lib/config";
import { useDashboard } from "@/lib/dashboard-context";
import { useDocumentTitle } from "@/lib/dom";
import { tr } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { teamPhotoUrl, updateTeamPhoto } from "@/lib/team";

export default function DashboardSettingsPage() {
  const {
    team,
    teamId,
    members,
    invitations,
    stats,
    refreshMembers,
    refreshStats,
    refreshTeams,
  } = useDashboard();
  const { profile } = useSession();
  const notifications = useNotifications();
  const { openInvite } = useInviteMembers(team, profile?.id);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [teamAvatar, setTeamAvatar] = useState<string | null>(null);

  const viewerId = profile?.id ?? null;

  // team-settings-page*: fetch-members + fetch-stats per team.
  useEffect(() => {
    void refreshMembers();
    void refreshStats();
  }, [teamId, refreshMembers, refreshStats]);

  useDocumentTitle(
    team === null
      ? ""
      : tr(
          "title.team-settings",
          team["is-default"] === true ? tr("dashboard.personal-projects") : team.name,
        ),
  );

  // resolve-team-photo-url: stored photo, else a generated avatar.
  const photo = teamPhotoUrl(team, config.publicUri);
  const teamName = team?.name ?? "";
  useEffect(() => {
    if (photo !== null) {
      setTeamAvatar(null);
      return;
    }
    setTeamAvatar(generateAvatar({ name: teamName }));
  }, [photo, teamName]);

  // on-file-selected: update-team-photo then fetch-teams, like the CLJS
  // event chain (on-error lands on the generic notification).
  const onPhotoSelected = useCallback(
    async (file: File) => {
      if (teamId === null) return;
      try {
        await updateTeamPhoto(teamId, file);
        await refreshTeams();
      } catch {
        notifications.error(tr("errors.generic"));
      }
    },
    [teamId, refreshTeams, notifications],
  );

  if (team === null || teamId === null) return null;

  const permissions = team.permissions;
  const canEditTeam =
    permissions?.["is-owner"] === true || permissions?.["is-admin"] === true;
  const owner = (members ?? []).find((member) => member["is-owner"] === true) ?? null;
  const memberCount = (members ?? []).length;

  return (
    <>
      <TeamHeader
        section="settings"
        team={team}
        profileId={viewerId}
        invitations={invitations}
        onInvite={(inviteEmail) => {
          void openInvite(inviteEmail);
        }}
      />

      <section
        className="pp-dashboard-container pp-dashboard-team-settings"
        data-testid="team-settings-section"
      >
        <div className="pp-settings-container">
          <div className="pp-settings-block pp-info-block">
            <div className="pp-team-icon">
              {canEditTeam ? (
                <span className="pp-update-overlay">
                  <button
                    type="button"
                    data-testid="team-image-button"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {tr("labels.update")}
                  </button>
                </span>
              ) : null}

              <img className="pp-team-image" src={photo ?? teamAvatar ?? ""} alt="" />

              {canEditTeam ? (
                <input
                  ref={fileInputRef}
                  className="pp-file-input"
                  type="file"
                  accept="image/jpeg,image/png"
                  data-testid="team-image-input"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    event.target.value = "";
                    if (file !== null) void onPhotoSelected(file);
                  }}
                />
              ) : null}
            </div>

            <div className="pp-block-label">{tr("dashboard.team-info")}</div>
            <div className="pp-block-text">{team.name}</div>
          </div>

          <div className="pp-settings-block">
            <div className="pp-block-label">{tr("dashboard.team-members")}</div>

            {owner !== null ? (
              <div className="pp-block-content">
                <MemberAvatar member={owner} className="pp-owner-icon" />
                <span className="pp-block-text">
                  {(owner.name ?? owner.email) + " (" + tr("labels.owner") + ")"}
                </span>
              </div>
            ) : null}

            <div className="pp-block-content">
              <span className="pp-block-text">
                {tr("dashboard.num-of-members", memberCount)}
              </span>
            </div>
          </div>

          <div className="pp-settings-block">
            <div className="pp-block-label">{tr("dashboard.team-projects")}</div>

            {stats !== null ? (
              <>
                <div className="pp-block-content">
                  <span className="pp-block-text">
                    {tr("labels.num-of-projects", (stats.projects ?? 0) - 1)}
                  </span>
                </div>

                <div className="pp-block-content">
                  <span className="pp-block-text">
                    {tr("labels.num-of-files", stats.files ?? 0)}
                  </span>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}
