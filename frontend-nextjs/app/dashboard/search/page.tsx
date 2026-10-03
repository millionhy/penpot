"use client";

// Search results section (F5.3). Port of app.main.ui.dashboard.search: the
// header, the three placeholder states and the results grid.
//
// Deviations from the CLJS original, documented:
// - dd/search dissoc's :search-result before the request and assoc's the
//   answer; the shell keeps a null result state for the same "still searching"
//   placeholder.
// - search-page* calls grid* without :can-edit, so the menu offers nothing but
//   "open in a new tab" and no card is draggable. That falls out of passing
//   canEdit={false} here.
// - The search icon of the placeholders comes from the ds icon set; the shell
//   draws the same glyph the sidebar search button uses until @penpot/ui is
//   wired.

import { useCallback, useEffect, useState } from "react";
import { DashboardGrid, useDynamicGridItemWidth } from "@/components/dashboard-grid";
import { useFileActions } from "@/components/file-menu";
import { projectsTitleName, searchFiles, usedNames, type FileSummary } from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { useDocumentTitle } from "@/lib/dom";
import { tr } from "@/lib/i18n";

function SearchPlaceholder({ text }: { text: string }) {
  return (
    <div className="pp-grid-empty-placeholder pp-search-placeholder" data-testid="search-placeholder">
      <div className="pp-search-placeholder-icon" aria-hidden="true">
        {"\u2315"}
      </div>
      <div className="pp-search-placeholder-text">{text}</div>
    </div>
  );
}

export default function DashboardSearchPage() {
  const { team, teamId, searchTerm, clearSelection } = useDashboard();
  const [result, setResult] = useState<FileSummary[] | null>(null);
  const [sectionRef, limit] = useDynamicGridItemWidth();

  const term = searchTerm ?? "";

  // The title effect in search-page*.
  useDocumentTitle(
    team === null
      ? ""
      : tr("title.dashboard.search", projectsTitleName(team, tr("dashboard.personal-projects"))),
  );

  // dd/search + dd/clear-selected-files on every term change: the selection
  // belongs to the previous result set.
  useEffect(() => {
    if (teamId === null) return;
    let live = true;
    setResult(null);
    clearSelection();
    searchFiles({ "team-id": teamId, "search-term": term })
      .then((rows) => {
        if (live) setResult(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (live) setResult([]);
      });
    return () => {
      live = false;
    };
    // clearSelection is a stable callback; depending on its identity would
    // re-run the search on every selection change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, term]);

  const allFileNames = useCallback(() => usedNames(result ?? []), [result]);
  // Nothing but open-new-tab is reachable from this grid, so the mutation hook
  // has nothing to refresh.
  const onFilesChanged = useCallback(async () => undefined, []);
  const actions = useFileActions({ teamId, knownFileNames: allFileNames, onFilesChanged });

  return (
    <>
      <header className="pp-dashboard-header" data-testid="dashboard-header">
        <div className="pp-dashboard-title" id="dashboard-search-title">
          <h1>{tr("dashboard.title-search")}</h1>
        </div>
      </header>

      <section
        className="pp-dashboard-container pp-dashboard-search"
        ref={sectionRef}
        data-testid="search-section"
      >
        {term === "" ? (
          <SearchPlaceholder text={tr("dashboard.type-something")} />
        ) : result === null ? (
          <SearchPlaceholder text={tr("dashboard.searching-for", term)} />
        ) : result.length === 0 ? (
          <SearchPlaceholder text={tr("dashboard.no-matches-for", term)} />
        ) : (
          <DashboardGrid
            project={null}
            teamId={teamId}
            files={result}
            canEdit={false}
            origin="search"
            layout="grid"
            limit={limit}
            actions={actions}
          />
        )}
      </section>
    </>
  );
}
