"use client";

// Files export dialog (F5.6). Port of app.main.ui.exports.files plus the
// open-export-dialog flow of app.main.data.exports.files: a selection without
// linked libraries starts exporting as soon as the dialog opens, otherwise
// the dialog first asks what to do with them (the four export types).
//
// Deviations, documented:
// - The telemetry event of open-export-dialog is dropped (no analytics seam).
// - export-binfile is sent without the :version 3 of the CLJS call site (see
//   lib/binfile.ts).
// - "What do you want to do with linked libraries?" has no en.po key; the
//   CLJS source carries a TODO for it, the literal stays.

import { useCallback, useEffect, useRef, useState } from "react";
import { ModalShell, useModal } from "@/components/modal";
import { exportBinfile, exportTypeOptions, type ExportType } from "@/lib/binfile";
import { config } from "@/lib/config";
import { triggerDownloadUri } from "@/lib/dom";
import { tr } from "@/lib/i18n";

export interface ExportDialogFile {
  id: string;
  name: string;
  hasLibraries: boolean;
}

export interface ExportDialogProps {
  files: ExportDialogFile[];
}

interface ExportEntryState {
  id: string;
  name: string;
  loading: boolean;
  success: boolean;
  error: boolean;
}

// Literal tr() call sites per option, so scripts/extract-translations.mjs
// sees every key of files-export-modal.options.*.
function exportOptionTitle(type: ExportType): string {
  switch (type) {
    case "include-libraries":
      return tr("files-export-modal.options.include-libraries.title");
    case "merge-libraries":
      return tr("files-export-modal.options.merge-libraries.title");
    case "detach-libraries":
      return tr("files-export-modal.options.detach-libraries.title");
    case "link-later":
      return tr("files-export-modal.options.link-later.title");
  }
}

function exportOptionMessage(type: ExportType): string {
  switch (type) {
    case "include-libraries":
      return tr("files-export-modal.options.include-libraries.message");
    case "merge-libraries":
      return tr("files-export-modal.options.merge-libraries.message");
    case "detach-libraries":
      return tr("files-export-modal.options.detach-libraries.message");
    case "link-later":
      return tr("files-export-modal.options.link-later.message");
  }
}

export function ExportDialog({ files }: ExportDialogProps) {
  const { close } = useModal();
  const hasLibs = files.some((file) => file.hasLibraries === true);
  const [status, setStatus] = useState<"prepare" | "exporting">("prepare");
  const [selected, setSelected] = useState<ExportType>("include-libraries");
  const [entries, setEntries] = useState<ExportEntryState[]>(() =>
    files.map((file) => ({ id: file.id, name: file.name, loading: true, success: false, error: false })),
  );
  const types = exportTypeOptions(config.flags);

  const startExport = useCallback(
    (type: ExportType) => {
      setStatus("exporting");
      for (const file of files) {
        void exportBinfile(file.id, type)
          .then((uri) => {
            setEntries((prev) =>
              prev.map((entry) =>
                entry.id === file.id ? { ...entry, loading: false, success: true } : entry,
              ),
            );
            triggerDownloadUri(file.name, "application/penpot", uri);
          })
          .catch(() => {
            setEntries((prev) =>
              prev.map((entry) =>
                entry.id === file.id ? { ...entry, loading: false, error: true } : entry,
              ),
            );
          });
      }
    },
    [files],
  );

  // (mf/with-effect [has-libs?] (when-not has-libs? (start-export))): with no
  // linked libraries the export starts immediately. The ref keeps the
  // StrictMode double effect from exporting twice.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (hasLibs || autoStarted.current) return;
    autoStarted.current = true;
    startExport("include-libraries");
  }, [hasLibs, startExport]);

  const inProgress = entries.some((entry) => entry.loading);

  if (status === "prepare") {
    return (
      <ModalShell
        title={tr("files-download-modal.title")}
        closeLabel={tr("labels.close")}
        footer={
          <div className="pp-modal-actions">
            <button type="button" className="pp-btn-secondary" onClick={close}>
              {tr("labels.cancel")}
            </button>
            <button type="button" className="pp-btn-primary" onClick={() => startExport(selected)}>
              {tr("labels.continue")}
            </button>
          </div>
        }
      >
        {/* TODO: Add translation (kept in the CLJS source too) */}
        <p className="pp-modal-message">What do you want to do with linked libraries?</p>
        <div className="pp-export-options">
          {types.map((type) => (
            <div className="pp-export-option" key={type}>
              <label className="pp-export-option-label" htmlFor={"export-" + type}>
                <span
                  className={
                    selected === type ? "pp-option-icon-wrapper is-checked" : "pp-option-icon-wrapper"
                  }
                >
                  {selected === type ? (
                    <svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
                      <circle cx="4" cy="4" r="4" />
                    </svg>
                  ) : null}
                </span>
                <div className="pp-option-content">
                  <h3 className="pp-option-title">{exportOptionTitle(type)}</h3>
                  <p className="pp-modal-message">{exportOptionMessage(type)}</p>
                </div>
                <input
                  type="radio"
                  className="pp-option-input"
                  id={"export-" + type}
                  name="export-option"
                  checked={selected === type}
                  onChange={() => setSelected(type)}
                />
              </label>
            </div>
          ))}
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      title={tr("files-download-modal.title")}
      closeLabel={tr("labels.close")}
      footer={
        <div className="pp-modal-actions">
          <button type="button" className="pp-btn-primary" disabled={inProgress} onClick={close}>
            {tr("labels.close")}
          </button>
        </div>
      }
    >
      <div className="pp-export-entries">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className={
              "pp-export-entry" +
              (entry.loading ? " is-loading" : entry.success ? " is-success" : entry.error ? " is-error" : "")
            }
          >
            {entry.loading ? (
              <span className="pp-entry-spinner" aria-hidden="true" />
            ) : null}
            <span className="pp-export-entry-label">{entry.name}</span>
          </div>
        ))}
      </div>
      {inProgress ? (
        <span role="status" aria-live="polite" className="pp-export-status-message">
          {tr("labels.downloading-file")}
        </span>
      ) : null}
    </ModalShell>
  );
}
