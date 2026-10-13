// Unit tests for the plugin runtime bridge (app.plugins/initialize +
// init-plugins-runtime and the load/close/open half of
// app.main.data.plugins): the dynamic import and the readiness signal, the
// camelCase manifest handed to the runtime global, the open-plugins set and
// its error paths, and the open flow with its re-confirmation branches. The
// runtime package is mocked (it needs a browser) and the RPC transport is
// mocked. Every test re-imports the modules so the module state starts
// clean.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cmd: vi.fn(),
  initPluginsRuntime: vi.fn(),
}));

vi.mock("@/lib/rpc", () => ({ cmd: mocks.cmd }));
vi.mock("@penpot/plugins-runtime", () => ({
  initPluginsRuntime: mocks.initPluginsRuntime,
}));

import { config } from "@/lib/config";
import { tr } from "@/lib/i18n";
import type { RegistryEntry } from "@/lib/plugins";

let runtime: typeof import("@/lib/plugin-runtime");
let plugins: typeof import("@/lib/plugins");
let flags: typeof import("@/lib/plugin-flags");

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mocks.cmd.mockReset();
  mocks.initPluginsRuntime.mockReset();
  unsetRuntimeGlobals();
  runtime = await import("@/lib/plugin-runtime");
  plugins = await import("@/lib/plugins");
  flags = await import("@/lib/plugin-flags");
  plugins.initRegistryFromProfile(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- fixtures ---------------------------------------------------------------

const MANIFEST_URL = "https://plugins.example/manifest.json";

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    "plugin-id": "plugin-a",
    name: "Plugin A",
    description: "Does things",
    url: MANIFEST_URL,
    version: 1,
    host: "https://plugins.example",
    code: "plugin.js",
    icon: "icon.png",
    permissions: ["content:read"],
    ...overrides,
  };
}

function seedRegistry(entries: RegistryEntry[]): void {
  plugins.initRegistryFromProfile({
    props: {
      plugins: {
        ids: entries.map((entry) => entry["plugin-id"]),
        data: Object.fromEntries(entries.map((entry) => [entry["plugin-id"], entry])),
      },
    },
  });
}

function unsetRuntimeGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  delete globals["ɵloadPlugin"];
  delete globals["ɵunloadPlugin"];
}

function stubRuntimeGlobals(load?: unknown, unload?: unknown): void {
  const globals = globalThis as Record<string, unknown>;
  if (load !== undefined) globals["ɵloadPlugin"] = load;
  if (unload !== undefined) globals["ɵunloadPlugin"] = unload;
}

// The runtime globals work in pairs: closing a plugin runs the close
// callback loadPluginEntry handed over, which unmarks the plugin. The mocks
// mirror that handshake.
function stubRuntimeHandshake(): {
  load: ReturnType<typeof vi.fn>;
  unload: ReturnType<typeof vi.fn>;
} {
  const closeCallbacks = new Map<string, () => void>();
  const load = vi.fn(async (manifest: { pluginId: string }, callback: () => void) => {
    closeCallbacks.set(manifest.pluginId, callback);
  });
  const unload = vi.fn((pluginId: unknown) => {
    closeCallbacks.get(String(pluginId))?.();
  });
  stubRuntimeGlobals(load, unload);
  return { load, unload };
}

function stubManifestFetch(body: unknown): void {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 200 }));
}

const manifestBody = {
  name: "Plugin A",
  description: "Does things",
  code: "plugin.js",
  icon: "icon.png",
  permissions: ["content:read"],
};

// --- startPluginRuntime -----------------------------------------------------

describe("startPluginRuntime", () => {
  it("initializes the package once with the context builder and signals readiness", async () => {
    await runtime.startPluginRuntime();
    await runtime.startPluginRuntime();

    expect(mocks.initPluginsRuntime).toHaveBeenCalledTimes(1);
    const builder = mocks.initPluginsRuntime.mock.calls[0][0] as (id: string) => {
      version: string;
    };
    const zeroContext = builder("00000000-0000-0000-0000-000000000000");
    expect(zeroContext.version).toBe(config.version ?? "");

    await expect(runtime.waitForRuntime()).resolves.toBeUndefined();
  });

  it("still signals readiness when the package init throws", async () => {
    mocks.initPluginsRuntime.mockImplementationOnce(() => {
      throw new Error("init failed");
    });

    await runtime.startPluginRuntime();

    expect(console.error).toHaveBeenCalled();
    await expect(runtime.waitForRuntime()).resolves.toBeUndefined();
  });
});

// --- loadPluginEntry --------------------------------------------------------

describe("loadPluginEntry", () => {
  it("hands the runtime the camelCase manifest and initializes the flags", async () => {
    let manifestArg: unknown;
    let closeCallback: (() => void) | undefined;
    const load = vi.fn(async (manifest: unknown, callback: () => void) => {
      manifestArg = manifest;
      closeCallback = callback;
    });
    stubRuntimeGlobals(load);

    await runtime.loadPluginEntry(makeEntry({ version: 2 }));

    expect(load).toHaveBeenCalledTimes(1);
    expect(manifestArg).toEqual({
      pluginId: "plugin-a",
      name: "Plugin A",
      description: "Does things",
      version: 2,
      host: "https://plugins.example",
      code: "plugin.js",
      icon: "icon.png",
      permissions: ["content:read"],
    });
    expect(typeof closeCallback).toBe("function");
    expect(flags.getPluginFlag("plugin-a", flags.THROW_VALIDATION_ERRORS)).toBe(true);
    expect(runtime.getOpenPlugins()).toContain("plugin-a");
  });

  it("unmarks the plugin when its close callback runs", async () => {
    let closeCallback: (() => void) | undefined;
    const load = vi.fn(async (_manifest: unknown, callback: () => void) => {
      closeCallback = callback;
    });
    stubRuntimeGlobals(load);

    await runtime.loadPluginEntry(makeEntry());
    expect(runtime.getOpenPlugins()).toContain("plugin-a");

    closeCallback?.();
    expect(runtime.getOpenPlugins()).not.toContain("plugin-a");
  });

  it("unmarks the plugin when the runtime is not initialized", async () => {
    await runtime.loadPluginEntry(makeEntry());

    expect(console.warn).toHaveBeenCalled();
    expect(runtime.getOpenPlugins()).toEqual([]);
  });

  it("unmarks the plugin and flashes the error when the load fails", async () => {
    stubRuntimeGlobals(
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const error = vi.fn();
    runtime.setPluginRuntimeNotifier({ warn: vi.fn(), error });

    await runtime.loadPluginEntry(makeEntry());

    expect(runtime.getOpenPlugins()).toEqual([]);
    expect(error).toHaveBeenCalledWith("boom");
  });
});

// --- closing ----------------------------------------------------------------

describe("closePluginEntry", () => {
  it("unloads through the runtime global", async () => {
    const { unload } = stubRuntimeHandshake();
    await runtime.loadPluginEntry(makeEntry());

    runtime.closePluginEntry("plugin-a");

    expect(unload).toHaveBeenCalledWith("plugin-a");
    expect(runtime.getOpenPlugins()).toEqual([]);
  });

  it("warns when the runtime is not initialized", () => {
    runtime.closePluginEntry("plugin-a");
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("closeCurrentPlugins", () => {
  it("keeps the non-edition plugins when editionOnly is set", async () => {
    const { unload } = stubRuntimeHandshake();
    const edition = makeEntry({ permissions: ["content:read", "content:write"] });
    const plain = makeEntry({ "plugin-id": "plugin-b", name: "Plugin B" });
    seedRegistry([edition, plain]);
    await runtime.loadPluginEntry(edition);
    await runtime.loadPluginEntry(plain);

    runtime.closeCurrentPlugins({ editionOnly: true });
    expect(unload).toHaveBeenCalledTimes(1);
    expect(unload).toHaveBeenCalledWith("plugin-a");
    expect(runtime.getOpenPlugins()).toEqual(["plugin-b"]);

    runtime.closeCurrentPlugins();
    expect(unload).toHaveBeenCalledTimes(2);
    expect(unload).toHaveBeenLastCalledWith("plugin-b");
    expect(runtime.getOpenPlugins()).toEqual([]);
  });

  it("reads the peek over the stored permissions", async () => {
    const { unload } = stubRuntimeHandshake();
    const edition = makeEntry({ permissions: ["content:read", "content:write"] });
    seedRegistry([edition]);
    await runtime.loadPluginEntry(edition);

    // The daily peek answered with read-only permissions since.
    plugins.savePluginPermissionsPeek("plugin-a", ["content:read"]);
    runtime.closeCurrentPlugins({ editionOnly: true });

    expect(unload).not.toHaveBeenCalled();
    expect(runtime.getOpenPlugins()).toEqual(["plugin-a"]);
  });
});

// --- openPluginEntry --------------------------------------------------------

describe("openPluginEntry", () => {
  it("loads a bundled plugin directly", async () => {
    const load = vi.fn(async () => undefined);
    stubRuntimeGlobals(load);
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    await runtime.openPluginEntry(makeEntry({ url: undefined }), true, vi.fn());

    expect(fetchStub).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("re-fetches, saves the peek and loads when the manifest matches", async () => {
    const load = vi.fn(async () => undefined);
    stubRuntimeGlobals(load);
    stubManifestFetch(manifestBody);
    const confirm = vi.fn();

    await runtime.openPluginEntry(makeEntry(), true, confirm);

    expect(confirm).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(plugins.getPluginPermissionsPeek("plugin-a")).toEqual(["content:read"]);
  });

  it("asks for re-confirmation when the fetched manifest differs", async () => {
    const load = vi.fn(async () => undefined);
    stubRuntimeGlobals(load);
    mocks.cmd.mockResolvedValue(undefined);
    stubManifestFetch({ ...manifestBody, permissions: ["content:write"] });
    const confirm = vi.fn();

    await runtime.openPluginEntry(makeEntry(), true, confirm);

    expect(load).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    const [manifest, onAccept] = confirm.mock.calls[0] as [RegistryEntry, () => void];
    expect(manifest["plugin-id"]).toBe("plugin-a");
    expect(manifest.permissions).toEqual(["content:write", "content:read"]);

    // Accepting installs the fetched manifest and loads it.
    onAccept();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(mocks.cmd).toHaveBeenCalledWith("add-profile-plugin", expect.anything());
    expect(plugins.getPlugin("plugin-a")?.permissions).toEqual([
      "content:write",
      "content:read",
    ]);
  });

  it("warns need-editor for an edition plugin without edit rights, after saving the peek", async () => {
    const load = vi.fn(async () => undefined);
    stubRuntimeGlobals(load);
    stubManifestFetch({ ...manifestBody, permissions: ["content:write"] });
    const warn = vi.fn();
    runtime.setPluginRuntimeNotifier({ warn, error: vi.fn() });

    await runtime.openPluginEntry(makeEntry(), false, vi.fn());

    expect(warn).toHaveBeenCalledWith(tr("workspace.plugins.error.need-editor"));
    expect(plugins.getPluginPermissionsPeek("plugin-a")).toEqual([
      "content:write",
      "content:read",
    ]);
    expect(load).not.toHaveBeenCalled();
  });

  it("warns unreachable when the fetch fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network");
    });
    const warn = vi.fn();
    runtime.setPluginRuntimeNotifier({ warn, error: vi.fn() });

    await runtime.openPluginEntry(makeEntry(), true, vi.fn());

    expect(warn).toHaveBeenCalledWith(tr("workspace.plugins.error.unreachable"));
  });

  it("warns unreachable when the manifest fails validation", async () => {
    stubManifestFetch({});
    const warn = vi.fn();
    runtime.setPluginRuntimeNotifier({ warn, error: vi.fn() });

    await runtime.openPluginEntry(makeEntry(), true, vi.fn());

    expect(warn).toHaveBeenCalledWith(tr("workspace.plugins.error.unreachable"));
    expect(plugins.getPluginPermissionsPeek("plugin-a")).toBeUndefined();
  });
});
