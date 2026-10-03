"use client";

// The Recent / Deleted tab strip (F5.3). menu* in
// app.main.ui.dashboard.deleted: both sections render it, projects-section*
// with :section :dashboard-recent and deleted-section* with
// :section :dashboard-deleted, so the component lives on its own.
//
// dcm/go-to-dashboard-recent and go-to-dashboard-deleted navigate with the team
// id only; project-id and search-term are dropped, which is what dashboardHref
// does when they are omitted.
//
// Deviation from the CLJS original, documented: the two tabs are divs with an
// on-click handler there; the shell renders buttons so they are reachable by
// keyboard without a shortcuts registry (that lands with F5.6).

import { useRouter } from "next/navigation";
import { dashboardHref } from "@/lib/dashboard";
import type { RouteName } from "@/lib/routes";
import { tr } from "@/lib/i18n";

export interface DeletedTabsProps {
  // The section the tab strip renders in, which decides the selected tab.
  section: RouteName;
  teamId: string | null;
}

export function DeletedTabs({ section, teamId }: DeletedTabsProps) {
  const router = useRouter();

  const go = (next: RouteName) => {
    router.push(dashboardHref(next, { teamId }));
  };

  const tabClass = (name: RouteName) =>
    section === name ? "pp-nav-option selected" : "pp-nav-option";

  return (
    <div className="pp-nav" role="tablist" aria-label={tr("dashboard.options")}>
      <div className="pp-nav-inside">
        <button
          type="button"
          role="tab"
          aria-selected={section === "dashboard-recent"}
          className={tabClass("dashboard-recent")}
          data-testid="recent-tab"
          onClick={() => go("dashboard-recent")}
        >
          {tr("labels.recent")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "dashboard-deleted"}
          className={tabClass("dashboard-deleted")}
          data-testid="deleted-tab"
          onClick={() => go("dashboard-deleted")}
        >
          {tr("labels.deleted")}
        </button>
      </div>
    </div>
  );
}
