"use client";

// Restore shortcuts modal (F5.6). Port of
// app.main.ui.settings.restore-shortcuts-modal: every customized binding of
// the three contexts with its current and default commands, and a restore
// button that clears the whole custom-shortcuts map.
//
// Deviations from the CLJS original, documented:
// - The keycaps come from the shared ShortcutKeys component over the raw
//   commands (a blank current command draws "-", like the CLJS guard); the
//   CLJS re-implements the loop inline.
// - The default column keeps the default-command key class and never draws
//   "-" (a missing default renders no tokens, like the CLJS).

import { ModalShell, useModal } from "@/components/modal";
import { ShortcutKeys } from "@/components/shortcut-keys";
import { tr } from "@/lib/i18n";
import { type CustomShortcuts } from "@/lib/shortcuts";
import {
  extractShortcutParts,
  shortcutContexts,
  shortcutLabelKey,
  type ShortcutDefaults,
} from "@/lib/shortcuts-page";

// str/blank? over a current command: null and whitespace-only strings are
// blank; a vector command never is (the CLJS string form of a vector is not
// blank).
function isBlankCommand(command: string | string[] | null): boolean {
  if (command === null) return true;
  if (Array.isArray(command)) return false;
  return command.trim() === "";
}

export interface RestoreShortcutsModalProps {
  customShortcuts: CustomShortcuts;
  defaults: ShortcutDefaults;
  macos: boolean;
  onRestore: () => void;
}

export function RestoreShortcutsModal({
  customShortcuts,
  defaults,
  macos,
  onRestore,
}: RestoreShortcutsModalProps) {
  const { close } = useModal();

  const rows: Array<{ context: string; key: string; current: string | string[] | null; customized: boolean; defaultCommand: string | string[] | null }> = [];
  for (const context of shortcutContexts) {
    for (const key of Object.keys(customShortcuts[context] ?? {})) {
      const parts = extractShortcutParts(key, customShortcuts, context, defaults);
      rows.push({
        context,
        key,
        current: parts.currentCommand,
        customized: parts.customized,
        defaultCommand: defaults[context]?.[key]?.command ?? null,
      });
    }
  }

  return (
    <ModalShell
      title={tr("restore-shortcuts.modal-title")}
      closeLabel={tr("labels.close")}
      footer={
        <div className="pp-modal-actions">
          <button type="button" className="pp-btn-secondary" onClick={close}>
            {tr("labels.cancel")}
          </button>
          <button
            type="button"
            className="pp-btn-primary"
            onClick={() => {
              close();
              onRestore();
            }}
          >
            {tr("restore-shortcuts.restore")}
          </button>
        </div>
      }
    >
      <div className="pp-modal-message">{tr("restore-shortcuts.modal-text")}</div>
      <table className="pp-shortcuts-table">
        <thead>
          <tr className="pp-shortcuts-list-header">
            <th className="pp-shortcut-header-name">{tr("restore-shortcuts.acction")}</th>
            <th className="pp-shortcut-header-command">{tr("labels.current")}</th>
            <th className="pp-shortcut-header-command">{tr("labels.default")}</th>
          </tr>
        </thead>
        <tbody className="pp-shortcuts-list-body">
          {rows.map((row) => (
            <tr key={row.context + "-" + row.key} className="pp-shortcuts-list-item">
              <td className="pp-shortcut-name">{tr(shortcutLabelKey(row.key))}</td>
              <td className="pp-shortcut-command">
                {isBlankCommand(row.current) ? (
                  <span className="pp-shortcut-empty">-</span>
                ) : (
                  <ShortcutKeys
                    content={row.current}
                    command={row.key}
                    macos={macos}
                    keyClassName={
                      row.customized ? "pp-shortcut-key-customized" : "pp-shortcut-key-default"
                    }
                  />
                )}
              </td>
              <td className="pp-shortcut-command">
                <ShortcutKeys
                  content={row.defaultCommand}
                  command={row.key}
                  macos={macos}
                  keyClassName="pp-shortcut-key-default"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ModalShell>
  );
}
