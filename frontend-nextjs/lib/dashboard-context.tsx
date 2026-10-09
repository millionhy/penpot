"use client";

// Dashboard state (F5.1). The shell has no Potok store, so the slice of
// app.main.data.team and app.main.data.dashboard that the dashboard views read
// lives in a React context: the current team, its projects, its recent files
// and its fonts.
//
// The CLJS chain this replaces is team-container* (initialize-team: fetch-teams,
// then get-team only when the team is missing from the store, and write
// ::current-team-id into the "penpot-global" storage) followed by dashboard*
// (dd/initialize: fetch-projects, fetch-fonts and the websocket subscribe-team).
// Fonts landed with F5.4; the websocket subscription arrives with F8.
//
// Query params come through the QueryParams Suspense boundary because Next.js
// only allows useSearchParams inside one on a statically prerendered route.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { QueryParams } from "@/components/query-params";
import {
  canEdit as teamCanEdit,
  dashboardHref,
  defaultProject as pickDefaultProject,
  effectiveSection,
  emptyFileSelection,
  getProjects,
  getTeamRecentFiles,
  getTeams,
  projectsForTeam,
  readLastTeamId,
  resolveTeamId,
  sectionFromPathname,
  toggleFileSelect as toggleSelect,
  writeLastTeamId,
  type FileSelection,
  type FileSummary,
  type Project,
  type SelectableFile,
  type Team,
} from "@/lib/dashboard";
import type { RouteName } from "@/lib/routes";
import { useSession } from "@/lib/session";
import { tr } from "@/lib/i18n";
import {
  getFontVariants,
  registerCustomFonts,
  type FontVariantRow,
} from "@/lib/fonts";

export type DashboardStatus = "loading" | "ready" | "no-teams" | "error";

export interface DashboardNavigateParams {
  projectId?: string | null;
  searchTerm?: string | null;
}

export interface DashboardState {
  status: DashboardStatus;
  teams: Team[];
  team: Team | null;
  teamId: string | null;
  // Already narrowed to the current team and ordered for the recent view.
  projects: Project[];
  defaultProject: Project | null;
  project: Project | null;
  projectId: string | null;
  recentFiles: FileSummary[];
  searchTerm: string | null;
  // The get-font-variants rows of the current team, null while they load.
  // Every fetch re-registers the custom families so the typography samples
  // can resolve them (fonts-fetched in app.main.data.fonts).
  fonts: FontVariantRow[] | null;
  section: RouteName | null;
  canEdit: boolean;
  navigate: (section: RouteName, params?: DashboardNavigateParams) => void;
  refreshProjects: () => Promise<void>;
  refreshRecentFiles: () => Promise<void>;
  refreshFonts: () => Promise<void>;
  // Store-level :selected-files/:selected-project and the dashboard-local
  // inline-rename slot (:edition/:file-id), shared by every grid on the page
  // the way the Potok store shares them across sections (F5.2).
  selection: FileSelection;
  toggleFileSelect: (file: SelectableFile) => void;
  clearSelection: () => void;
  editingFileId: string | null;
  startEditFileName: (fileId: string) => void;
  stopEditFileName: () => void;
}

const defaultValue: DashboardState = {
  status: "loading",
  teams: [],
  team: null,
  teamId: null,
  projects: [],
  defaultProject: null,
  project: null,
  projectId: null,
  recentFiles: [],
  searchTerm: null,
  fonts: null,
  section: null,
  canEdit: false,
  navigate: () => undefined,
  refreshProjects: async () => undefined,
  refreshRecentFiles: async () => undefined,
  refreshFonts: async () => undefined,
  selection: emptyFileSelection(),
  toggleFileSelect: () => undefined,
  clearSelection: () => undefined,
  editingFileId: null,
  startEditFileName: () => undefined,
  stopEditFileName: () => undefined,
};

const DashboardContext = createContext<DashboardState>(defaultValue);

export function useDashboard(): DashboardState {
  return useContext(DashboardContext);
}

function DashboardLoading() {
  return (
    <main className="pp-page">
      <p className="pp-muted" data-testid="dashboard-loading">
        {tr("labels.loading")}
      </p>
    </main>
  );
}

function DashboardEmpty({ message }: { message: string }) {
  return (
    <main className="pp-page">
      <p className="pp-muted" data-testid="dashboard-empty">
        {message}
      </p>
    </main>
  );
}

function DashboardProviderInner({
  params,
  children,
}: {
  params: URLSearchParams;
  children: ReactNode;
}) {
  const { profile } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  const [teams, setTeams] = useState<Team[] | null>(null);
  const [projectRows, setProjectRows] = useState<Project[] | null>(null);
  const [recentFiles, setRecentFiles] = useState<FileSummary[] | null>(null);
  const [fontRows, setFontRows] = useState<FontVariantRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selection, setSelection] = useState<FileSelection>(emptyFileSelection);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);

  const toggleFileSelect = useCallback((file: SelectableFile) => {
    setSelection((current) => toggleSelect(current, file));
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(emptyFileSelection());
  }, []);

  const startEditFileName = useCallback((fileId: string) => {
    setEditingFileId(fileId);
  }, []);

  const stopEditFileName = useCallback(() => {
    setEditingFileId(null);
  }, []);

  const section = useMemo(() => sectionFromPathname(pathname), [pathname]);
  const queryTeamId = params.get("team-id");
  const queryProjectId = params.get("project-id");
  const querySearchTerm = params.get("search-term");

  // dd/initialize keys everything off the team, so a team change is a full
  // reload of projects and recent files (the CLJS dashboard* remounts on
  // team-id for the same reason).
  const loadTeams = useCallback(async () => {
    try {
      const rows = await getTeams();
      setTeams(Array.isArray(rows) ? rows : []);
    } catch {
      setFailed(true);
      setTeams([]);
    }
  }, []);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  const teamId = useMemo(
    () =>
      teams === null
        ? null
        : resolveTeamId({
            queryTeamId,
            lastTeamId: readLastTeamId(),
            defaultTeamId: profile?.["default-team-id"] ?? null,
            teamIds: teams.map((team) => team.id),
          }),
    [teams, queryTeamId, profile],
  );

  // Complete the URL the way on-query-navigate does: a dashboard route always
  // carries team-id, so the resolved team is written back with replace to keep
  // the entry out of the history stack.
  useEffect(() => {
    if (teamId === null || section === null) return;
    if (queryTeamId === teamId) return;
    router.replace(
      dashboardHref(section, {
        teamId,
        projectId: queryProjectId,
        searchTerm: querySearchTerm,
      }),
    );
  }, [teamId, section, queryTeamId, queryProjectId, querySearchTerm, router]);

  // team-initialized writes the visited team to the global storage as an effect.
  useEffect(() => {
    if (teamId !== null) writeLastTeamId(teamId);
  }, [teamId]);

  const loadProjects = useCallback(async () => {
    if (teamId === null) return;
    try {
      const rows = await getProjects(teamId);
      setProjectRows(Array.isArray(rows) ? rows : []);
    } catch {
      setFailed(true);
    }
  }, [teamId]);

  const loadRecentFiles = useCallback(async () => {
    if (teamId === null) return;
    try {
      const rows = await getTeamRecentFiles(teamId);
      setRecentFiles(Array.isArray(rows) ? rows : []);
    } catch {
      // A missing recent-files answer only costs the file previews; the CLJS
      // store keeps the projects it already has, so this is not fatal either.
      setRecentFiles([]);
    }
  }, [teamId]);

  // dm/fetch-fonts followed by fonts-fetched: store the rows and let the
  // custom-font registry pick them up (the effect fonts-fetched runs).
  const loadFonts = useCallback(async () => {
    if (teamId === null) return;
    try {
      const rows = await getFontVariants(teamId);
      const list = Array.isArray(rows) ? rows : [];
      setFontRows(list);
      registerCustomFonts(list);
    } catch {
      // The CLJS store leaves :fonts nil on a failed fetch, so its page keeps
      // spinning; the shell settles on the empty state instead.
      setFontRows([]);
    }
  }, [teamId]);

  useEffect(() => {
    if (teamId === null) return;
    setProjectRows(null);
    setRecentFiles(null);
    setFontRows(null);
    // dd/finalize drops the team slice on a team switch; the selection and
    // the inline rename belong to it.
    setSelection(emptyFileSelection());
    setEditingFileId(null);
    void loadProjects();
    void loadRecentFiles();
    void loadFonts();
  }, [teamId, loadProjects, loadRecentFiles, loadFonts]);

  const navigate = useCallback(
    (next: RouteName, navParams: DashboardNavigateParams = {}) => {
      router.push(
        dashboardHref(next, {
          teamId,
          projectId:
            navParams.projectId !== undefined ? navParams.projectId : queryProjectId,
          searchTerm:
            navParams.searchTerm !== undefined ? navParams.searchTerm : querySearchTerm,
        }),
      );
    },
    [router, teamId, queryProjectId, querySearchTerm],
  );

  const value = useMemo<DashboardState>(() => {
    const team = teams?.find((row) => row.id === teamId) ?? null;
    const teamProjects = projectsForTeam(projectRows ?? [], teamId);
    const fallback = pickDefaultProject(teamProjects);
    const project =
      queryProjectId === null
        ? null
        : teamProjects.find((row) => row.id === queryProjectId) ?? null;
    const status: DashboardStatus =
      teams === null
        ? "loading"
        : failed
          ? "error"
          : teamId === null
            ? "no-teams"
            : projectRows === null
              ? "loading"
              : "ready";
    return {
      status,
      teams: teams ?? [],
      team,
      teamId,
      projects: teamProjects,
      defaultProject: fallback,
      project,
      projectId: queryProjectId,
      recentFiles: recentFiles ?? [],
      searchTerm: querySearchTerm,
      fonts: fontRows,
      section: section === null ? null : effectiveSection(section, team),
      canEdit: teamCanEdit(team),
      navigate,
      refreshProjects: loadProjects,
      refreshRecentFiles: loadRecentFiles,
      refreshFonts: loadFonts,
      selection,
      toggleFileSelect,
      clearSelection,
      editingFileId,
      startEditFileName,
      stopEditFileName,
    };
  }, [
    teams,
    teamId,
    projectRows,
    recentFiles,
    fontRows,
    queryProjectId,
    querySearchTerm,
    section,
    failed,
    navigate,
    loadProjects,
    loadRecentFiles,
    loadFonts,
    selection,
    toggleFileSelect,
    clearSelection,
    editingFileId,
    startEditFileName,
    stopEditFileName,
  ]);

  if (value.status === "loading") return <DashboardLoading />;
  if (value.status === "error") {
    return <DashboardEmpty message={tr("errors.generic")} />;
  }
  if (value.status === "no-teams") {
    return <DashboardEmpty message={tr("dashboard.no-organizations-yet")} />;
  }

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  return (
    <QueryParams fallback={<DashboardLoading />}>
      {(params) => <DashboardProviderInner params={params}>{children}</DashboardProviderInner>}
    </QueryParams>
  );
}