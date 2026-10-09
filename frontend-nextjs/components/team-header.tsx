"use client";

// header* of app.main.ui.dashboard.team (F5.5): the title, the
// members/invitations/webhooks/settings nav and the invite button shared by
// the four team pages.
//
// Deviations from the CLJS original, documented:
// - The disabled invite button is wrapped in a ds tooltip in CLJS; the shell
//   uses a native title attribute until @penpot/ui is wired.
// - The nav entries are real links (App Router owns the navigation) with the
//   same active class contract.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { dashboardHref } from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { hasFlag } from "@/lib/config";
import { tr } from "@/lib/i18n";
import type { RouteName } from "@/lib/routes";
import { canSendInvitations, type TeamInvitation, type TeamWithOrganization } from "@/lib/team";

export type TeamSection = "members" | "invitations" | "webhooks" | "settings";

const SECTION_ROUTES: Record<TeamSection, RouteName> = {
  members: "dashboard-members",
  invitations: "dashboard-invitations",
  webhooks: "dashboard-webhooks",
  settings: "dashboard-settings",
};

export interface TeamHeaderProps {
  section: TeamSection;
  team: TeamWithOrganization;
  profileId: string | null | undefined;
  // (:invitations team): the invite button only renders once the team carries
  // invitations (or they are still loading, which reads as none).
  invitations: TeamInvitation[] | null;
  onInvite: (inviteEmail?: string | null) => void;
}

export function TeamHeader({ section, team, profileId, invitations, onInvite }: TeamHeaderProps) {
  const { navigate } = useDashboard();
  const router = useRouter();
  const searchParams = useSearchParams();
  const inviteEmail = searchParams.get("invite-email");
  const teamId = team.id;

  // The [team-id invite-email] effect of header*: both present means the flow
  // arrived from an invitation email, so it opens the modal and clears the
  // param from the URL with a replace.
  useEffect(() => {
    if (teamId === "" || inviteEmail === null) return;
    onInvite(inviteEmail);
    router.replace(dashboardHref(SECTION_ROUTES[section], { teamId }));
    // The CLJS effect depends on [team-id invite-email]; section and callbacks
    // are stable for a mounted page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, inviteEmail]);

  let title: string | null = null;
  if (section === "members") title = tr("labels.members");
  else if (section === "settings") title = tr("labels.settings");
  else if (section === "invitations") title = tr("labels.invitations");
  else if (section === "webhooks") title = tr("labels.webhooks");

  const canInvite = canSendInvitations(team, profileId);
  const showInviteButton =
    (section === "invitations" || section === "members") &&
    invitations !== null &&
    invitations.length > 0;

  const entries: Array<{ section: TeamSection; label: string; route: RouteName }> = [
    { section: "members", label: tr("labels.members"), route: "dashboard-members" },
    { section: "invitations", label: tr("labels.invitations"), route: "dashboard-invitations" },
    ...(hasFlag("webhooks")
      ? [{ section: "webhooks" as TeamSection, label: tr("labels.webhooks"), route: "dashboard-webhooks" as RouteName }]
      : []),
    { section: "settings", label: tr("labels.settings"), route: "dashboard-settings" },
  ];

  return (
    <header className="pp-dashboard-header pp-team-header" data-testid="dashboard-header">
      <div className="pp-dashboard-title">
        <h1>{title}</h1>
      </div>
      <nav className="pp-team-header-menu">
        <ul className="pp-team-header-options">
          {entries.map((entry) => (
            <li key={entry.section} className={entry.section === section ? "active" : undefined}>
              <Link
                href={dashboardHref(entry.route, { teamId })}
                data-testid={"team-nav-" + entry.section}
                onClick={(event) => {
                  // Keep the dashboard-local navigation contract (keeps the
                  // resolved team, drops unrelated query params).
                  event.preventDefault();
                  navigate(entry.route, { projectId: null, searchTerm: null });
                }}
              >
                {entry.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="pp-dashboard-header-actions">
        {showInviteButton ? (
          <button
            type="button"
            className="pp-btn-secondary"
            disabled={!canInvite}
            title={canInvite ? undefined : tr("dashboard.invite-profile-disabled")}
            data-testid="invite-member"
            onClick={() => onInvite(inviteEmail)}
          >
            {tr("dashboard.invite-profile")}
          </button>
        ) : null}
      </div>
    </header>
  );
}
