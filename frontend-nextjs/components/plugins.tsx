"use client";

// Plugin dialogs (F7.2, F7.3): the permissions request, the try-out prompt
// and the permissions-update re-confirmation, the modals of the dashboard
// ?plugin= install flow and of opening a plugin whose manifest changed.
// Port of plugins-permissions-dialog, plugins-try-out-dialog and
// plugins-permissions-updated-dialog in app.main.ui.workspace.plugins.
//
// Registered deviations from the CLJS:
//   - the CLJS dialogs add a document keydown listener that runs the accept
//     handler on any key press; the shell keeps the explicit buttons and the
//     ModalProvider Escape close instead,
//   - ev/event telemetry on accept and reject is dropped; the shell has no
//     analytics seam,
//   - onCancel runs only from the Cancel button; the × / Escape / backdrop
//     paths just close the dialog (see plugin-install-flow.tsx for the
//     navigation the CLJS ties to every close path).

import { ModalShell, useModal } from "@/components/modal";
import { generateAvatar } from "@/lib/avatars";
import { config } from "@/lib/config";
import { tr } from "@/lib/i18n";
import { iconUrl, permissionRows, type RegistryEntry } from "@/lib/plugins";

// The manifest icon when the plugin carries one, a generated avatar
// otherwise, like plugin-entry* and the try-out title.
function pluginIconSource(plugin: RegistryEntry): string {
  return plugin.icon !== undefined
    ? iconUrl(plugin.host, plugin.icon)
    : generateAvatar({ name: plugin.name });
}

// plugins-permission-list*: one row per permission group, shared by the
// request, the update re-confirmation and (through permissionRows) the F7.2
// tests.
function PermissionList({ permissions, testId }: { permissions: readonly string[]; testId: string }) {
  const rows = permissionRows(permissions);
  return (
    <ul className="pp-plugin-permissions" data-testid={testId}>
      {rows.map((row) => (
        <li key={row.labelKey} className="pp-plugin-permission">
          <span className="pp-plugin-permission-mark" aria-hidden="true">
            {"\u2713"}
          </span>
          {tr(row.labelKey)}
        </li>
      ))}
    </ul>
  );
}

export interface PluginPermissionsDialogProps {
  plugin: RegistryEntry;
  onAccept: () => void;
  onCancel?: () => void;
}

// plugins-permissions-dialog (::mf/register-as :plugin-permissions).
export function PluginPermissionsDialog({
  plugin,
  onAccept,
  onCancel,
}: PluginPermissionsDialogProps) {
  const { close } = useModal();
  // The disclaimer hides for whitelisted hosts (when-not cfg/plugins-whitelist).
  const showDisclaimer = !config.pluginsWhitelist.includes(plugin.host);

  return (
    <ModalShell
      title={tr("workspace.plugins.permissions.title", plugin.name.toUpperCase())}
      closeLabel={tr("ds.confirm-cancel")}
      footer={
        <div className="pp-modal-actions">
          <button
            type="button"
            className="pp-btn-secondary"
            data-testid="plugin-permissions-cancel"
            onClick={() => {
              close();
              if (onCancel !== undefined) onCancel();
            }}
          >
            {tr("ds.confirm-cancel")}
          </button>
          <button
            type="button"
            className="pp-btn-primary"
            data-testid="plugin-permissions-allow"
            onClick={() => {
              close();
              onAccept();
            }}
          >
            {tr("ds.confirm-allow")}
          </button>
        </div>
      }
    >
      <PermissionList permissions={plugin.permissions} testId="plugin-permissions-list" />
      {showDisclaimer ? (
        <p className="pp-modal-hint">{tr("workspace.plugins.permissions.disclaimer")}</p>
      ) : null}
    </ModalShell>
  );
}

export interface PluginTryOutDialogProps {
  plugin: RegistryEntry;
  onAccept: () => void;
}

// plugins-try-out-dialog (::mf/register-as :plugin-try-out). The CLJS renders
// the icon inside the title row; the shell keeps it as the first content
// block because ModalShell takes a plain title.
export function PluginTryOutDialog({ plugin, onAccept }: PluginTryOutDialogProps) {
  const { close } = useModal();

  return (
    <ModalShell
      title={tr("workspace.plugins.try-out.title", plugin.name.toUpperCase())}
      closeLabel={tr("workspace.plugins.try-out.cancel")}
      footer={
        <div className="pp-modal-actions">
          <button
            type="button"
            className="pp-btn-secondary"
            data-testid="plugin-try-out-cancel"
            onClick={close}
          >
            {tr("workspace.plugins.try-out.cancel")}
          </button>
          <button
            type="button"
            className="pp-btn-primary"
            data-testid="plugin-try-out-accept"
            onClick={() => {
              close();
              onAccept();
            }}
          >
            {tr("workspace.plugins.try-out.try")}
          </button>
        </div>
      }
    >
      <div className="pp-plugin-try-out-icon">
        <img className="pp-plugin-icon" src={pluginIconSource(plugin)} alt="" />
      </div>
      <p className="pp-modal-message">{tr("workspace.plugins.try-out.message")}</p>
    </ModalShell>
  );
}

export interface PluginPermissionsUpdateDialogProps {
  plugin: RegistryEntry;
  onAccept: () => void;
}

// plugins-permissions-updated-dialog (::mf/register-as
// :plugin-permissions-update): the re-confirmation open-plugin! shows when
// the fetched manifest no longer matches the stored one. The CLJS also
// passes an on-close; the shell closes without a callback, like the other
// dialogs here.
export function PluginPermissionsUpdateDialog({
  plugin,
  onAccept,
}: PluginPermissionsUpdateDialogProps) {
  const { close } = useModal();

  return (
    <ModalShell
      title={tr("workspace.plugins.permissions-update.title", plugin.name.toUpperCase())}
      closeLabel={tr("ds.confirm-cancel")}
      footer={
        <div className="pp-modal-actions">
          <button
            type="button"
            className="pp-btn-secondary"
            data-testid="plugin-permissions-update-cancel"
            onClick={close}
          >
            {tr("ds.confirm-cancel")}
          </button>
          <button
            type="button"
            className="pp-btn-primary"
            data-testid="plugin-permissions-update-allow"
            onClick={() => {
              close();
              onAccept();
            }}
          >
            {tr("ds.confirm-allow")}
          </button>
        </div>
      }
    >
      <p className="pp-modal-hint">{tr("workspace.plugins.permissions-update.warning")}</p>
      <PermissionList permissions={plugin.permissions} testId="plugin-permissions-update-list" />
    </ModalShell>
  );
}
