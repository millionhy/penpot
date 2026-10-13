// Plugin registry and manifest data layer. Faithful port of
// frontend/src/app/plugins/register.cljs (registry, manifest parsing,
// install/remove with optimistic updates and rollback) plus the manifest and
// permissions parts of frontend/src/app/main/data/plugins.cljs
// (fetch-manifest, permissions peek).
//
// The CLJS app keeps the registry in a global atom mirrored from
// [:profile :props :plugins] and the permissions peek in the app-db. The shell
// has no global store, so both live here as module state: the page that loads
// the profile seeds the registry with initRegistryFromProfile, and every
// change goes through the plugin profile RPC commands. The registry is the
// shell source of truth; nothing writes the profile object back.
//
// Registered deviations from the CLJS:
//   - a manifest URL the browser cannot parse (relative or malformed) yields a
//     null entry; the CLJS u/uri produces a partial uri with an empty host,
//   - getPluginsList skips ids whose entry is missing (the CLJS mapv keeps the
//     nil), so consumers never see an undefined entry,
//   - the v1 host keeps a query/fragment like the CLJS str, but a default port
//     (https://host:443/...) is normalized away by URL.origin.

import { cmd } from "./rpc";
import { RpcError } from "./errors";
import { sessionStorage } from "./storage";
import { keywordMap, set as transitSet } from "./transit";

// --- Types ----------------------------------------------------------------

// One installed plugin: schema:registry-entry in
// common/src/app/common/types/plugins.cljc. The CLJS registry keeps
// :permissions as a set; the shell keeps a deduplicated array.
export interface RegistryEntry {
  "plugin-id": string;
  url?: string;
  version?: number;
  name: string;
  description?: string;
  host: string;
  code: string;
  icon?: string;
  permissions: string[];
}

// schema:plugin-registry: an ordered id list plus the entry map.
export interface PluginRegistry {
  ids: string[];
  data: Record<string, RegistryEntry>;
}

// --- Constants ------------------------------------------------------------

// ctp/valid-permissions.
const validPermissions: ReadonlySet<string> = new Set([
  "content:read",
  "content:write",
  "library:read",
  "library:write",
  "comment:read",
  "comment:write",
  "clipboard:read",
  "clipboard:write",
  "user:read",
  "allow:downloads",
  "allow:localstorage",
]);

// A write permission implies the matching read permission (parse-manifest).
const impliedPermissions: Record<string, string> = {
  "content:write": "content:read",
  "library:write": "library:read",
  "comment:write": "comment:read",
  "clipboard:write": "clipboard:read",
};

// ctp/registry-entry-max-lengths: :code and :icon hold manifest paths, not
// content.
const registryEntryMaxLengths: Record<string, number> = {
  name: 500,
  description: 4096,
  host: 500,
  code: 500,
  icon: 500,
};

// ctp/max-plugins; the backend enforces it too (too-many-plugins).
export const MAX_PLUGINS = 50;

// The bundled MCP plugin id. register.cljs keeps the constant here to avoid a
// circular dependency with app.main.data.workspace.mcp.
export const MCP_PLUGIN_ID = "96dfa740-005d-8020-8007-55ede24a2bae";

// check-permission always allows this id (the workspace's own plugin).
export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// --- Manifest parsing -----------------------------------------------------

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

// sm/validate against schema:registry-entry: required strings within their
// limits, an optional integer version, and every permission in the valid set.
// Returns the failing keys (empty when valid).
function registryEntryProblems(entry: Record<string, unknown>): string[] {
  const problems: string[] = [];

  if (typeof entry["plugin-id"] !== "string") problems.push("plugin-id");

  const version = entry["version"];
  if (version !== undefined && !Number.isInteger(version)) problems.push("version");

  if (!isBoundedString(entry["name"], registryEntryMaxLengths.name)) problems.push("name");
  if (!isBoundedString(entry["host"], registryEntryMaxLengths.host)) problems.push("host");
  if (!isBoundedString(entry["code"], registryEntryMaxLengths.code)) problems.push("code");
  if (
    entry["description"] !== undefined &&
    !isBoundedString(entry["description"], registryEntryMaxLengths.description)
  ) {
    problems.push("description");
  }
  if (entry["icon"] !== undefined && !isBoundedString(entry["icon"], registryEntryMaxLengths.icon)) {
    problems.push("icon");
  }

  const permissions = entry["permissions"];
  if (!Array.isArray(permissions) || permissions.some((permission) => !validPermissions.has(permission as string))) {
    problems.push("permissions");
  }

  return problems;
}

// d/without-nils.
function withoutNils<T extends Record<string, unknown>>(entries: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(entries)) {
    const value = entries[key];
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

function randomUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = (Math.random() * 16) | 0;
    return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

// parse-manifest: read the manifest.json of a plugin and transform it into the
// entry stored in the register. The host is derived from the manifest URL: v1
// plugins key on the bare origin, v2 on the containing directory. A plugin
// already registered with the same name and host keeps its plugin-id, so a
// reinstalled manifest updates the entry instead of duplicating it.
//
// Returns null (and logs the failing keys) when the manifest does not satisfy
// schema:registry-entry, which is how the CLJS (sm/validate + .error) rejects
// untrusted manifests.
export function parseManifest(pluginUrl: string, manifest: unknown): RegistryEntry | null {
  const source = (manifest ?? {}) as Record<string, unknown>;
  const name = source["name"];
  const description = source["description"];
  const code = source["code"];
  const icon = source["icon"];
  const version = source["version"] ?? 1;

  const rawPermissions = Array.isArray(source["permissions"]) ? source["permissions"] : [];
  const permissions = new Set<string>(rawPermissions.map((permission) => String(permission)));
  for (const [write, read] of Object.entries(impliedPermissions)) {
    if (permissions.has(write)) permissions.add(read);
  }

  let url: URL;
  try {
    url = new URL(pluginUrl);
  } catch {
    // u/uri parses anything (a relative url yields an empty host); the shell
    // requires an absolute URL, which the fetch that produced the manifest
    // already needed.
    console.error("Invalid plugin manifest: unparseable url", pluginUrl);
    return null;
  }

  // v1: (assoc (u/uri url) :path "") + str — scheme and authority, keeping a
  // query/fragment the URL carries. v2: (u/join url ".") — the directory,
  // with its trailing slash (new URL(".", url) is the same RFC 3986 merge).
  const host = version === 1 ? url.origin + url.search + url.hash : new URL(".", url).href;

  const previous = Object.values(registry.data).find(
    (plugin) => plugin.name === name && plugin.host === host,
  );
  const pluginId = previous?.["plugin-id"] ?? randomUuid();

  const candidate = withoutNils({
    "plugin-id": pluginId,
    url: url.href,
    version,
    name,
    description,
    host,
    code,
    icon,
    permissions: [...permissions],
  });

  const problems = registryEntryProblems(candidate);
  if (problems.length > 0) {
    console.error("Invalid plugin manifest:", problems);
    return null;
  }
  return candidate as unknown as RegistryEntry;
}

// --- Registry -------------------------------------------------------------

let registry: PluginRegistry = { ids: [], data: {} };
let pluginsSnapshot: RegistryEntry[] = [];
const registryListeners = new Set<() => void>();

// add-watch on the registry atom: only a new value notifies (reset! with the
// same value is a no-op there, and publishRegistry mirrors that).
function publishRegistry(next: PluginRegistry): void {
  if (next === registry) return;
  registry = next;
  pluginsSnapshot = registry.ids
    .map((id) => registry.data[id])
    .filter((entry): entry is RegistryEntry => entry !== undefined);
  for (const listener of registryListeners) listener();
}

export function getRegistry(): PluginRegistry {
  return registry;
}

// plugins-list: the entries in id order. The returned snapshot keeps its
// identity until the registry changes, so it is safe for
// useSyncExternalStore(subscribeRegistry, getPluginsList).
export function getPluginsList(): RegistryEntry[] {
  return pluginsSnapshot;
}

export function getPlugin(pluginId: string): RegistryEntry | undefined {
  return registry.data[pluginId];
}

// get-plugin-data reads the same stored entry from the profile state; the
// shell registry is that store, so both names share the lookup.
export function getPluginData(pluginId: string): RegistryEntry | undefined {
  return getPlugin(pluginId);
}

// subscribe-registry!/unsubscribe-registry! as one function: calls f with no
// arguments on every registry change and returns the unsubscribe. The CLJS
// pair takes f on both sides; returning the disposer matches the React
// subscription contract.
export function subscribeRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

// load-from-store: (reset! registry (get-in @state [:profile :props :plugins] {})).
// The profile arrives transit-decoded, so the keyword keys are strings.
export function initRegistryFromProfile(
  profile: { props?: Record<string, unknown> | null } | null | undefined,
): void {
  const plugins = profile?.props?.["plugins"];
  const record = (plugins ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(record["ids"]) ? record["ids"].map(String) : [];
  const rawData = record["data"];
  const data =
    rawData !== null && typeof rawData === "object" && !Array.isArray(rawData)
      ? (rawData as Record<string, RegistryEntry>)
      : {};
  publishRegistry({ ids, data });
}

// --- In-flight tracking ---------------------------------------------------
// Plugin ids with a persist in flight; install/remove calls on them are
// skipped. subscribe-in-flight! calls f immediately with the current set.

let inFlight: ReadonlySet<string> = new Set();
const inFlightListeners = new Set<(ids: ReadonlySet<string>) => void>();

function notifyInFlight(): void {
  for (const listener of inFlightListeners) listener(inFlight);
}

export function subscribeInFlight(listener: (ids: ReadonlySet<string>) => void): () => void {
  inFlightListeners.add(listener);
  listener(inFlight);
  return () => {
    inFlightListeners.delete(listener);
  };
}

function track(pluginId: string): void {
  inFlight = new Set(inFlight).add(pluginId);
  notifyInFlight();
}

function release(pluginId: string): void {
  const next = new Set(inFlight);
  next.delete(pluginId);
  inFlight = next;
  notifyInFlight();
}

// --- Install and remove ---------------------------------------------------

// validation-error?: (= :validation (:type (ex-data err))).
function isValidationError(err: unknown): boolean {
  return err instanceof RpcError && err.type === "validation";
}

function dropLocal(plugin: RegistryEntry): void {
  const pluginId = plugin["plugin-id"];
  const data = { ...registry.data };
  delete data[pluginId];
  publishRegistry({
    ids: registry.ids.filter((id) => id !== pluginId),
    data,
  });
}

function insertAt(ids: readonly string[], index: number, id: string): string[] {
  const values = [...ids];
  const at = Math.max(0, Math.min(index, values.length));
  return [...values.slice(0, at), id, ...values.slice(at)];
}

// restore-local!: put the stored plugin back into the registry at its
// previous position.
function restoreLocal(plugin: RegistryEntry, index: number): void {
  const pluginId = plugin["plugin-id"];
  publishRegistry({
    ids: insertAt(
      registry.ids.filter((id) => id !== pluginId),
      index,
      pluginId,
    ),
    data: { ...registry.data, [pluginId]: plugin },
  });
}

// The plugin map on the wire: keyword keys and a transit set for the
// permissions, the two shapes the backend schema:registry-entry expects.
function pluginWireEntry(plugin: RegistryEntry): unknown {
  return keywordMap({
    "plugin-id": plugin["plugin-id"],
    url: plugin.url,
    version: plugin.version,
    name: plugin.name,
    description: plugin.description,
    host: plugin.host,
    code: plugin.code,
    icon: plugin.icon,
    permissions: transitSet(plugin.permissions),
  });
}

// install-plugin!: optimistic update (the new entry goes to the front of the
// id list, matching the CLJS conj over a seq) followed by
// add-profile-plugin. On failure the previous entry returns to its old
// position — or the new one is dropped — and any failure that may have
// reached the server is undone once by re-saving the previous version or
// removing the new entry, without further rollback. Validation errors only
// roll back locally.
export async function installPlugin(plugin: RegistryEntry): Promise<void> {
  const pluginId = plugin["plugin-id"];
  if (inFlight.has(pluginId)) return;

  const previous = getPlugin(pluginId);
  const previousIndex = registry.ids.indexOf(pluginId);
  track(pluginId);

  publishRegistry({
    ids: [pluginId, ...registry.ids.filter((id) => id !== pluginId)],
    data: { ...registry.data, [pluginId]: plugin },
  });

  try {
    await cmd("add-profile-plugin", { plugin: pluginWireEntry(plugin) });
    release(pluginId);
  } catch (err) {
    release(pluginId);
    if (previous !== undefined) restoreLocal(previous, previousIndex);
    else dropLocal(plugin);
    console.error("Failed to install plugin:", err);
    if (!isValidationError(err)) {
      try {
        if (previous !== undefined) {
          await cmd("add-profile-plugin", { plugin: pluginWireEntry(previous) });
        } else {
          await cmd("remove-profile-plugin", { "plugin-id": pluginId });
        }
      } catch (err2) {
        console.error("Rollback failed:", err2);
      }
    }
  }
}

// remove-plugin!: optimistic removal followed by remove-profile-plugin. The
// stored entry is restored in place on failure; non-validation failures may
// have reached the server, so the entry is re-saved once.
export async function removePlugin(plugin: RegistryEntry): Promise<void> {
  const pluginId = plugin["plugin-id"];
  if (inFlight.has(pluginId)) return;

  const stored = getPlugin(pluginId);
  const previousIndex = registry.ids.indexOf(pluginId);
  track(pluginId);

  const data = { ...registry.data };
  delete data[pluginId];
  publishRegistry({
    ids: registry.ids.filter((id) => id !== pluginId),
    data,
  });

  try {
    await cmd("remove-profile-plugin", { "plugin-id": pluginId });
    release(pluginId);
  } catch (err) {
    release(pluginId);
    if (stored !== undefined) {
      restoreLocal(stored, previousIndex);
      if (!isValidationError(err)) {
        try {
          await cmd("add-profile-plugin", { plugin: pluginWireEntry(stored) });
        } catch (err2) {
          console.error("Rollback install failed:", err2);
        }
      }
    }
    console.error("Failed to remove plugin:", err);
  }
}

// --- Manifest fetch -------------------------------------------------------

const MANIFEST_TIMEOUT_MS = 15000;

// fetch-manifest: GET the plugin URL with no custom headers (http/send! with
// omit-default-headers, so a cross-origin manifest stays a simple request)
// and parse the JSON body. A network failure, an HTTP error or a 15 s timeout
// rejects; a manifest that fails validation resolves to null, the same split
// the CLJS makes between the error channel and the nil answer.
export async function fetchManifest(pluginUrl: string): Promise<RegistryEntry | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  let body: unknown;
  try {
    const res = await fetch(pluginUrl, {
      method: "GET",
      mode: "cors",
      credentials: "same-origin",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new RpcError("manifest http error", {
        type: "internal",
        code: "unexpected-status",
        status: res.status,
        uri: pluginUrl,
      });
    }
    body = await res.json();
  } finally {
    clearTimeout(timer);
  }
  return parseManifest(pluginUrl, body);
}

// normalize-plugin-url (main/ui/workspace/plugins.cljs): append manifest.json
// when the uri does not end with it. The suffix check runs against the whole
// string, like the CLJS; a query string therefore falls through it too.
export function normalizePluginUrl(pluginUrl: string): string {
  if (pluginUrl.endsWith("manifest.json")) return pluginUrl;
  let url: URL;
  try {
    url = new URL(pluginUrl);
  } catch {
    // u/uri parses anything; an unparseable URL is left untouched (fetching
    // it will fail anyway).
    return pluginUrl;
  }
  url.pathname = url.pathname.endsWith("/")
    ? url.pathname + "manifest.json"
    : url.pathname + "/manifest.json";
  return url.href;
}

// icon-url (main/ui/workspace/plugins.cljs): join the host and the icon path,
// adding a slash unless one side already carries it.
export function iconUrl(host: string, icon: string): string {
  const separator = !host.endsWith("/") && !icon.startsWith("/") ? "/" : "";
  return host + separator + icon;
}

// --- Permissions peek -----------------------------------------------------
// The plugin list shows the permissions of the current manifest; they are
// refetched at most once a day. The CLJS keeps [:plugins-permissions-peek] in
// app-db; the shell keeps the same map in module state.

const PEEK_EXPIRY_MS = 24 * 60 * 60 * 1000;

let permissionsPeek: { updatedAt: number; data: Record<string, string[]> } = {
  updatedAt: 0,
  data: {},
};

// save-plugin-permissions-peek.
export function savePluginPermissionsPeek(pluginId: string, permissions: string[]): void {
  permissionsPeek = {
    ...permissionsPeek,
    data: { ...permissionsPeek.data, [pluginId]: permissions },
  };
}

export function getPluginPermissionsPeek(pluginId: string): string[] | undefined {
  return permissionsPeek.data[pluginId];
}

// (ct/in-past {:days 1}) > updated-at. Exported with the now parameter so
// callers and tests can evaluate the expiry without touching the clock.
export function shouldUpdatePermissionsPeek(now: number = Date.now()): boolean {
  return now - PEEK_EXPIRY_MS > permissionsPeek.updatedAt;
}

async function updatePluginPermissionsPeek(plugin: RegistryEntry): Promise<void> {
  if (plugin.url === undefined) return;
  try {
    const manifest = await fetchManifest(plugin.url);
    if (manifest !== null) {
      savePluginPermissionsPeek(plugin["plugin-id"], manifest.permissions);
    }
  } catch {
    // On error do nothing (the stored permissions stay as they are).
  }
}

// update-plugins-permissions-peek: when the peek is older than a day, refetch
// the manifest of every plugin that has a url and stamp the refresh. Resolves
// once the refreshes settle; the CLJS fires them without waiting.
export function updatePluginsPermissionsPeek(): Promise<void> {
  const now = Date.now();
  if (!shouldUpdatePermissionsPeek(now)) return Promise.resolve();
  const refreshes = getPluginsList().map((plugin) => updatePluginPermissionsPeek(plugin));
  permissionsPeek = { ...permissionsPeek, updatedAt: now };
  return Promise.allSettled(refreshes).then(() => undefined);
}

// --- Permission checks ----------------------------------------------------

// is-edition-plugin?: a plugin that writes content or library data.
export function isEditionPlugin(permissions: readonly string[]): boolean {
  return permissions.includes("content:write") || permissions.includes("library:write");
}

// check-permission: the zero uuid and the bundled MCP plugin always pass.
export function checkPluginPermission(pluginId: string, permission: string): boolean {
  if (pluginId === ZERO_UUID || pluginId === MCP_PLUGIN_ID) return true;
  const plugin = getPlugin(pluginId);
  return plugin !== undefined && plugin.permissions.includes(permission);
}

// --- Permission rows -------------------------------------------------------

// One row of the permissions dialog. The labelKey field is the only shape the
// translation extractor scans for data-driven labels; render these through
// tr(row.labelKey).
export interface PermissionRow {
  labelKey: string;
}

// plugins-permission-list*: one row per permission group in the fixed order
// of the CLJS conds, the write variant replacing the read one.
export function permissionRows(permissions: Iterable<string>): PermissionRow[] {
  const set = permissions instanceof Set ? permissions : new Set(permissions);
  const rows: PermissionRow[] = [];
  if (set.has("content:write")) {
    rows.push({ labelKey: "workspace.plugins.permissions.content-write" });
  } else if (set.has("content:read")) {
    rows.push({ labelKey: "workspace.plugins.permissions.content-read" });
  }
  if (set.has("user:read")) {
    rows.push({ labelKey: "workspace.plugins.permissions.user-read" });
  }
  if (set.has("library:write")) {
    rows.push({ labelKey: "workspace.plugins.permissions.library-write" });
  } else if (set.has("library:read")) {
    rows.push({ labelKey: "workspace.plugins.permissions.library-read" });
  }
  if (set.has("comment:write")) {
    rows.push({ labelKey: "workspace.plugins.permissions.comment-write" });
  } else if (set.has("comment:read")) {
    rows.push({ labelKey: "workspace.plugins.permissions.comment-read" });
  }
  if (set.has("allow:downloads")) {
    rows.push({ labelKey: "workspace.plugins.permissions.allow-download" });
  }
  if (set.has("allow:localstorage")) {
    rows.push({ labelKey: "workspace.plugins.permissions.allow-localstorage" });
  }
  if (set.has("clipboard:write")) {
    rows.push({ labelKey: "workspace.plugins.permissions.clipboard-write" });
  } else if (set.has("clipboard:read")) {
    rows.push({ labelKey: "workspace.plugins.permissions.clipboard-read" });
  }
  return rows;
}

// --- Stored plugin url -----------------------------------------------------

// (:plugin-url storage/session): a plugin link that arrives before the login
// redirect is kept in the tab session under the bare key :plugin-url and
// consumed by the dashboard install flow. app.util.storage encodes a keyword
// without a namespace as "<prefix>:/<name>", hence the empty namespace.
export function storedPluginUrl(): string | null {
  const value = sessionStorage.get<unknown>("", "plugin-url");
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function clearStoredPluginUrl(): void {
  sessionStorage.remove("", "plugin-url");
}
