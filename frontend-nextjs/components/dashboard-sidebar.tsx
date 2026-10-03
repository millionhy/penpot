"use client";

// Dashboard sidebar (F5.1). View over sidebar-content* and profile-section* in
// app.main.ui.dashboard.sidebar.
//
// Three pieces of the CLJS sidebar are deliberately not here yet:
// organization-team-switch* (the organization/team picker with its 620 lines of
// menus) arrives with F5.7, so the team name renders as a plain header; the
// project context menu (rename, duplicate, move, delete) arrives with the full
// grid in F5.2, so a pinned project only offers the pin toggle that put it in
// the list; and the subscription/nitrate blocks plus the comments panel are
// flag-gated SaaS features that stay out of the shell.
//
// The CLJS list items are clickable <li>; the shell uses real links so they are
// keyboard reachable and the App Router owns the navigation.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { DashboardProfileMenu } from "@/components/dashboard-profile-menu";
import {
  dashboardHref,
  isDraftsSection,
  pinnedProjects,
  updateProjectPin,
  type Project,
} from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { tr } from "@/lib/i18n";

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
          ×
        </button>
      ) : (
        <button
          type="button"
          className="pp-search-btn"
          aria-label="dashboard-search"
          onClick={onClear}
        >
          ⌕
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
        ⚲
      </button>
    </li>
  );
}

export function DashboardSidebar() {
  const { team, teamId, projects, defaultProject, section, projectId } = useDashboard();

  const pinned = useMemo(() => pinnedProjects(projects), [projects]);
  const draftsSelected = isDraftsSection(section, projectId, defaultProject?.id ?? null);

  const itemClass = (active: boolean) =>
    active ? "pp-sidebar-nav-item current" : "pp-sidebar-nav-item";

  return (
    <nav className="pp-dashboard-sidebar" data-testid="dashboard-sidebar">
      <div className="pp-sidebar-content">
        <div className="pp-sidebar-team-header" data-testid="team-header">
          <span className="pp-team-name">{team?.name ?? ""}</span>
          {team?.["organization-name"] ? (
            <span className="pp-organization-name">{team["organization-name"]}</span>
          ) : null}
        </div>

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
              <span aria-hidden="true">⚲</span>
              <span className="pp-empty-text">{tr("dashboard.no-projects-placeholder")}</span>
            </div>
          )}
        </div>
      </div>

      <DashboardProfileMenu />
    </nav>
  );
}