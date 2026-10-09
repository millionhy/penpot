"use client";

// team-hero* of app.main.ui.dashboard.projects (F5.5): the banner the recent
// page shows to members who can invite when the current team is not their
// default one. The visibility rule (show-team-hero, the dismissed storage flag
// and the permissions) lives with the caller; the component renders the
// banner and routes the two actions.
//
// Deviations from the CLJS original, documented:
// - The management anchor becomes an App Router link with the dashboard-local
//   navigation contract, like the team header entries.
// - The CLJS icon-button* with the ds close icon is a plain icon button until
//   @penpot/ui is wired.

import Link from "next/link";
import { dashboardHref } from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { tr } from "@/lib/i18n";

export interface TeamHeroProps {
  teamId: string;
  onInvite: () => void;
  onClose: () => void;
}

export function TeamHero({ teamId, onInvite, onClose }: TeamHeroProps) {
  const { navigate } = useDashboard();

  return (
    <div className="pp-team-hero" data-testid="team-hero">
      <div className="pp-team-hero-img">
        <img src="/images/deco-team-banner.png" alt="" />
      </div>
      <div className="pp-team-hero-text">
        <div className="pp-team-hero-title">{tr("dasboard.team-hero.title")}</div>
        <div className="pp-team-hero-info">
          <span>{tr("dasboard.team-hero.text")}</span>{" "}
          <Link
            href={dashboardHref("dashboard-members", { teamId })}
            data-testid="team-hero-members"
            onClick={(event) => {
              // go-to-dashboard-members: keep the dashboard-local navigation
              // contract (resolved team, no unrelated query params).
              event.preventDefault();
              navigate("dashboard-members", { projectId: null, searchTerm: null });
            }}
          >
            {tr("dasboard.team-hero.management")}
          </Link>
        </div>
        <button
          type="button"
          className="pp-btn-primary"
          data-testid="team-hero-invite"
          onClick={onInvite}
        >
          {tr("onboarding.choice.team-up.invite-members")}
        </button>
      </div>
      <button
        type="button"
        className="pp-icon-btn pp-team-hero-close"
        aria-label={tr("labels.close")}
        data-testid="team-hero-close"
        onClick={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
