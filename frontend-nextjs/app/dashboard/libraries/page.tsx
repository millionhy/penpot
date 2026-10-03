"use client";

// Shared libraries section (F5.3). Port of app.main.ui.dashboard.libraries:
// the header plus the grid of published files, where every card shows the
// library summary instead of a thumbnail.
//
// Deviations from the CLJS original, documented:
// - dtm/fetch-shared-files merges the answer into the store's :shared-files
//   map, so libraries of previously visited teams stay around; the shell
//   refetches per team and filters on team-id, which is what the
//   libraries-page* memo does with that merged map anyway.
// - libraries-page* passes no :layout, so this section is always a grid and
//   renders no layout toggle.
// - The dashboard shortcuts registry (sc/shortcuts-drafts-libraries) arrives
//   with F5.6.

import { useCallback, useEffect, useState } from "react";
import { DashboardGrid, useDynamicGridItemWidth } from "@/components/dashboard-grid";
import { useFileActions } from "@/components/file-menu";
import {
  LIBRARIES_GRID_ITEM_WIDTH,
  getTeamSharedFiles,
  projectsTitleName,
  sharedFilesForTeam,
  usedNames,
  type SharedFile,
} from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { useDocumentTitle } from "@/lib/dom";
import { tr } from "@/lib/i18n";

export default function DashboardLibrariesPage() {
  const { team, defaultProject, teamId, canEdit, clearSelection } = useDashboard();
  // null until the answer lands, so the grid can tell "still loading" from
  // "there are no libraries" (the (when (some? files) ...) memo).
  const [files, setFiles] = useState<SharedFile[] | null>(null);
  const [sectionRef, limit] = useDynamicGridItemWidth(LIBRARIES_GRID_ITEM_WIDTH);

  // The title effect in libraries-page*.
  useDocumentTitle(
    team === null
      ? ""
      : tr(
          "title.dashboard.shared-libraries",
          projectsTitleName(team, tr("dashboard.personal-projects")),
        ),
  );

  const load = useCallback(async () => {
    if (teamId === null) return;
    try {
      const rows = await getTeamSharedFiles(teamId);
      setFiles(sharedFilesForTeam(Array.isArray(rows) ? rows : [], teamId));
    } catch {
      setFiles([]);
    }
  }, [teamId]);

  // dtm/fetch-shared-files + dd/clear-selected-files on every team change.
  useEffect(() => {
    setFiles(null);
    clearSelection();
    void load();
    // clearSelection is a stable callback; depending on its identity would
    // refetch on every selection change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, load]);

  const knownFileNames = useCallback(() => usedNames(files ?? []), [files]);
  const actions = useFileActions({ teamId, knownFileNames, onFilesChanged: load });

  return (
    <>
      <header className="pp-dashboard-header" data-testid="dashboard-header">
        <div className="pp-dashboard-title" id="dashboard-libraries-title">
          <h1>{tr("dashboard.libraries-title")}</h1>
        </div>
      </header>

      <section
        className="pp-dashboard-container pp-dashboard-shared"
        ref={sectionRef}
        data-testid="libraries-section"
      >
        <DashboardGrid
          project={defaultProject}
          teamId={teamId}
          files={files}
          canEdit={canEdit}
          origin="libraries"
          layout="grid"
          limit={limit}
          actions={actions}
        />
      </section>
    </>
  );
}
