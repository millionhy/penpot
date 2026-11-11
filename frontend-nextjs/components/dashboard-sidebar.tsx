"use client";

// Dashboard sidebar (F5.1). View over sidebar-content* and profile-section* in
// app.main.ui.dashboard.sidebar.
//
// organization-team-switch* (the organization/team picker dropdown) is ported
// with F5.7a (components/org-team-switch.tsx), replacing the plain team header
// of the first slices; it renders the active team and its "..." management
// menu (components/team-options-menu.tsx) like the CLJS version does. The
// subscription and nitrate blocks arrived with F5.7b
// (components/subscription.tsx), flag-gated exactly like profile-section*:
// the rest of the CLJS sidebar is deliberately not here yet: the project
// context menu (rename, duplicate, move, delete) arrives with the full grid in
// F5.2, so a pinned project only offers the pin toggle that put it in the
// list. The comment notifications bell and feed (components/
// dashboard-comments) arrived with F5.7: the CLJS gates them on team and
// profile only, not on a subscription, so the shell ports them too.
//
// The CLJS list items are clickable <li>; the shell uses real links so they are
// keyboard reachable and the App Router owns the navigation.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { DashboardProfileMenu } from "@/components/dashboard-profile-menu";
import { OrgTeamSwitch } from "@/components/org-team-switch";
import { SubscriptionSection } from "@/components/subscription";
import {
  dashboardHref,
  isDraftsSection,
  pinnedProjects,
  updateProjectPin,
  type Project,
} from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { tr } from "@/lib/i18n";

// The sprite icons the CLJS sidebar pulls through deprecated-icon/icon-xref
// (search, delete-text and pin). The shell has no icon sprite, so the paths
// from frontend/resources/images/icons live here at the sizes the CLJS
// %button-icon (16px, 1px stroke) and %button-icon-small (12px, 1.33px
// stroke) ask for.
function SidebarIcon({
  path,
  size,
  strokeWidth,
  className,
}: {
  path: string;
  size: number;
  strokeWidth: number;
  className: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

const SEARCH_PATH =
  "M7.329 12.666c1.473.002 2.807-.594 3.773-1.559.966-.964 1.564-2.297 1.566-3.77.002-2.945-2.384-5.335-5.33-5.338-2.945-.002-5.335 2.384-5.337 5.329-.003 2.946 2.383 5.336 5.328 5.338Zm6.666 1.339-2.893-2.898";
const CLEAR_SEARCH_PATH =
  "m7.981 1.333c3.68 0 6.675 2.988 6.686 6.667.01 3.679-2.969 6.667-6.648 6.667-3.68 0-6.675-2.988-6.686-6.667-.01-3.679 2.969-6.667 6.648-6.667zm2.013 4.667-1.994 2-1.994 2m-.012-4 2.006 2 2.006 2";
const PIN_PATH =
  "M5.847 10.153L2.962 7.27a4.928 4.928 0 013.482-1.442h.845L10.654 1.5 14.5 5.346 10.173 8.71v.846a4.924 4.924 0 01-1.442 3.482l-2.884-2.886zm0 0L2 14";

// sidebar-search*: a debounced (500ms) navigation to the search route on every
// change, exactly like the goog debounce in the CLJS version.
function SidebarSearch() {
  const { teamId, searchTerm, navigate } = useDashboard();
  const [value, setValue] = useState(searchTerm ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The input is uncontrolled in CLJS (default-value plus a ref that resets it),
  // so a route change back to an empty term has to clear the field here too.
  useEffect(() => {
    setValue(searchTerm ?? "");
  }, [searchTerm]);

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  const onChange = (next: string) => {
    setValue(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      navigate("dashboard-search", { searchTerm: next.length > 0 ? next : null });
    }, 500);
  };

  const onClear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    setValue("");
    navigate("dashboard-search", { searchTerm: null });
  };

  return (
    <form className="pp-sidebar-search" onSubmit={(event) => event.preventDefault()}>
      <input
        className="pp-input-text"
        id="search-input"
        type="text"
        aria-label={tr("dashboard.search-placeholder")}
        placeholder={tr("dashboard.search-placeholder")}
        value={value}
        autoComplete="off"
        disabled={teamId === null}
        onChange={(event) => onChange(event.target.value)}
      />
      {value.length > 0 ? (
        <button
          type="button"
          className="pp-search-btn pp-clear-search-btn"
          aria-label="dashboard-clear-search"
          onClick={onClear}
        >
          <SidebarIcon
            path={CLEAR_SEARCH_PATH}
            size={16}
            strokeWidth={1}
            className="pp-search-icon"
          />
        </button>
      ) : (
        <button
          type="button"
          className="pp-search-btn"
          aria-label="dashboard-search"
          onClick={onClear}
        >
          <SidebarIcon
            path={SEARCH_PATH}
            size={16}
            strokeWidth={1}
            className="pp-search-icon"
          />
        </button>
      )}
    </form>
  );
}

function SidebarProject({ item, isSelected }: { item: Project; isSelected: boolean }) {
  const { teamId, refreshProjects } = useDashboard();
  const [busy, setBusy] = useState(false);

  const onUnpin = async () => {
    if (teamId === null) return;
    setBusy(true);
    try {
      await updateProjectPin({ "team-id": teamId, id: item.id, "is-pinned": false });
      await refreshProjects();
    } finally {
      setBusy(false);
    }
  };

  const href = dashboardHref("dashboard-files", { teamId, projectId: item.id });
  return (
    <li
      className={
        isSelected ? "pp-project-element pp-sidebar-nav-item current" : "pp-project-element pp-sidebar-nav-item"
      }
    >
      <Link className="pp-element-title" href={href} data-testid={"project-" + item.id}>
        {item.name}
      </Link>
      <button
        type="button"
        className="pp-pin-btn"
        disabled={busy}
        aria-label={tr("dashboard.options")}
        data-testid={"unpin-" + item.id}
        onClick={() => {
          void onUnpin();
        }}
      >
        <SidebarIcon path={PIN_PATH} size={12} strokeWidth={1.33} className="pp-pin-icon" />
      </button>
    </li>
  );
}

export function DashboardSidebar() {
  const { teamId, projects, defaultProject, section, projectId } = useDashboard();

  const pinned = useMemo(() => pinnedProjects(projects), [projects]);
  const draftsSelected = isDraftsSection(section, projectId, defaultProject?.id ?? null);

  const itemClass = (active: boolean) =>
    active ? "pp-sidebar-nav-item current" : "pp-sidebar-nav-item";

  return (
    <nav className="pp-dashboard-sidebar" data-testid="dashboard-sidebar">
      <div className="pp-sidebar-content">
        <OrgTeamSwitch />

        <SidebarSearch />

        <div className="pp-sidebar-content-section">
          <ul className="pp-sidebar-nav">
            <li className={itemClass(section === "dashboard-recent")}>
              <Link
                className="pp-sidebar-link"
                data-testid="projects-link"
                href={dashboardHref("dashboard-recent", { teamId })}
              >
                <span className="pp-element-title">{tr("labels.projects")}</span>
              </Link>
            </li>
            <li className={itemClass(draftsSelected)}>
              <Link
                className="pp-sidebar-link"
                data-testid="drafts-link"
                href={dashboardHref("dashboard-files", {
                  teamId,
                  projectId: defaultProject?.id ?? null,
                })}
              >
                <span className="pp-element-title">{tr("labels.drafts")}</span>
              </Link>
            </li>
          </ul>
        </div>

        <div className="pp-sidebar-content-section">
          <div className="pp-sidebar-section-title">{tr("labels.sources")}</div>
          <ul className="pp-sidebar-nav">
            <li className={itemClass(section === "dashboard-fonts")}>
              <Link
                className="pp-sidebar-link"
                data-testid="fonts"
                href={dashboardHref("dashboard-fonts", { teamId })}
              >
                <span className="pp-element-title">{tr("labels.fonts")}</span>
              </Link>
            </li>
            <li className={itemClass(section === "dashboard-libraries")}>
              <Link
                className="pp-sidebar-link"
                data-testid="libs-link-sidebar"
                href={dashboardHref("dashboard-libraries", { teamId })}
              >
                <span className="pp-element-title">{tr("labels.shared-libraries")}</span>
              </Link>
            </li>
          </ul>
        </div>

        <div className="pp-sidebar-content-section" data-testid="pinned-projects">
          <div className="pp-sidebar-section-title">{tr("labels.pinned-projects")}</div>
          {pinned.length > 0 ? (
            <ul className="pp-sidebar-nav pp-pinned-projects">
              {pinned.map((item) => (
                <SidebarProject
                  key={item.id}
                  item={item}
                  isSelected={item.id === projectId}
                />
              ))}
            </ul>
          ) : (
            <div className="pp-sidebar-empty-placeholder">
              <SidebarIcon path={PIN_PATH} size={12} strokeWidth={1.33} className="pp-pin-icon" />
              <span className="pp-empty-text">{tr("dashboard.no-projects-placeholder")}</span>
            </div>
          )}
        </div>
      </div>

      <SubscriptionSection />

      <DashboardProfileMenu />
    </nav>
  );
}