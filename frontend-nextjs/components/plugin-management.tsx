"use client";

// Plugin management dialog (F7.2, F7.3). Port of plugin-management-dialog in
// app.main.ui.workspace.plugins: the URL install box, the installed-plugin
// list with its Open and Remove actions, and the empty state.
//
// In the CLJS app this dialog opens from the workspace menus (main_menu.cljs
// and top_toolbar.cljs); the shell mounts it from the dashboard profile menu
// until the workspace arrives with F9. userCanEdit is the editor permission
// of the team the dialog is opened from; the CLJS reads it from the
// workspace permissions.
//
// Registered deviations from the CLJS:
//   - the Open button loads the plugin in the dashboard context; the
//     workspace APIs answer their F7.3 placeholders until the editor
//     arrives with F9,
//   - the permissions peek is read when the row renders, so a peek saved by
//     the open flow shows after the next render (the CLJS derefs a reactive
//     ref),
//   - the :success input status is dropped; the dialog remounts on the way
//     back from the permissions modal, so the CLJS never rendered it either,
//   - search-bar* is a pp-field-input styled input; the ds component lands
//     with @penpot/ui,
//   - ev/event telemetry is dropped; the shell has no analytics seam.

import { useEffect, useState, useSyncExternalStore } from "react";
import { ModalShell, useModal } from "@/components/modal";
import { PluginPermissionsDialog, PluginPermissionsUpdateDialog } from "@/components/plugins";
import { Tr } from "@/components/tr";
import { generateAvatar } from "@/lib/avatars";
import { config } from "@/lib/config";
import { tr } from "@/lib/i18n";
import { openPluginEntry } from "@/lib/plugin-runtime";
import {
  fetchManifest,
  getPluginPermissionsPeek,
  getPluginsList,
  iconUrl,
  installPlugin,
  isEditionPlugin,
  normalizePluginUrl,
  removePlugin,
  subscribeInFlight,
  subscribeRegistry,
  type RegistryEntry,
} from "@/lib/plugins";

type InputStatus = "error-url" | "error-manifest" | null;

const EMPTY_IN_FLIGHT: ReadonlySet<string> = new Set();

// plugin-entry*: the icon, the name, the summary and the two actions of one
// installed plugin. The Open button disables when the permissions make it an
// edition plugin and the user cannot edit; the daily peek overrides the
// stored permissions for that check.
function PluginEntry({
  plugin,
  userCanEdit,
  removeDisabled,
  onOpen,
  onRemove,
}: {
  plugin: RegistryEntry;
  userCanEdit: boolean;
  removeDisabled: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const icon =
    plugin.icon !== undefined
      ? iconUrl(plugin.host, plugin.icon)
      : generateAvatar({ name: plugin.name });
  const permissions = getPluginPermissionsPeek(plugin["plugin-id"]) ?? plugin.permissions;
  const canOpen = userCanEdit || !isEditionPlugin(permissions);

  return (
    <li className="pp-plugin-row" data-testid={"plugin-" + plugin["plugin-id"]}>
      <img className="pp-plugin-icon" src={icon} alt="" />
      <div className="pp-plugin-info">
        <div className="pp-plugin-name" title={plugin.name}>
          {plugin.name}
        </div>
        <div className="pp-plugin-summary" title={plugin.description ?? ""}>
          {plugin.description ?? ""}
        </div>
      </div>
      <button
        type="button"
        className="pp-btn-secondary"
        disabled={!canOpen}
        title={canOpen ? undefined : tr("workspace.plugins.error.need-editor")}
        data-testid={"open-plugin-" + plugin["plugin-id"]}
        onClick={onOpen}
      >
        {tr("workspace.plugins.button-open")}
      </button>
      <button
        type="button"
        className="pp-btn-secondary"
        disabled={removeDisabled}
        aria-label={tr("workspace.plugins.remove-plugin")}
        data-testid={"remove-plugin-" + plugin["plugin-id"]}
        onClick={onRemove}
      >
        {tr("workspace.plugins.remove-plugin")}
      </button>
    </li>
  );
}

// The confirm of remove-plugin: both answers land back on the management
// dialog, like the on-accept and on-cancel of the CLJS confirm.
function RemovePluginDialog({
  plugin,
  userCanEdit,
}: {
  plugin: RegistryEntry;
  userCanEdit: boolean;
}) {
  const modal = useModal();
  const reopen = () => modal.open(<PluginManagementDialog userCanEdit={userCanEdit} />);
  // Truncated so long names fit the confirm dialog (the CLJS subs at 60).
  const name =
    plugin.name.length > 60 ? plugin.name.slice(0, 60) + "\u2026" : plugin.name;

  return (
    <ModalShell
      title={tr("workspace.plugins.remove-confirmation.title")}
      closeLabel={tr("ds.confirm-cancel")}
      footer={
        <div className="pp-modal-actions">
          <button type="button" className="pp-btn-secondary" onClick={reopen}>
            {tr("ds.confirm-cancel")}
          </button>
          <button
            type="button"
            className="pp-btn-danger"
            data-testid="plugin-remove-confirm"
            onClick={() => {
              void removePlugin(plugin);
              reopen();
            }}
          >
            {tr("workspace.plugins.remove-plugin")}
          </button>
        </div>
      }
    >
      <p className="pp-modal-message">
        {tr("workspace.plugins.remove-confirmation.message", name)}
      </p>
    </ModalShell>
  );
}

// The editor permission travels from the opener (the profile menu reads the
// team) because the dialog renders inside the modal host, outside the
// dashboard providers.
export function PluginManagementDialog({ userCanEdit }: { userCanEdit: boolean }) {
  const modal = useModal();
  const plugins = useSyncExternalStore(subscribeRegistry, getPluginsList, getPluginsList);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<InputStatus>(null);
  const [fetching, setFetching] = useState(false);
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(EMPTY_IN_FLIGHT);

  // Ids with a persist in flight; their remove button is disabled. The
  // subscription calls back with the current set right away.
  useEffect(() => subscribeInFlight(setInFlight), []);

  const reopen = () => modal.open(<PluginManagementDialog userCanEdit={userCanEdit} />);

  // on-open-plugin: the runtime bridge re-fetches the manifest and runs the
  // three-branch check; the update re-confirmation is opened from here
  // because the runtime module holds no modal state.
  const onOpen = (plugin: RegistryEntry) => {
    void openPluginEntry(plugin, userCanEdit, (manifest, onAccept) => {
      modal.open(<PluginPermissionsUpdateDialog plugin={manifest} onAccept={onAccept} />);
    });
  };

  // on-install: fetch the manifest of the written URL, then ask for
  // permissions; the two failures map to the two input-status branches.
  const onInstall = async () => {
    setFetching(true);
    setStatus(null);
    try {
      const plugin = await fetchManifest(normalizePluginUrl(url));
      if (plugin !== null) {
        modal.open(
          <PluginPermissionsDialog
            plugin={plugin}
            onAccept={() => {
              void installPlugin(plugin);
              reopen();
            }}
          />,
        );
      } else {
        setStatus("error-manifest");
      }
    } catch (error) {
      console.error(error);
      setStatus("error-url");
    } finally {
      setFetching(false);
    }
  };

  return (
    <ModalShell title={tr("workspace.plugins.title")} closeLabel={tr("ds.confirm-cancel")}>
      <div className="pp-plugin-install">
        <input
          className="pp-field-input pp-plugin-url-input"
          type="text"
          value={url}
          placeholder={tr("workspace.plugins.search-placeholder")}
          data-testid="plugin-url-input"
          aria-invalid={status !== null}
          onChange={(event) => {
            setStatus(null);
            setUrl(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void onInstall();
            }
          }}
        />
        <button
          type="button"
          className="pp-btn-primary"
          disabled={fetching}
          data-testid="plugin-install-button"
          onClick={() => void onInstall()}
        >
          {tr("workspace.plugins.install")}
        </button>
      </div>

      {status === "error-url" ? (
        <p className="pp-modal-error" data-testid="plugin-url-error">
          {tr("workspace.plugins.error.url")}
        </p>
      ) : null}
      {status === "error-manifest" ? (
        <p className="pp-modal-error" data-testid="plugin-manifest-error">
          {tr("workspace.plugins.error.manifest")}
        </p>
      ) : null}

      {plugins.length > 0 ? (
        <p className="pp-plugin-discover">
          <Tr k="workspace.plugins.discover" args={[config.pluginsListUri]} />
        </p>
      ) : null}

      <hr className="pp-plugin-separator" />

      {plugins.length === 0 ? (
        <div className="pp-plugin-empty" data-testid="plugins-empty">
          <div className="pp-plugin-empty-icon" aria-hidden="true">
            {"\uD83E\uDDE9"}
          </div>
          <p className="pp-modal-message">{tr("workspace.plugins.empty-plugins")}</p>
          <a
            className="pp-plugin-list-link"
            href={config.pluginsListUri}
            target="_blank"
            rel="noreferrer"
          >
            {tr("workspace.plugins.plugin-list-link")}
          </a>
        </div>
      ) : (
        <>
          <h3 className="pp-plugin-list-title">{tr("workspace.plugins.installed-plugins")}</h3>
          <ul className="pp-plugin-list" data-testid="plugins-list">
            {plugins.map((plugin) => (
              <PluginEntry
                key={plugin["plugin-id"]}
                plugin={plugin}
                userCanEdit={userCanEdit}
                removeDisabled={inFlight.has(plugin["plugin-id"])}
                onOpen={() => onOpen(plugin)}
                onRemove={() =>
                  modal.open(<RemovePluginDialog plugin={plugin} userCanEdit={userCanEdit} />)
                }
              />
            ))}
          </ul>
        </>
      )}
    </ModalShell>
  );
}
