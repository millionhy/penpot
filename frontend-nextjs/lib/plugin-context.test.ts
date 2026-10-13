// Unit tests for the plugin host context (create-context in
// app.plugins.api): the theme read and its themechange dispatch, the
// listener registry with its debounce and per-listener error guard, the
// flags and localStorage proxies with their validation, and the workspace
// placeholders. Every test re-imports the modules so the module state
// (listeners, flags, the theme dedupe) starts clean.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rpc", () => ({ cmd: vi.fn() }));

import { config } from "@/lib/config";

let context: typeof import("@/lib/plugin-context");
let flags: typeof import("@/lib/plugin-flags");
let plugins: typeof import("@/lib/plugins");

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  context = await import("@/lib/plugin-context");
  flags = await import("@/lib/plugin-flags");
  plugins = await import("@/lib/plugins");
  plugins.initRegistryFromProfile(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- fixtures ---------------------------------------------------------------

function stubHtmlClass(theme: string): void {
  vi.stubGlobal("document", {
    documentElement: {
      classList: { contains: (name: string) => name === theme },
    },
  });
}

function stubLocalStorage(seed: Record<string, string> = {}): Record<string, unknown> {
  const storage: Record<string, unknown> = { ...seed };
  storage.getItem = (key: string) =>
    typeof storage[key] === "string" ? (storage[key] as string) : null;
  storage.setItem = (key: string, value: unknown) => {
    storage[key] = String(value);
  };
  storage.removeItem = (key: string) => {
    delete storage[key];
  };
  vi.stubGlobal("window", { localStorage: storage });
  return storage;
}

function seedRegistryEntry(permissions: string[]): void {
  plugins.initRegistryFromProfile({
    props: {
      plugins: {
        ids: ["plugin-a"],
        data: {
          "plugin-a": {
            "plugin-id": "plugin-a",
            name: "Plugin A",
            host: "https://plugins.example",
            code: "plugin.js",
            permissions,
          },
        },
      },
    },
  });
}

// --- theme ------------------------------------------------------------------

describe("theme", () => {
  it("reads the resolved theme from the html class", () => {
    stubHtmlClass("light");
    expect(context.currentPluginTheme()).toBe("light");
    stubHtmlClass("default");
    expect(context.currentPluginTheme()).toBe("dark");
  });

  it("defaults to dark without a document", () => {
    expect(context.currentPluginTheme()).toBe("dark");
  });

  it("exposes the theme through the context getter", () => {
    stubHtmlClass("light");
    expect(context.createPluginContext("plugin-a").theme).toBe("light");
  });

  it("dispatches themechange once per change, after the debounce", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    context.addPluginListener("plugin-a", "themechange", callback);

    context.notifyPluginThemeChange("light");
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledWith("light");

    // The dedupe keeps the CLJS ::not-changed semantics.
    context.notifyPluginThemeChange("light");
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledTimes(1);

    context.notifyPluginThemeChange("dark");
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenLastCalledWith("dark");
  });
});

// --- listener registry ------------------------------------------------------

describe("listener registry", () => {
  it("debounces a burst into one callback with the last value", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    context.addPluginListener("plugin-a", "themechange", callback);

    context.dispatchPluginEvent("themechange", "light");
    context.dispatchPluginEvent("themechange", "dark");
    vi.advanceTimersByTime(10);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("dark");
  });

  it("stops calling a removed listener", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const key = context.addPluginListener("plugin-a", "themechange", callback);

    context.removePluginListener(key);
    context.dispatchPluginEvent("themechange", "light");
    vi.advanceTimersByTime(10);

    expect(callback).not.toHaveBeenCalled();
  });

  it("ignores events of other types", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    context.addPluginListener("plugin-a", "finish", callback);

    context.dispatchPluginEvent("themechange", "light");
    vi.advanceTimersByTime(10);

    expect(callback).not.toHaveBeenCalled();
  });

  it("survives a throwing callback and keeps notifying the rest", () => {
    vi.useFakeTimers();
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const other = vi.fn();
    context.addPluginListener("plugin-a", "themechange", throwing);
    context.addPluginListener("plugin-b", "themechange", other);

    context.dispatchPluginEvent("themechange", "light");
    vi.advanceTimersByTime(10);

    expect(other).toHaveBeenCalledWith("light");
    expect(console.error).toHaveBeenCalled();
  });

  it("wires the context methods to the same registry", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const ctx = context.createPluginContext("plugin-a");

    const key = ctx.addListener("themechange", callback);
    context.dispatchPluginEvent("themechange", "dark");
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledWith("dark");

    ctx.removeListener(key);
    context.dispatchPluginEvent("themechange", "light");
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

// --- flags proxy ------------------------------------------------------------

describe("flags proxy", () => {
  it("initializes version 2 plugins hardened", () => {
    flags.initPluginFlags("plugin-a", 2);
    const ctx = context.createPluginContext("plugin-a");
    expect(ctx.flags.throwValidationErrors).toBe(true);
    expect(ctx.flags.naturalChildOrdering).toBe(false);
  });

  it("reads and writes naturalChildOrdering", () => {
    flags.initPluginFlags("plugin-a", 1);
    const ctx = context.createPluginContext("plugin-a");
    expect(ctx.flags.naturalChildOrdering).toBe(false);

    ctx.flags.naturalChildOrdering = true;
    expect(ctx.flags.naturalChildOrdering).toBe(true);
    expect(flags.getPluginFlag("plugin-a", flags.NATURAL_CHILD_ORDERING)).toBe(true);
  });

  it("rejects a non-boolean write with a console error for version 1", () => {
    flags.initPluginFlags("plugin-a", 1);
    const ctx = context.createPluginContext("plugin-a");

    ctx.flags.naturalChildOrdering = "yes";
    expect(ctx.flags.naturalChildOrdering).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Value not valid"));
  });

  it("throws a non-boolean write for a hardened plugin", () => {
    flags.initPluginFlags("plugin-a", 2);
    const ctx = context.createPluginContext("plugin-a");
    expect(() => {
      ctx.flags.naturalChildOrdering = "yes";
    }).toThrow(/Value not valid/);
  });
});

// --- notValid ---------------------------------------------------------------

describe("notValid", () => {
  it("returns null and logs for a version 1 plugin", () => {
    flags.initPluginFlags("plugin-a", 1);
    expect(context.notValid("plugin-a", "code", 5)).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "[PENPOT PLUGIN] Value not valid: 5. Code: code",
    );
  });

  it("throws for a version 2 plugin", () => {
    flags.initPluginFlags("plugin-a", 2);
    expect(() => context.notValid("plugin-a", "code", 5)).toThrow(
      "[PENPOT PLUGIN] Value not valid: 5. Code: code",
    );
  });

  it("omits the value when there is none", () => {
    flags.initPluginFlags("plugin-a", 1);
    context.notValid("plugin-a", "code");
    expect(console.error).toHaveBeenCalledWith("[PENPOT PLUGIN] Value not valid. Code: code");
  });
});

// --- localStorage proxy -----------------------------------------------------

describe("localStorage proxy", () => {
  it("prefixes every key with the plugin id", () => {
    const storage = stubLocalStorage();
    seedRegistryEntry(["allow:localstorage"]);
    const ctx = context.createPluginContext("plugin-a");

    ctx.localStorage.setItem("alpha", "1");
    expect(storage["penpot-plugins:plugin-a/alpha"]).toBe("1");
    expect(ctx.localStorage.getItem("alpha")).toBe("1");

    ctx.localStorage.removeItem("alpha");
    expect(ctx.localStorage.getItem("alpha")).toBeNull();
  });

  it("lists only the keys of the plugin", () => {
    stubLocalStorage({
      "penpot-plugins:plugin-a/alpha": "1",
      "penpot-plugins:plugin-a/beta": "2",
      "penpot-plugins:plugin-b/gamma": "3",
    });
    seedRegistryEntry(["allow:localstorage"]);
    const ctx = context.createPluginContext("plugin-a");

    expect(ctx.localStorage.getKeys()).toEqual(["alpha", "beta"]);
  });

  it("rejects operations without the permission", () => {
    stubLocalStorage();
    seedRegistryEntry([]);
    const ctx = context.createPluginContext("plugin-a");

    expect(ctx.localStorage.getItem("alpha")).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("allow:localstorage"),
    );
  });

  it("rejects non-string keys", () => {
    stubLocalStorage();
    seedRegistryEntry(["allow:localstorage"]);
    const ctx = context.createPluginContext("plugin-a");

    expect(ctx.localStorage.getItem(5)).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("key must be a string"),
    );
  });
});

// --- context surface --------------------------------------------------------

describe("context surface", () => {
  it("mirrors the config version and carries the plugin id", () => {
    const ctx = context.createPluginContext("plugin-a");
    expect(ctx.$plugin).toBe("plugin-a");
    expect(ctx.version).toBe(config.version ?? "");
  });

  it("answers the workspace reads with null or an empty array", () => {
    const ctx = context.createPluginContext("plugin-a");
    expect(ctx.root).toBeNull();
    expect(ctx.currentFile).toBeNull();
    expect(ctx.currentPage).toBeNull();
    expect(ctx.viewport).toBeNull();
    expect(ctx.history).toBeNull();
    expect(ctx.library).toBeNull();
    expect(ctx.fonts).toBeNull();
    expect(ctx.currentUser).toBeNull();
    expect(ctx.activeUsers).toEqual([]);
    expect(ctx.selection).toEqual([]);
  });

  it("throws a named error on the workspace writes", () => {
    const ctx = context.createPluginContext("plugin-a");
    expect(() => ctx.createBoard()).toThrow(/needs the workspace editor/);
    expect(() => ctx.uploadMediaUrl("name", "url")).toThrow(
      "'uploadMediaUrl' needs the workspace editor, which arrives with F9",
    );
    expect(() => ctx.replaceColor([], {}, {})).toThrow(/needs the workspace editor/);
  });

  it("validates the selection setter before the workspace error", () => {
    flags.initPluginFlags("plugin-a", 1);
    const ctx = context.createPluginContext("plugin-a");

    ctx.selection = "not-an-array";
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Value not valid"));

    expect(() => {
      ctx.selection = [];
    }).toThrow(/needs the workspace editor/);
  });
});
