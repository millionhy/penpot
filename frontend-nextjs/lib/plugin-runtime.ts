// Plugin runtime bridge (F7.3). Port of app.plugins/initialize +
// init-plugins-runtime and the load/open/close half of
// app.main.data.plugins, without the workspace pieces: the boot component
// calls startPluginRuntime once the shell mounts, plugins load through
// loadPluginEntry, and openPluginEntry re-fetches the manifest and runs the
// three-branch check before loading.
//
// The runtime package is imported dynamically: its entry runs
// repairIntrinsics (SES) and touches window at module scope, so it can only
// exist in the browser and after hydration. The repair deletes the transit
// guid caches and resetTransitGuids rebuilds them (see the SES section in
// lib/transit).
//
// Registered deviations from the CLJS:
//   - start-plugin! (the MCP workspace plugin with api extensions) and the
//     delay-open-plugin / check-open-plugin pair wait for the workspace
//     (F9),
//   - a fetched manifest that fails validation counts as unreachable; the
//     CLJS would reach the update dialog with the partial manifest,
//   - the open-plugins set lives in module state until the workspace local
//     state arrives with F9,
//   - ev/event telemetry is dropped; the shell has no analytics seam.

import { tr } from "@/lib/i18n";
import { initPluginFlags } from "@/lib/plugin-flags";
import { createPluginContext, startPluginWorkspaceEvents } from "@/lib/plugin-context";
import {
  fetchManifest,
  getPlugin,
  getPluginPermissionsPeek,
  installPlugin,
  isEditionPlugin,
  savePluginPermissionsPeek,
  type RegistryEntry,
} from "@/lib/plugins";
import { resetTransitGuids } from "@/lib/transit";

// --- Runtime status -------------------------------------------------------

let started = false;
let resolveReady: (() => void) | null = null;
const readyPromise = new Promise<void>((resolve) => {
  resolveReady = resolve;
});

// register.cljs wait-for-runtime: resolves once the runtime is initialized;
// the MCP plugin waits on it before loading (F9).
export function waitForRuntime(): Promise<void> {
  return readyPromise;
}

// app.plugins/init-plugins-runtime: hand the context builder to the package
// and signal readiness. The package catches its own init failures, so the
// signal follows a dynamic-import failure only.
export async function startPluginRuntime(): Promise<void> {
  if (started) return;
  started = true;
  // The finite events read a snapshot of the workspace store; take the
  // baseline before any plugin can register a listener.
  startPluginWorkspaceEvents();
  try {
    const runtime = await import("@penpot/plugins-runtime");
    runtime.initPluginsRuntime((pluginId) => createPluginContext(pluginId));
  } catch (cause) {
    console.error(cause);
  } finally {
    // The SES repair inside the import deleted the transit guid caches;
    // rebuild them before the first plugin open freezes the intrinsics.
    resetTransitGuids();
    if (resolveReady !== null) resolveReady();
    resolveReady = null;
  }
}

// --- Notifications --------------------------------------------------------

// The runtime module has no React context; the boot component forwards the
// notification system here so the open/load failures can surface as toasts.
export interface PluginRuntimeNotifier {
  warn(message: string): void;
  error(message: string): void;
}

let notifier: PluginRuntimeNotifier | null = null;

export function setPluginRuntimeNotifier(next: PluginRuntimeNotifier | null): void {
  notifier = next;
}

function pluginErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// --- Runtime globals ------------------------------------------------------

// The package installs ɵloadPlugin / ɵloadPluginByUrl / ɵunloadPlugin on
// globalThis; data/plugins.cljs reads them the same way.
type RuntimeFunction = (...args: unknown[]) => unknown;

function runtimeFunction(name: string): RuntimeFunction | null {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === "function" ? (value as RuntimeFunction) : null;
}

// --- Open plugins ---------------------------------------------------------

// [:workspace-local :open-plugins] until the workspace arrives with F9.
const openPlugins = new Set<string>();

export function getOpenPlugins(): string[] {
  return [...openPlugins];
}

// --- Loading --------------------------------------------------------------

// The camelCase manifest the runtime model expects. allowBackground is not
// sent: the CLJS only sets it for the MCP workspace plugin (start-plugin!).
interface RuntimeManifest {
  pluginId: string;
  name: string;
  version?: number;
  description?: string;
  host: string;
  code: string;
  icon?: string;
  permissions: string[];
}

function runtimeManifest(entry: RegistryEntry): RuntimeManifest {
  return {
    pluginId: entry["plugin-id"],
    name: entry.name,
    description: entry.description,
    version: entry.version,
    host: entry.host,
    code: entry.code,
    icon: entry.icon,
    permissions: [...entry.permissions],
  };
}

// data/plugins.cljs load-plugin!: initialize the flags, mark the plugin open
// and load it. A runtime that is not initialized logs a hint and unmarks the
// plugin; a failed load unmarks it, prints the cause and flashes the error.
export async function loadPluginEntry(entry: RegistryEntry): Promise<void> {
  const pluginId = entry["plugin-id"];
  initPluginFlags(pluginId, entry.version ?? 1);
  openPlugins.add(pluginId);

  const loadPlugin = runtimeFunction("ɵloadPlugin");
  if (loadPlugin === null) {
    console.warn("Plugin runtime not initialized yet", pluginId);
    openPlugins.delete(pluginId);
    return;
  }

  try {
    await loadPlugin(runtimeManifest(entry), () => {
      openPlugins.delete(pluginId);
    });
  } catch (cause) {
    openPlugins.delete(pluginId);
    console.error("Plugin Error", cause);
    notifier?.error(pluginErrorMessage(cause));
  }
}

// --- Closing --------------------------------------------------------------

// data/plugins.cljs close-plugin!.
export function closePluginEntry(pluginId: string): void {
  const unloadPlugin = runtimeFunction("ɵunloadPlugin");
  if (unloadPlugin === null) {
    console.warn("Plugin runtime not initialized yet", pluginId);
    return;
  }
  try {
    unloadPlugin(pluginId);
  } catch (cause) {
    console.error("Error", cause);
  }
}

// data/plugins.cljs close-current-plugin: the permissions peek overrides the
// stored ones, and editionOnly keeps the non-edition plugins loaded.
export function closeCurrentPlugins(options: { editionOnly?: boolean } = {}): void {
  for (const pluginId of [...openPlugins]) {
    const plugin = getPlugin(pluginId);
    if (plugin === undefined) continue;
    const permissions = getPluginPermissionsPeek(pluginId) ?? plugin.permissions;
    if (options.editionOnly !== true || isEditionPlugin(permissions)) {
      closePluginEntry(pluginId);
    }
  }
}

// --- Opening --------------------------------------------------------------

// The manifest comparison behind the re-confirmation: permissions compare as
// the CLJS sets they are, the other fields by value.
function sameEntry(a: RegistryEntry, b: RegistryEntry): boolean {
  if (a["plugin-id"] !== b["plugin-id"]) return false;
  if (a.url !== b.url || a.version !== b.version || a.name !== b.name) return false;
  if (a.description !== b.description || a.host !== b.host) return false;
  if (a.code !== b.code || a.icon !== b.icon) return false;
  if (a.permissions.length !== b.permissions.length) return false;
  return b.permissions.every((permission) => a.permissions.includes(permission));
}

// The re-confirmation dialog openPluginEntry asks the caller to show; the
// shell keeps modal state in React, so the opener lives at the call site.
export interface PluginOpenConfirm {
  (plugin: RegistryEntry, onAccept: () => void): void;
}

// data/plugins.cljs open-plugin!: a stored URL is re-fetched so updates and
// tampered manifests get caught; a bundled plugin loads directly. The
// fetched permissions go to the peek before any branch, like the CLJS.
export async function openPluginEntry(
  entry: RegistryEntry,
  userCanEdit: boolean,
  confirm: PluginOpenConfirm,
): Promise<void> {
  if (entry.url === undefined) {
    await loadPluginEntry(entry);
    return;
  }

  let fetched: RegistryEntry | null;
  try {
    fetched = await fetchManifest(entry.url);
  } catch {
    notifier?.warn(tr("workspace.plugins.error.unreachable"));
    return;
  }
  if (fetched === null) {
    // A manifest that fails validation cannot be verified against the stored
    // one; the CLJS would run the update dialog on the partial manifest.
    notifier?.warn(tr("workspace.plugins.error.unreachable"));
    return;
  }

  const manifest: RegistryEntry = { ...fetched, "plugin-id": entry["plugin-id"] };
  savePluginPermissionsPeek(entry["plugin-id"], manifest.permissions);

  if (isEditionPlugin(manifest.permissions) && !userCanEdit) {
    notifier?.warn(tr("workspace.plugins.error.need-editor"));
    return;
  }

  if (!sameEntry(manifest, entry)) {
    // Permissions or manifest changed: re-confirm, then install and load.
    confirm(manifest, () => {
      void installPlugin(manifest);
      void loadPluginEntry(manifest);
    });
    return;
  }

  await loadPluginEntry(entry);
}
