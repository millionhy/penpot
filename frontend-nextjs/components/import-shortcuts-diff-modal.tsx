"use client";

// Import shortcuts diff modal (F5.6). Port of
// app.main.ui.settings.import-shortcuts-diff-modal: the bindings that differ
// between the imported payload and what is effective now, grouped by context,
// with an apply button that merges the import into the profile props.
//
// Deviations from the CLJS original, documented:
// - The diff comes from computeShortcutsDiff of lib/shortcuts-page (the same
//   data the CLJS computes inline); the context separators are rendered from
//   the sorted rows instead of a volatile cursor.
// - Blank current and imported commands draw "-" (the CLJS blank guards);
//   a null current also draws "-" for the JS falsy difference.

import { Fragment } from "react";
import { ModalShell, useModal } from "@/components/modal";
import { ShortcutKeys } from "@/components/shortcut-keys";
import { tr } from "@/lib/i18n";
import { type CustomShortcuts } from "@/lib/shortcuts";
import {
  computeShortcutsDiff,
  contextDisplayName,
  shortcutLabelKey,
  sortShortcutDiffEntries,
  type ShortcutDefaults,
  type ShortcutDiffEntry,
} from "@/lib/shortcuts-page";

// str/blank? over a command: null and whitespace-only strings are blank; a
// vector command never is (the CLJS string form of a vector is not blank).
function isBlankCommand(command: string | string[] | null): boolean {
  if (command === null) return true;
  if (Array.isArray(command)) return false;
  return command.trim() === "";
}

export interface ImportShortcutsDiffModalProps {
  imported: Record<string, Record<string, string> | undefined>;
  customShortcuts: CustomShortcuts;
  defaults: ShortcutDefaults;
  macos: boolean;
  onApply: () => void;
}

export function ImportShortcutsDiffModal({
  imported,
  customShortcuts,
  defaults,
  macos,
  onApply,
}: ImportShortcutsDiffModalProps) {
  const { close } = useModal();

  const entries = sortShortcutDiffEntries(computeShortcutsDiff(imported, customShortcuts, defaults));
  const rows: Array<{ entry: ShortcutDiffEntry; showContext: boolean }> = [];
  let lastContext: string | null = null;
  for (const entry of entries) {
    rows.push({ entry, showContext: entry.context !== lastContext });
    lastContext = entry.context;
  }

  return (
    <ModalShell
      title={tr("import-shortcuts.diff-modal-title")}
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
              onApply();
            }}
          >
            {tr("import-shortcuts.apply")}
          </button>
        </div>
      }
    >
      <div className="pp-modal-message">{tr("import-shortcuts.diff-modal-text")}</div>
      {rows.length > 0 ? (
        <table className="pp-shortcuts-table">
          <thead>
            <tr className="pp-shortcuts-list-header">
              <th className="pp-shortcut-header-name">{tr("restore-shortcuts.acction")}</th>
              <th className="pp-shortcut-header-command">{tr("labels.current")}</th>
              <th className="pp-shortcut-header-command">{tr("labels.import")}</th>
            </tr>
          </thead>
          <tbody className="pp-shortcuts-list-body">
            {rows.map(({ entry, showContext }) => (
              <Fragment key={entry.context + "-" + entry.key}>
                {showContext ? (
                  <tr className="pp-shortcut-context-separator">
                    <td colSpan={3} className="pp-shortcut-context-label">
                      {contextDisplayName(entry.context)}
                    </td>
                  </tr>
                ) : null}
                <tr className="pp-shortcuts-list-item">
                  <td className="pp-shortcut-name">{tr(shortcutLabelKey(entry.key))}</td>
                  <td className="pp-shortcut-command">
                    {isBlankCommand(entry.current) ? (
                      <span className="pp-shortcut-empty">-</span>
                    ) : (
                      <ShortcutKeys
                        content={entry.current}
                        command={entry.key}
                        macos={macos}
                        customized={entry.customized}
                        light={true}
                      />
                    )}
                  </td>
                  <td className="pp-shortcut-command">
                    {isBlankCommand(entry.imported) ? (
                      <span className="pp-shortcut-empty">-</span>
                    ) : (
                      <ShortcutKeys
                        content={entry.imported}
                        command={entry.key}
                        macos={macos}
                        customized={true}
                        light={true}
                      />
                    )}
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="pp-shortcuts-no-changes">{tr("import-shortcuts.no-changes")}</div>
      )}
    </ModalShell>
  );
}
