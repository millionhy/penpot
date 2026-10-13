// Unit tests for the plugin data layer: manifest parsing and validation
// (register.cljs parse-manifest), the registry and its subscriptions, the
// in-flight tracking, install/remove with optimistic updates and rollback,
// the manifest fetch (data/plugins.cljs fetch-manifest), the permissions
// peek, the dialog permission rows and the stored plugin url. The RPC
// transport is mocked; the wire shape of the plugin param is asserted
// through the real transit encoder.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rpc", () => ({
  cmd: vi.fn(),
}));

import { cmd } from "@/lib/rpc";
import { RpcError } from "@/lib/errors";
import { encodeTransit } from "@/lib/transit";
import {
  MCP_PLUGIN_ID,
  ZERO_UUID,
  checkPluginPermission,
  clearStoredPluginUrl,
  fetchManifest,
  getPlugin,
  getPluginPermissionsPeek,
  getPluginsList,
  iconUrl,
  initRegistryFromProfile,
  installPlugin,
  isEditionPlugin,
  normalizePluginUrl,
  parseManifest,
  permissionRows,
  removePlugin,
  savePluginPermissionsPeek,
  shouldUpdatePermissionsPeek,
  storedPluginUrl,
  subscribeInFlight,
  subscribeRegistry,
  updatePluginsPermissionsPeek,
  type RegistryEntry,
} from "@/lib/plugins";

const cmdMock = vi.mocked(cmd);

// --- fixtures ---------------------------------------------------------------

const MANIFEST_URL = "https://plugins.example/manifest.json";

const manifest = {
  name: "My plugin",
  description: "Does things",
  code: "plugin.js",
  icon: "icon.png",
  permissions: ["content:write"],
};

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    "plugin-id": "plugin-a",
    name: "Plugin A",
    host: "https://plugins.example",
    code: "plugin.js",
    permissions: ["content:read"],
    ...overrides,
  };
}

function seedRegistry(entries: RegistryEntry[]): void {
  initRegistryFromProfile({
    props: {
      plugins: {
        ids: entries.map((entry) => entry["plugin-id"]),
        data: Object.fromEntries(entries.map((entry) => [entry["plugin-id"], entry])),
      },
    },
  });
}

function stubManifestFetch(body: unknown, status = 200): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

beforeEach(() => {
  vi.restoreAllMocks();
  // parse-manifest logs the failing keys and install/remove log the errors;
  // the tests assert the behavior, not the console output.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  cmdMock.mockReset();
  seedRegistry([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- parseManifest ----------------------------------------------------------

describe("parseManifest", () => {
  it("reads the manifest fields and defaults the version to 1", () => {
    const entry = parseManifest(MANIFEST_URL, manifest);
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({
      url: MANIFEST_URL,
      version: 1,
      name: "My plugin",
      description: "Does things",
      code: "plugin.js",
      icon: "icon.png",
      host: "https://plugins.example",
    });
    expect(entry!["plugin-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("omits absent optional fields (d/without-nils)", () => {
    const entry = parseManifest(MANIFEST_URL, { name: "P", code: "c" });
    expect(entry).not.toBeNull();
    expect("description" in entry!).toBe(false);
    expect("icon" in entry!).toBe(false);
    expect(entry!.version).toBe(1);
  });

  it("expands write permissions to their read counterpart", () => {
    const entry = parseManifest(MANIFEST_URL, {
      name: "P",
      code: "c",
      permissions: ["content:write", "library:write", "comment:write", "clipboard:write"],
    });
    expect(new Set(entry!.permissions)).toEqual(
      new Set([
        "content:write",
        "content:read",
        "library:write",
        "library:read",
        "comment:write",
        "comment:read",
        "clipboard:write",
        "clipboard:read",
      ]),
    );
  });

  it("maps a v1 plugin to the bare origin", () => {
    const entry = parseManifest("https://plugins.example/dir/manifest.json", {
      name: "P",
      code: "c",
    });
    expect(entry!.host).toBe("https://plugins.example");
  });

  it("maps a v2 plugin to its containing directory", () => {
    const entry = parseManifest("https://plugins.example/dir/manifest.json", {
      name: "P",
      code: "c",
      version: 2,
    });
    expect(entry!.host).toBe("https://plugins.example/dir/");
  });

  it("reuses the plugin-id of an entry with the same name and host", () => {
    seedRegistry([makeEntry({ "plugin-id": "kept-id", name: "Same", host: "https://plugins.example" })]);
    const entry = parseManifest(MANIFEST_URL, { name: "Same", code: "c" });
    expect(entry!["plugin-id"]).toBe("kept-id");
  });

  it("creates a new plugin-id when the host differs", () => {
    seedRegistry([makeEntry({ "plugin-id": "kept-id", name: "Same", host: "https://plugins.example" })]);
    const entry = parseManifest("https://other.example/manifest.json", { name: "Same", code: "c" });
    expect(entry!["plugin-id"]).not.toBe("kept-id");
  });

  it("returns null when a required field is missing", () => {
    expect(parseManifest(MANIFEST_URL, { code: "c" })).toBeNull();
    expect(parseManifest(MANIFEST_URL, { name: "P" })).toBeNull();
  });

  it("returns null for a permission outside the valid set", () => {
    expect(
      parseManifest(MANIFEST_URL, { name: "P", code: "c", permissions: ["admin:all"] }),
    ).toBeNull();
  });

  it("returns null for a non-integer version", () => {
    expect(parseManifest(MANIFEST_URL, { name: "P", code: "c", version: "2" })).toBeNull();
  });

  it("returns null for an unparseable url", () => {
    expect(parseManifest("not a url", { name: "P", code: "c" })).toBeNull();
  });
});

// --- normalizePluginUrl and iconUrl ----------------------------------------

describe("normalizePluginUrl", () => {
  it("keeps a url that already ends with manifest.json", () => {
    expect(normalizePluginUrl("https://plugins.example/dir/manifest.json")).toBe(
      "https://plugins.example/dir/manifest.json",
    );
  });

  it("appends manifest.json to a directory url", () => {
    expect(normalizePluginUrl("https://plugins.example/dir")).toBe(
      "https://plugins.example/dir/manifest.json",
    );
  });

  it("appends after a trailing slash and keeps the query", () => {
    expect(normalizePluginUrl("https://plugins.example/dir/?theme=x")).toBe(
      "https://plugins.example/dir/manifest.json?theme=x",
    );
  });
});

describe("iconUrl", () => {
  it("joins host and icon with a slash when neither side carries one", () => {
    expect(iconUrl("https://plugins.example/dir", "icon.png")).toBe(
      "https://plugins.example/dir/icon.png",
    );
  });

  it("does not double the slash", () => {
    expect(iconUrl("https://plugins.example/dir/", "icon.png")).toBe(
      "https://plugins.example/dir/icon.png",
    );
    expect(iconUrl("https://plugins.example/dir", "/icon.png")).toBe(
      "https://plugins.example/dir/icon.png",
    );
  });
});

// --- registry ---------------------------------------------------------------

describe("registry", () => {
  it("loads the entries from the profile props in id order", () => {
    seedRegistry([
      makeEntry({ "plugin-id": "a", name: "A" }),
      makeEntry({ "plugin-id": "b", name: "B" }),
    ]);
    expect(getPluginsList().map((entry) => entry.name)).toEqual(["A", "B"]);
    expect(getPlugin("b")!.name).toBe("B");
  });

  it("reads an absent or malformed plugin prop as empty", () => {
    initRegistryFromProfile(null);
    expect(getPluginsList()).toEqual([]);
    initRegistryFromProfile({ props: {} });
    expect(getPluginsList()).toEqual([]);
    initRegistryFromProfile({ props: { plugins: { ids: null, data: "nope" } } });
    expect(getPluginsList()).toEqual([]);
  });

  it("keeps the snapshot identity until the registry changes", () => {
    const before = getPluginsList();
    expect(getPluginsList()).toBe(before);
    seedRegistry([makeEntry()]);
    expect(getPluginsList()).not.toBe(before);
  });

  it("notifies subscribers on change and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRegistry(listener);

    seedRegistry([makeEntry()]);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    seedRegistry([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// --- installPlugin ----------------------------------------------------------

describe("installPlugin", () => {
  it("updates optimistically and keeps the entry on success", async () => {
    const entry = makeEntry();
    const promise = installPlugin(entry);
    // The optimistic write is synchronous (track + registry swap before the
    // RPC), like the CLJS swap! ahead of rp/cmd!.
    expect(getPluginsList().map((item) => item["plugin-id"])).toEqual(["plugin-a"]);
    await promise;

    expect(getPlugin("plugin-a")).toEqual(entry);
    expect(cmdMock).toHaveBeenCalledTimes(1);
    expect(cmdMock.mock.calls[0][0]).toBe("add-profile-plugin");
  });

  it("moves a reinstalled entry to the front of the id list", async () => {
    seedRegistry([makeEntry({ "plugin-id": "a" }), makeEntry({ "plugin-id": "b", name: "B" })]);
    await installPlugin(makeEntry({ "plugin-id": "b", name: "B updated" }));
    expect(getPluginsList().map((item) => item["plugin-id"])).toEqual(["b", "a"]);
    expect(getPlugin("b")!.name).toBe("B updated");
  });

  it("sends keyword keys and a permission set on the wire", async () => {
    await installPlugin(makeEntry());
    const params = cmdMock.mock.calls[0][1] as { plugin: unknown };
    const wire = encodeTransit(params.plugin);
    expect(wire).toContain("~:plugin-id");
    expect(wire).toContain("~:permissions");
    expect(wire).toContain("~#set");
  });

  it("tracks the plugin as in flight until the RPC settles", async () => {
    let resolveCall: ((value: unknown) => void) | undefined;
    cmdMock.mockImplementation(
      () => new Promise((resolve) => (resolveCall = resolve)),
    );

    const seen: Array<ReadonlySet<string>> = [];
    const unsubscribe = subscribeInFlight((ids) => seen.push(ids));
    expect(seen[0]!.size).toBe(0);

    const promise = installPlugin(makeEntry());
    expect(seen[seen.length - 1]!.has("plugin-a")).toBe(true);

    resolveCall!(undefined);
    await promise;
    expect(seen[seen.length - 1]!.size).toBe(0);
    unsubscribe();
  });

  it("skips a second install while one is in flight", async () => {
    cmdMock.mockImplementation(async () => undefined);
    const first = installPlugin(makeEntry());
    const second = installPlugin(makeEntry());
    await Promise.all([first, second]);
    expect(cmdMock).toHaveBeenCalledTimes(1);
  });

  it("restores a failed reinstall in place and re-saves the previous entry", async () => {
    seedRegistry([makeEntry({ "plugin-id": "a", name: "Plugin A" }), makeEntry({ "plugin-id": "b", name: "B" })]);
    cmdMock.mockRejectedValueOnce(new RpcError("boom", { type: "internal" }));

    await installPlugin(makeEntry({ "plugin-id": "a", name: "A v2" }));

    expect(getPluginsList().map((item) => item["plugin-id"])).toEqual(["a", "b"]);
    expect(getPlugin("a")!.name).toBe("Plugin A");
    expect(cmdMock).toHaveBeenCalledTimes(2);
    expect(cmdMock.mock.calls[1][0]).toBe("add-profile-plugin");
    const rollback = cmdMock.mock.calls[1][1] as { plugin: unknown };
    expect(encodeTransit(rollback.plugin)).toContain("Plugin A");
  });

  it("drops a failed new entry and removes it server-side", async () => {
    cmdMock.mockRejectedValueOnce(new RpcError("boom", { type: "network" }));

    await installPlugin(makeEntry());

    expect(getPlugin("plugin-a")).toBeUndefined();
    expect(getPluginsList()).toEqual([]);
    expect(cmdMock).toHaveBeenCalledTimes(2);
    expect(cmdMock.mock.calls[1][0]).toBe("remove-profile-plugin");
    expect(cmdMock.mock.calls[1][1]).toEqual({ "plugin-id": "plugin-a" });
  });

  it("rolls back only locally on a validation error", async () => {
    cmdMock.mockRejectedValueOnce(
      new RpcError("invalid", { type: "validation", code: "invalid-plugin-permissions" }),
    );

    await installPlugin(makeEntry());

    expect(getPlugin("plugin-a")).toBeUndefined();
    // Validation errors cannot have reached the server: no rollback call.
    expect(cmdMock).toHaveBeenCalledTimes(1);
  });
});

// --- removePlugin -----------------------------------------------------------

describe("removePlugin", () => {
  it("removes the entry on success", async () => {
    seedRegistry([makeEntry({ "plugin-id": "a" }), makeEntry({ "plugin-id": "b", name: "B" })]);
    await removePlugin(makeEntry({ "plugin-id": "a" }));

    expect(getPlugin("a")).toBeUndefined();
    expect(getPluginsList().map((item) => item["plugin-id"])).toEqual(["b"]);
    expect(cmdMock).toHaveBeenCalledTimes(1);
    expect(cmdMock.mock.calls[0][0]).toBe("remove-profile-plugin");
    expect(cmdMock.mock.calls[0][1]).toEqual({ "plugin-id": "a" });
  });

  it("restores a failed removal in place and re-saves the entry", async () => {
    seedRegistry([makeEntry({ "plugin-id": "a" }), makeEntry({ "plugin-id": "b", name: "B" })]);
    cmdMock.mockRejectedValueOnce(new RpcError("boom", { type: "network" }));

    await removePlugin(makeEntry({ "plugin-id": "a" }));

    expect(getPluginsList().map((item) => item["plugin-id"])).toEqual(["a", "b"]);
    expect(getPlugin("a")).toEqual(makeEntry({ "plugin-id": "a" }));
    expect(cmdMock).toHaveBeenCalledTimes(2);
    expect(cmdMock.mock.calls[1][0]).toBe("add-profile-plugin");
  });

  it("restores in place but does not re-save on a validation error", async () => {
    seedRegistry([makeEntry({ "plugin-id": "a" })]);
    cmdMock.mockRejectedValueOnce(new RpcError("invalid", { type: "validation" }));

    await removePlugin(makeEntry({ "plugin-id": "a" }));

    expect(getPlugin("a")).toEqual(makeEntry({ "plugin-id": "a" }));
    expect(cmdMock).toHaveBeenCalledTimes(1);
  });
});

// --- fetchManifest ----------------------------------------------------------

describe("fetchManifest", () => {
  it("fetches without custom headers and parses the answer", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(manifest), { status: 200 });
    });

    const entry = await fetchManifest(MANIFEST_URL);

    expect(calls[0]!.url).toBe(MANIFEST_URL);
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.headers).toBeUndefined();
    expect(entry).toMatchObject({ name: "My plugin", host: "https://plugins.example" });
  });

  it("rejects on an http error", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    await expect(fetchManifest(MANIFEST_URL)).rejects.toThrow();
  });

  it("rejects on an unparsable body", async () => {
    vi.stubGlobal("fetch", async () => new Response("not json", { status: 200 }));
    await expect(fetchManifest(MANIFEST_URL)).rejects.toThrow();
  });

  it("resolves to null for a manifest that fails validation", async () => {
    stubManifestFetch({ code: "plugin.js" });
    await expect(fetchManifest(MANIFEST_URL)).resolves.toBeNull();
  });

  it("aborts after 15 seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );

    const promise = fetchManifest(MANIFEST_URL);
    const assertion = expect(promise).rejects.toThrow();
    vi.advanceTimersByTime(15000);
    await assertion;
  });
});

// --- permissions peek -------------------------------------------------------

describe("permissions peek", () => {
  it("stores and reads a peek", () => {
    savePluginPermissionsPeek("some-plugin", ["content:read"]);
    expect(getPluginPermissionsPeek("some-plugin")).toEqual(["content:read"]);
    expect(getPluginPermissionsPeek("never-saved")).toBeUndefined();
  });

  it("refreshes the peek when it is older than a day", async () => {
    stubManifestFetch({ name: "P", code: "c", permissions: ["user:read"] });
    seedRegistry([
      makeEntry({
        "plugin-id": "p",
        url: MANIFEST_URL,
      }),
    ]);

    expect(shouldUpdatePermissionsPeek()).toBe(true);
    await updatePluginsPermissionsPeek();

    expect(shouldUpdatePermissionsPeek()).toBe(false);
    expect(getPluginPermissionsPeek("p")).toEqual(["user:read"]);
  });

  it("keeps the stored permissions when the refresh fails", async () => {
    // Move the clock past the peek expiry so the refresh really runs (an
    // earlier test in this file stamps the peek with the current time).
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1000);

    savePluginPermissionsPeek("q", ["clipboard:read"]);
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    seedRegistry([makeEntry({ "plugin-id": "q", url: MANIFEST_URL })]);

    await updatePluginsPermissionsPeek();

    // The refresh ran (the peek was stamped) but the old value survived.
    expect(shouldUpdatePermissionsPeek()).toBe(false);
    expect(getPluginPermissionsPeek("q")).toEqual(["clipboard:read"]);
  });
});

// --- permission checks ------------------------------------------------------

describe("checkPluginPermission", () => {
  it("always allows the zero uuid and the MCP plugin", () => {
    expect(checkPluginPermission(ZERO_UUID, "content:write")).toBe(true);
    expect(checkPluginPermission(MCP_PLUGIN_ID, "content:write")).toBe(true);
  });

  it("checks the stored permissions of a registered plugin", () => {
    seedRegistry([makeEntry({ "plugin-id": "a", permissions: ["content:read"] })]);
    expect(checkPluginPermission("a", "content:read")).toBe(true);
    expect(checkPluginPermission("a", "content:write")).toBe(false);
    expect(checkPluginPermission("unknown", "content:read")).toBe(false);
  });
});

describe("isEditionPlugin", () => {
  it("flags content and library writers", () => {
    expect(isEditionPlugin(["content:write"])).toBe(true);
    expect(isEditionPlugin(["library:write"])).toBe(true);
    expect(isEditionPlugin(["content:read", "library:read"])).toBe(false);
    expect(isEditionPlugin([])).toBe(false);
  });
});

// --- permission rows --------------------------------------------------------

// plugins-permission-list*: one row per group, in the fixed order of the
// CLJS conds, the write variant of a pair replacing the read one.
describe("permissionRows", () => {
  it("returns one row per group in the fixed CLJS order", () => {
    // The input order does not matter.
    const rows = permissionRows(["clipboard:read", "library:read", "user:read", "content:read"]);
    expect(rows.map((row) => row.labelKey)).toEqual([
      "workspace.plugins.permissions.content-read",
      "workspace.plugins.permissions.user-read",
      "workspace.plugins.permissions.library-read",
      "workspace.plugins.permissions.clipboard-read",
    ]);
  });

  it("replaces a read row with its write variant", () => {
    expect(permissionRows(["content:read", "content:write"])).toEqual([
      { labelKey: "workspace.plugins.permissions.content-write" },
    ]);
  });

  it("collapses every read/write pair", () => {
    const rows = permissionRows([
      "library:read",
      "library:write",
      "comment:read",
      "comment:write",
      "clipboard:read",
      "clipboard:write",
    ]);
    expect(rows.map((row) => row.labelKey)).toEqual([
      "workspace.plugins.permissions.library-write",
      "workspace.plugins.permissions.comment-write",
      "workspace.plugins.permissions.clipboard-write",
    ]);
  });

  it("maps the allow permissions to their own rows, in order", () => {
    const rows = permissionRows(["allow:localstorage", "allow:downloads"]);
    expect(rows.map((row) => row.labelKey)).toEqual([
      "workspace.plugins.permissions.allow-download",
      "workspace.plugins.permissions.allow-localstorage",
    ]);
  });

  it("accepts a set and ignores unknown permissions", () => {
    expect(permissionRows(new Set(["unknown", "user:read"]))).toEqual([
      { labelKey: "workspace.plugins.permissions.user-read" },
    ]);
  });

  it("returns no rows for an empty permission list", () => {
    expect(permissionRows([])).toEqual([]);
    expect(permissionRows(new Set<string>())).toEqual([]);
  });
});

// --- stored plugin url ------------------------------------------------------

// (:plugin-url storage/session): the CLJS keeps a plugin link that crossed
// the login redirect in the tab session, under the bare :plugin-url keyword
// (key "penpot:/plugin-url") with a transit-encoded value.
describe("stored plugin url", () => {
  function stubSessionStorage(): Map<string, string> {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
    return store;
  }

  it("reads the url from the CLJS session key", () => {
    const store = stubSessionStorage();
    store.set("penpot:/plugin-url", encodeTransit("https://plugins.example/p.js"));

    expect(storedPluginUrl()).toBe("https://plugins.example/p.js");
  });

  it("returns null without a stored url or a browser storage", () => {
    expect(storedPluginUrl()).toBeNull();
    stubSessionStorage();
    expect(storedPluginUrl()).toBeNull();
  });

  it("returns null for empty or non-string values", () => {
    const store = stubSessionStorage();
    store.set("penpot:/plugin-url", encodeTransit(""));
    expect(storedPluginUrl()).toBeNull();
    store.set("penpot:/plugin-url", encodeTransit(42));
    expect(storedPluginUrl()).toBeNull();
  });

  it("clears the stored url", () => {
    const store = stubSessionStorage();
    store.set("penpot:/plugin-url", encodeTransit("https://plugins.example/p.js"));

    clearStoredPluginUrl();

    expect(store.has("penpot:/plugin-url")).toBe(false);
    expect(storedPluginUrl()).toBeNull();
  });
});
