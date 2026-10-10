import { describe, expect, it } from "vitest";
import {
  FRONTEND_ONLY_FEATURES,
  colorSampleValue,
  computeGridLayout,
  copySuffixFn,
  dashboardHref,
  emptyFileSelection,
  groupProjectsByTeam,
  parseDashboardLayout,
  resolveMediaUri,
  singleSelectedFileId,
  toggleFileSelect,
  defaultProject,
  deletedFilesOf,
  deletedProjectsFor,
  effectiveSection,
  fileFeatures,
  firstPageId,
  generateUniqueName,
  isDraftsSection,
  pinnedProjects,
  projectsForTeam,
  projectsTitleName,
  recentFilesOf,
  resolveTeamId,
  sectionFromPathname,
  sharedFilesForTeam,
  subscriptionType,
  timeAgo,
  usedNames,
  visibleDeletedFiles,
  visibleProjects,
  workspaceHref,
  canEdit,
  type AllProject,
  type DeletedFile,
  type FileSummary,
  type Project,
  type SharedFile,
  type Team,
} from "@/lib/dashboard";

function team(overrides: Partial<Team> = {}): Team {
  return { id: "t1", name: "Team", ...overrides };
}

function project(overrides: Partial<Project> = {}): Project {
  return { id: "p1", name: "Project", "team-id": "t1", ...overrides };
}

function file(overrides: Partial<FileSummary> = {}): FileSummary {
  return { id: "f1", name: "File", "project-id": "p1", ...overrides };
}

describe("resolveTeamId", () => {
  const teamIds = ["t1", "t2", "t3"];

  it("prefers the query param when it names a known team", () => {
    expect(
      resolveTeamId({ queryTeamId: "t2", lastTeamId: "t3", defaultTeamId: "t1", teamIds }),
    ).toBe("t2");
  });

  it("falls back to the last visited team, then the profile default", () => {
    expect(resolveTeamId({ lastTeamId: "t3", defaultTeamId: "t1", teamIds })).toBe("t3");
    expect(resolveTeamId({ defaultTeamId: "t1", teamIds })).toBe("t1");
  });

  it("ignores unknown or stale ids", () => {
    expect(
      resolveTeamId({ queryTeamId: "nope", lastTeamId: "gone", defaultTeamId: "t2", teamIds }),
    ).toBe("t2");
  });

  it("falls back to the first team, then null", () => {
    expect(resolveTeamId({ teamIds })).toBe("t1");
    expect(resolveTeamId({ teamIds: [] })).toBeNull();
  });
});

describe("project selections", () => {
  it("narrows projects to the current team", () => {
    const rows = [project(), project({ id: "p2", "team-id": "t2" })];
    expect(projectsForTeam(rows, "t1").map((row) => row.id)).toEqual(["p1"]);
    expect(projectsForTeam(rows, null)).toEqual([]);
  });

  it("removes deleted projects and sorts by modified-at, newest first", () => {
    const rows = [
      project({ id: "a", "modified-at": "2026-01-01T00:00:00Z" }),
      project({ id: "b", "modified-at": new Date("2026-06-01T00:00:00Z") }),
      project({ id: "c", "deleted-at": "2026-07-01T00:00:00Z" }),
    ];
    expect(visibleProjects(rows).map((row) => row.id)).toEqual(["b", "a"]);
  });

  it("finds the drafts project", () => {
    const rows = [project(), project({ id: "p0", "is-default": true })];
    expect(defaultProject(rows)?.id).toBe("p0");
    expect(defaultProject([project()])).toBeNull();
  });

  it("lists pinned non-default projects by name", () => {
    const rows = [
      project({ id: "z", name: "Zeta", "is-pinned": true }),
      project({ id: "a", name: "Alpha", "is-pinned": true }),
      project({ id: "d", name: "Drafts", "is-default": true, "is-pinned": true }),
      project({ id: "n", name: "Not pinned" }),
      project({ id: "x", name: "Deleted", "is-pinned": true, "deleted-at": "2026-01-01T00:00:00Z" }),
    ];
    expect(pinnedProjects(rows).map((row) => row.id)).toEqual(["a", "z"]);
  });

  it("groups recent files per project, newest first", () => {
    const rows = [
      file({ id: "f1", "modified-at": "2026-01-01T00:00:00Z" }),
      file({ id: "f2", "project-id": "p2" }),
      file({ id: "f3", "modified-at": new Date("2026-06-01T00:00:00Z") }),
    ];
    expect(recentFilesOf(rows, "p1").map((row) => row.id)).toEqual(["f3", "f1"]);
  });
});

describe("permissions and sections", () => {
  it("reads can-edit from the team permissions", () => {
    expect(canEdit(team({ permissions: { "can-edit": true } }))).toBe(true);
    expect(canEdit(team({ permissions: {} }))).toBe(false);
    expect(canEdit(null)).toBe(false);
  });

  it("detects the drafts files section", () => {
    expect(isDraftsSection("dashboard-files", "p0", "p0")).toBe(true);
    expect(isDraftsSection("dashboard-files", "p1", "p0")).toBe(false);
    expect(isDraftsSection("dashboard-recent", "p0", "p0")).toBe(false);
  });

  it("redirects deleted to recent without edit permission", () => {
    const readOnly = team({ permissions: {} });
    expect(effectiveSection("dashboard-deleted", readOnly)).toBe("dashboard-recent");
    expect(effectiveSection("dashboard-deleted", team({ permissions: { "can-edit": true } }))).toBe(
      "dashboard-deleted",
    );
  });

  it("derives the section from the pathname", () => {
    expect(sectionFromPathname("/dashboard/recent")).toBe("dashboard-recent");
    expect(sectionFromPathname("/dashboard/fonts/providers")).toBe("dashboard-font-providers");
    expect(sectionFromPathname("/dashboard/files/")).toBe("dashboard-files");
    expect(sectionFromPathname("/settings/profile")).toBeNull();
  });
});

describe("href builders", () => {
  it("keeps the dashboard query params and drops nulls", () => {
    expect(dashboardHref("dashboard-recent", { teamId: "t1" })).toBe(
      "/dashboard/recent?team-id=t1",
    );
    expect(
      dashboardHref("dashboard-files", { teamId: "t1", projectId: "p1", searchTerm: null }),
    ).toBe("/dashboard/files?team-id=t1&project-id=p1");
    expect(dashboardHref("dashboard-recent")).toBe("/dashboard/recent");
  });

  it("builds the workspace href", () => {
    expect(workspaceHref({ teamId: "t1", fileId: "f1", pageId: "pg1" })).toBe(
      "/workspace?team-id=t1&file-id=f1&page-id=pg1",
    );
    expect(workspaceHref({ fileId: "f1" })).toBe("/workspace?file-id=f1");
  });

  it("reads the first page of a created file", () => {
    expect(firstPageId({ ...file(), data: { pages: ["pg1", "pg2"] } })).toBe("pg1");
    expect(firstPageId(file())).toBeNull();
  });
});

describe("projectsTitleName", () => {
  it("uses the personal label for the default team", () => {
    expect(projectsTitleName(team({ "is-default": true }), "Your Penpot")).toBe("Your Penpot");
    expect(projectsTitleName(team({ name: "Acme" }), "Your Penpot")).toBe("Acme");
    expect(projectsTitleName(null, "Your Penpot")).toBe("");
  });
});

describe("timeAgo (ct/timeago, date-fns v4 en-US)", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  const before = (ms: number) => new Date(now.getTime() - ms);
  const sec = 1000;
  const min = 60 * sec;
  const hour = 60 * min;
  const day = 24 * hour;

  it("formats the second bucket", () => {
    expect(timeAgo(before(sec), now)).toBe("1 second ago");
    expect(timeAgo(before(30 * sec), now)).toBe("30 seconds ago");
    expect(timeAgo(before(45 * sec), now)).toBe("45 seconds ago");
  });

  it("formats minutes and hours", () => {
    expect(timeAgo(before(min), now)).toBe("1 minute ago");
    expect(timeAgo(before(45 * min), now)).toBe("45 minutes ago");
    expect(timeAgo(before(90 * min), now)).toBe("2 hours ago");
    expect(timeAgo(before(23 * hour), now)).toBe("23 hours ago");
  });

  it("formats days, months and years", () => {
    expect(timeAgo(before(3 * day), now)).toBe("3 days ago");
    expect(timeAgo(before(40 * day), now)).toBe("1 month ago");
    // 360 days rounds to 12 months, which date-fns folds into "1 year".
    expect(timeAgo(before(360 * day), now)).toBe("1 year ago");
    expect(timeAgo(before(400 * day), now)).toBe("1 year ago");
    expect(timeAgo(before(730 * day), now)).toBe("2 years ago");
  });

  it("formats future dates with the in-prefix", () => {
    expect(timeAgo(new Date(now.getTime() + 5 * min), now)).toBe("in 5 minutes");
  });

  it("accepts ISO strings like transit Dates", () => {
    expect(timeAgo("2026-10-03T11:59:30Z", now)).toBe("30 seconds ago");
  });

  it("answers null for missing or invalid values", () => {
    expect(timeAgo(null, now)).toBeNull();
    expect(timeAgo(undefined, now)).toBeNull();
    expect(timeAgo("", now)).toBeNull();
    expect(timeAgo("not-a-date", now)).toBeNull();
    expect(timeAgo(new Date("nope"), now)).toBeNull();
  });
});

describe("unique names", () => {
  it("collects the used names of rows", () => {
    expect([...usedNames([project({ name: "A" }), file({ name: "B" }), { name: null }])]).toEqual([
      "A",
      "B",
    ]);
  });

  it("suffixes immediately when asked, like create-project/create-file", () => {
    expect(generateUniqueName("New Project", [], { immediateSuffix: true })).toBe("New Project 1");
    expect(
      generateUniqueName("New Project", ["New Project 1"], { immediateSuffix: true }),
    ).toBe("New Project 2");
  });

  it("keeps the base name when it is free", () => {
    expect(generateUniqueName("Copy", ["Other"])).toBe("Copy");
    expect(generateUniqueName("Copy", ["Copy", "Copy 1"])).toBe("Copy 2");
  });
});

describe("fileFeatures", () => {
  it("strips the frontend-only features from the team set", () => {
    const features = ["components/v2", "styles/v2", "fdata/pointer-map"];
    expect(fileFeatures(team({ features }))).toEqual(["components/v2", "fdata/pointer-map"]);
    expect(fileFeatures(null)).toEqual([]);
    expect(FRONTEND_ONLY_FEATURES).toContain("render-wasm/v1");
  });
});

describe("file selection", () => {
  it("toggles ids inside one project", () => {
    let selection = emptyFileSelection();
    selection = toggleFileSelect(selection, file({ id: "f1" }));
    selection = toggleFileSelect(selection, file({ id: "f2" }));
    expect([...selection.ids].sort()).toEqual(["f1", "f2"]);
    expect(selection.projectId).toBe("p1");
    selection = toggleFileSelect(selection, file({ id: "f1" }));
    expect([...selection.ids]).toEqual(["f2"]);
  });

  it("is a no-op across projects, like dd/toggle-file-select", () => {
    let selection = toggleFileSelect(emptyFileSelection(), file({ id: "f1" }));
    selection = toggleFileSelect(selection, file({ id: "f2", "project-id": "p2" }));
    expect([...selection.ids]).toEqual(["f1"]);
    expect(selection.projectId).toBe("p1");
  });

  it("reports the single selected file for the global Enter", () => {
    let selection = toggleFileSelect(emptyFileSelection(), file({ id: "f1" }));
    expect(singleSelectedFileId(selection)).toBe("f1");
    selection = toggleFileSelect(selection, file({ id: "f2" }));
    expect(singleSelectedFileId(selection)).toBeNull();
    expect(singleSelectedFileId(emptyFileSelection())).toBeNull();
  });
});

describe("computeGridLayout", () => {
  it("keeps limit 1 and no thumbnail until measured", () => {
    expect(computeGridLayout(null)).toEqual({
      limit: 1,
      thumbnailWidth: null,
      thumbnailHeight: null,
    });
  });

  it("caps the limit at 10 and switches the item size at 1030px", () => {
    expect(computeGridLayout(900).limit).toBe(3); // floor(900/230)
    expect(computeGridLayout(1030).limit).toBe(3); // floor(1030/280)
    expect(computeGridLayout(1400).limit).toBe(5); // floor(1400/280)
    expect(computeGridLayout(9999).limit).toBe(10);
  });

  it("derives an even thumbnail width and a 3:2 height", () => {
    const { thumbnailWidth, thumbnailHeight } = computeGridLayout(1400);
    expect(thumbnailWidth !== null && thumbnailWidth % 2).toBe(0);
    // floor((1400 - 32 - 4*24)/5 - 12) = floor(242.4) = 242
    expect(thumbnailWidth).toBe(242);
    expect(thumbnailHeight).toBe(Math.ceil(242 * (2 / 3)));
  });

  it("takes the itemsize override the libraries grid passes", () => {
    // floor(1400/350) = 4, not the floor(1400/280) = 5 the default rule gives.
    expect(computeGridLayout(1400, 350).limit).toBe(4);
    expect(computeGridLayout(null, 350).limit).toBe(1);
    // floor((1400 - 32 - 3*24)/4 - 12) = floor(313) = 313 -> 312 to stay even
    expect(computeGridLayout(1400, 350).thumbnailWidth).toBe(312);
  });
});

describe("duplicate names", () => {
  it("builds the copy suffixes of dd/duplicate-file", () => {
    const suffix = copySuffixFn("Copy");
    expect(suffix(1)).toBe(" Copy");
    expect(suffix(2)).toBe(" Copy 2");
    expect(generateUniqueName("File", ["File"], { suffixFn: suffix })).toBe("File Copy");
    expect(generateUniqueName("File", ["File", "File Copy"], { suffixFn: suffix })).toBe(
      "File Copy 2",
    );
    expect(generateUniqueName("File", ["Other"], { suffixFn: suffix })).toBe("File");
  });
});

describe("groupProjectsByTeam", () => {
  it("groups the get-all-projects rows keeping the input order", () => {
    const rows: AllProject[] = [
      { id: "p1", name: "A", "team-id": "t1", "team-name": "One", "is-default-team": true },
      { id: "p2", name: "B", "team-id": "t2", "team-name": "Two" },
      { id: "p3", name: "C", "team-id": "t1" },
    ];
    const groups = groupProjectsByTeam(rows);
    expect(groups.map((group) => group.id)).toEqual(["t1", "t2"]);
    expect(groups[0].name).toBe("One");
    expect(groups[0].isDefault).toBe(true);
    expect(groups[0].projects.map((row) => row.id)).toEqual(["p1", "p3"]);
    expect(groups[1].isDefault).toBe(false);
  });
});

describe("resolveMediaUri", () => {
  it("joins the public uri with assets/by-id", () => {
    expect(resolveMediaUri("", "abc")).toBe("/assets/by-id/abc");
    expect(resolveMediaUri("http://x:9001", "abc")).toBe("http://x:9001/assets/by-id/abc");
    expect(resolveMediaUri("http://x:9001/", "abc")).toBe("http://x:9001/assets/by-id/abc");
  });
});

describe("dashboard layout preference", () => {
  it("accepts only list and grid, defaulting to grid", () => {
    expect(parseDashboardLayout("list")).toBe("list");
    expect(parseDashboardLayout("grid")).toBe("grid");
    expect(parseDashboardLayout(null)).toBe("grid");
    expect(parseDashboardLayout("cards")).toBe("grid");
  });
});

// --- F5.3: trash, shared libraries and retention ------------------------------

function deletedFile(overrides: Partial<DeletedFile> = {}): DeletedFile {
  return { id: "d1", name: "Trashed", "project-id": "p1", ...overrides };
}

describe("visibleDeletedFiles", () => {
  const now = new Date("2026-10-03T12:00:00Z");

  it("keeps rows without a deadline and rows whose deadline is in the future", () => {
    const rows = [
      deletedFile({ id: "keep-nil" }),
      deletedFile({ id: "keep-future", "will-be-deleted-at": new Date("2026-10-10T00:00:00Z") }),
    ];
    expect(visibleDeletedFiles(rows, now).map((row) => row.id)).toEqual([
      "keep-nil",
      "keep-future",
    ]);
  });

  it("drops rows the backend task already collected", () => {
    const rows = [
      deletedFile({ id: "gone", "will-be-deleted-at": new Date("2026-10-01T00:00:00Z") }),
      deletedFile({ id: "exact", "will-be-deleted-at": now }),
    ];
    // ct/is-after? is strict, so a deadline equal to now is already gone.
    expect(visibleDeletedFiles(rows, now)).toEqual([]);
  });

  it("reads an ISO deadline as well as a Date", () => {
    const rows = [deletedFile({ id: "iso", "will-be-deleted-at": "2026-10-10T00:00:00Z" })];
    expect(visibleDeletedFiles(rows, now).map((row) => row.id)).toEqual(["iso"]);
  });
});

describe("deletedFilesOf", () => {
  it("filters by project and sorts modified-at descending", () => {
    const rows = [
      deletedFile({ id: "a", "project-id": "p1", "modified-at": new Date("2026-01-01") }),
      deletedFile({ id: "b", "project-id": "p2" }),
      deletedFile({ id: "c", "project-id": "p1", "modified-at": new Date("2026-06-01") }),
    ];
    expect(deletedFilesOf(rows, "p1").map((row) => row.id)).toEqual(["c", "a"]);
    expect(deletedFilesOf(rows, "p3")).toEqual([]);
  });
});

describe("deletedProjectsFor", () => {
  it("keeps the projects that still hold a deleted file, newest first", () => {
    const projects = [
      project({ id: "old", "modified-at": new Date("2026-01-01") }),
      project({ id: "new", "modified-at": new Date("2026-09-01") }),
      project({ id: "clean" }),
      project({ id: "deleted-project", "deleted-at": new Date("2026-08-01") }),
    ];
    const files = [deletedFile({ "project-id": "old" }), deletedFile({ "project-id": "new" })];
    // A deleted project without deleted files stays out: the second filter of
    // the CLJS memo dominates the first.
    expect(deletedProjectsFor(projects, files).map((row) => row.id)).toEqual(["new", "old"]);
  });

  it("answers nothing while the trash is empty", () => {
    expect(deletedProjectsFor([project()], [])).toEqual([]);
  });
});

describe("subscriptionType", () => {
  it("falls back to professional without a subscription", () => {
    expect(subscriptionType(null)).toBe("professional");
    expect(subscriptionType(undefined)).toBe("professional");
    expect(subscriptionType({})).toBe("professional");
    expect(subscriptionType({ type: "" })).toBe("professional");
  });

  it("falls back to professional for an unpaid or cancelled plan", () => {
    expect(subscriptionType({ type: "unlimited", status: "unpaid" })).toBe("professional");
    expect(subscriptionType({ type: "enterprise", status: "canceled" })).toBe("professional");
  });

  it("keeps the plan type otherwise", () => {
    expect(subscriptionType({ type: "unlimited", status: "active" })).toBe("unlimited");
    expect(subscriptionType({ type: "enterprise" })).toBe("enterprise");
  });
});

describe("sharedFilesForTeam", () => {
  function shared(overrides: Partial<SharedFile> = {}): SharedFile {
    return { id: "s1", name: "Library", "project-id": "p1", "team-id": "t1", ...overrides };
  }

  it("keeps this team's libraries, modified-at descending", () => {
    const rows = [
      shared({ id: "a", "modified-at": new Date("2026-01-01") }),
      shared({ id: "other-team", "team-id": "t2" }),
      shared({ id: "b", "modified-at": new Date("2026-07-01") }),
    ];
    expect(sharedFilesForTeam(rows, "t1").map((row) => row.id)).toEqual(["b", "a"]);
  });

  it("answers nothing without a team", () => {
    expect(sharedFilesForTeam([shared()], null)).toEqual([]);
  });
});

describe("colorSampleValue", () => {
  it("prefers the gradient type, then the colour, then the raw value", () => {
    expect(colorSampleValue({ id: "c", name: "n", gradient: { type: "linear" } })).toBe("linear");
    expect(colorSampleValue({ id: "c", name: "n", color: "#ff0000" })).toBe("#ff0000");
    expect(colorSampleValue({ id: "c", name: "n", value: "#00ff00" })).toBe("#00ff00");
    expect(colorSampleValue({ id: "c", name: "n" })).toBe("");
  });

  it("ignores an empty gradient", () => {
    expect(colorSampleValue({ id: "c", name: "n", gradient: null, color: "#123456" })).toBe(
      "#123456",
    );
  });
});
