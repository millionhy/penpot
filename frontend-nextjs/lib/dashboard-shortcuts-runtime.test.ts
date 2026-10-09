import { describe, expect, it, vi } from "vitest";
import {
  buildDashboardBindings,
  dashboardSetForPath,
  dispatchDashboardKeydown,
  nextTheme,
} from "@/lib/dashboard-shortcuts-runtime";
import type { DashboardShortcutActions } from "@/lib/dashboard-shortcuts";
import { createShortcutMatcher, type CustomShortcuts } from "@/lib/shortcuts";

function fakeActions() {
  return {
    navigate: vi.fn(),
    defaultProjectId: "project-1",
    toggleTheme: vi.fn(),
    createElement: vi.fn(),
  } satisfies DashboardShortcutActions;
}

describe("dashboardSetForPath", () => {
  it("resolves the page sets of the dashboard area", () => {
    expect(dashboardSetForPath("/dashboard/recent")).toBe("projects");
    expect(dashboardSetForPath("/dashboard/files")).toBe("drafts-libraries");
    expect(dashboardSetForPath("/dashboard/files/8f4a-1234")).toBe("drafts-libraries");
    expect(dashboardSetForPath("/dashboard/libraries")).toBe("drafts-libraries");
  });

  it("falls back to the shell set for the other dashboard routes", () => {
    expect(dashboardSetForPath("/dashboard")).toBe("dashboard");
    expect(dashboardSetForPath("/dashboard/search")).toBe("dashboard");
    expect(dashboardSetForPath("/dashboard/deleted")).toBe("dashboard");
    expect(dashboardSetForPath("/dashboard/fonts/providers")).toBe("dashboard");
    expect(dashboardSetForPath("/dashboard/members")).toBe("dashboard");
  });

  it("resolves the settings routes to the base set", () => {
    expect(dashboardSetForPath("/settings")).toBe("base");
    expect(dashboardSetForPath("/settings/shortcuts")).toBe("base");
    expect(dashboardSetForPath("/settings/profile")).toBe("base");
  });

  it("returns null outside the dashboard and settings areas", () => {
    expect(dashboardSetForPath("/")).toBeNull();
    expect(dashboardSetForPath("/view")).toBeNull();
    expect(dashboardSetForPath("/workspace")).toBeNull();
    expect(dashboardSetForPath("/dashboardz")).toBeNull();
    expect(dashboardSetForPath("/settingsz")).toBeNull();
  });
});

describe("buildDashboardBindings", () => {
  it("builds one binding per definition with its default command", () => {
    const bindings = buildDashboardBindings("base", false, null, fakeActions());
    expect(bindings).toHaveLength(1);
    expect(bindings[0].command).toBe("alt+m");
  });

  it("carries the five commands of the projects set", () => {
    const bindings = buildDashboardBindings("projects", false, null, fakeActions());
    expect(bindings.map((binding) => binding.command)).toEqual([
      "alt+m",
      "g d",
      "g l",
      "ctrl+f",
      "+",
    ]);
  });

  it("dispatches every binding to its action", () => {
    const actions = fakeActions();
    const bindings = buildDashboardBindings("projects", false, null, actions);
    const run = (command: string) => bindings.find((binding) => binding.command === command)!.run();
    run("alt+m");
    expect(actions.toggleTheme).toHaveBeenCalledTimes(1);
    run("g d");
    expect(actions.navigate).toHaveBeenCalledWith("dashboard-files", { projectId: "project-1" });
    run("g l");
    expect(actions.navigate).toHaveBeenCalledWith("dashboard-libraries");
    run("ctrl+f");
    expect(actions.navigate).toHaveBeenCalledWith("dashboard-search");
    run("+");
    expect(actions.createElement).toHaveBeenCalledTimes(1);
  });

  it("keeps the platform commands per platform", () => {
    const base = buildDashboardBindings("base", true, null, fakeActions());
    expect(base[0].command).toBe("alt+m");
    const search = buildDashboardBindings("drafts-libraries", true, null, fakeActions());
    expect(search.map((binding) => binding.command)).toContain("command+f");
  });

  it("applies the dashboard group overrides", () => {
    const customs: CustomShortcuts = { dashboard: { "toggle-theme": "shift+t" } };
    const bindings = buildDashboardBindings("base", false, customs, fakeActions());
    expect(bindings[0].command).toBe("shift+t");
  });

  it("ignores overrides of other groups", () => {
    const customs: CustomShortcuts = { workspace: { "toggle-theme": "shift+t" } };
    const bindings = buildDashboardBindings("base", false, customs, fakeActions());
    expect(bindings[0].command).toBe("alt+m");
  });

  it("keeps a cleared override as a binding the matcher never fires", () => {
    const customs: CustomShortcuts = { dashboard: { "toggle-theme": "" } };
    const actions = fakeActions();
    const bindings = buildDashboardBindings("base", false, customs, actions);
    expect(bindings[0].command).toBe("");
    const matcher = createShortcutMatcher(bindings);
    expect(matcher.handle("alt+m")).toBe(false);
    expect(actions.toggleTheme).not.toHaveBeenCalled();
    matcher.dispose();
  });
});

describe("nextTheme", () => {
  it("cycles dark -> light -> system -> dark", () => {
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("system");
    expect(nextTheme("system")).toBe("dark");
  });

  it("treats the legacy default as dark", () => {
    // du/toggle-theme rewrites "default" to "dark" before the case, so
    // the first toggle takes the dark -> light step.
    expect(nextTheme("default")).toBe(nextTheme("dark"));
    expect(nextTheme("default")).toBe("light");
  });

  it("falls back to dark for missing or unknown values", () => {
    expect(nextTheme(null)).toBe("dark");
    expect(nextTheme(undefined)).toBe("dark");
    expect(nextTheme("")).toBe("dark");
    expect(nextTheme("solarized")).toBe("dark");
  });
});

describe("dispatchDashboardKeydown", () => {
  it("fires a single-key binding from its keydown event", () => {
    const actions = fakeActions();
    const matcher = createShortcutMatcher(buildDashboardBindings("base", false, null, actions));
    const fired = dispatchDashboardKeydown(matcher, { key: "m", code: "KeyM", altKey: true }, false);
    expect(fired).toBe(true);
    expect(actions.toggleTheme).toHaveBeenCalledTimes(1);
    matcher.dispose();
  });

  it("ignores standalone modifier presses", () => {
    const actions = fakeActions();
    const matcher = createShortcutMatcher(buildDashboardBindings("base", false, null, actions));
    expect(dispatchDashboardKeydown(matcher, { key: "Alt", altKey: true }, false)).toBe(false);
    expect(actions.toggleTheme).not.toHaveBeenCalled();
    matcher.dispose();
  });

  it("advances the two-step sequences across keydowns", () => {
    const actions = fakeActions();
    const matcher = createShortcutMatcher(buildDashboardBindings("projects", false, null, actions));
    dispatchDashboardKeydown(matcher, { key: "g", code: "KeyG" }, false);
    dispatchDashboardKeydown(matcher, { key: "d", code: "KeyD" }, false);
    expect(actions.navigate).toHaveBeenCalledWith("dashboard-files", { projectId: "project-1" });
    matcher.dispose();
  });

  it("matches Shift+= as the + binding (US main row)", () => {
    const actions = fakeActions();
    const matcher = createShortcutMatcher(buildDashboardBindings("projects", false, null, actions));
    const fired = dispatchDashboardKeydown(
      matcher,
      { key: "+", code: "Equal", shiftKey: true },
      false,
    );
    expect(fired).toBe(true);
    expect(actions.createElement).toHaveBeenCalledTimes(1);
    matcher.dispose();
  });

  it("matches the mac Command bindings on mac", () => {
    const actions = fakeActions();
    const matcher = createShortcutMatcher(
      buildDashboardBindings("drafts-libraries", true, null, actions),
    );
    const fired = dispatchDashboardKeydown(
      matcher,
      { key: "f", code: "KeyF", metaKey: true },
      true,
    );
    expect(fired).toBe(true);
    expect(actions.navigate).toHaveBeenCalledWith("dashboard-search");
    matcher.dispose();
  });

  it("does not fire inside text inputs", () => {
    const actions = fakeActions();
    const matcher = createShortcutMatcher(buildDashboardBindings("base", false, null, actions));
    const fired = dispatchDashboardKeydown(
      matcher,
      { key: "m", code: "KeyM", altKey: true },
      false,
      { tagName: "INPUT" },
    );
    expect(fired).toBe(false);
    expect(actions.toggleTheme).not.toHaveBeenCalled();
    matcher.dispose();
  });
});
