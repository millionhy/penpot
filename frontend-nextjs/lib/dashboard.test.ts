import { describe, expect, it } from "vitest";
import {
  FRONTEND_ONLY_FEATURES,
  dashboardHref,
  defaultProject,
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
  timeAgo,
  usedNames,
  visibleProjects,
  workspaceHref,
  canEdit,
  type FileSummary,
  type Project,
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
