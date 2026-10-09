"use client";

// Import dialog (F5.6). Port of app.main.ui.dashboard.import: the
// analyze -> import -> library-resolution state machine opened from the
// project menu, the grid drop targets and the empty-project card.
//
// The CLJS dialog receives {name, uri} pairs and the worker reads them
// behind object URIs; the shell hands the picked File objects straight to
// lib/binfile.ts (see the header there for the pipeline-level deviations).
//
// Deviations, documented:
// - The name-editing path and the :libraries rendering of import-entry* are
//   not ported: both run through the "legacy-zip" format, which no longer
//   exists (editable? requires it; the worker never fills :libraries).
// - parse-progress-message has no producer in the shell pipeline; the rows
//   only render the loading spinner (the CLJS progress entries are dead
//   there too: nothing emits :progress messages any more).
// - The template clone error path closes the dialog and notifies, matching
//   the intent of the CLJS :error branch (it resets a status no stage
//   renders and then hides).
// - The analyze pass reads the picked files one after the other instead of
//   the CLJS worker pool; per-file isolation and the emitted results are the
//   same.
// - The wizard's default-selection effect keys on the current unresolved
//   file only, like the CLJS deps [candidates file-id], so unchecking a
//   checkbox is not undone by a re-run.
// - Entry removal matches the placeholder rows by identity (their file id is
//   still null) and analyzed rows by file id, the CLJS update-entry-name /
//   remove-entry behavior without its nil-id edge.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModalShell, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import {
  analyzeImportFile,
  applyAnalyzeUpdate,
  cloneTemplate,
  hasUnresolved,
  isImportReady,
  linkFileToLibrary,
  runImport,
  type BuiltinTemplate,
  type FileResolution,
  type ImportEntry,
  type ImportEntryStatus,
  type ImportResolution,
  type ResolutionCandidate,
} from "@/lib/binfile";
import { pickFiles } from "@/lib/dom";
import { tr } from "@/lib/i18n";

// --- entry points -------------------------------------------------------------

// use-import-file of app.main.ui.dashboard.import: opens the dialog for the
// dropped files (openFiles), through the OS picker (openPicker, the menu
// entries and the empty-project card) or for a builtin template (openTemplate,
// the templates strip). Grids without a project (search) or without edit
// rights stay inert, since their callers pass null / never enable the entry
// points.
export function useImportFile(projectId: string | null, onFinishImport?: () => void) {
  const modal = useModal();
  const openFiles = useCallback(
    (files: FileList | File[] | null) => {
      const list = files === null ? [] : [...files];
      if (projectId === null || list.length === 0) return;
      modal.open(
        <ImportDialog projectId={projectId} files={list} onFinishImport={onFinishImport} />,
      );
    },
    [modal, projectId, onFinishImport],
  );
  const openPicker = useCallback(() => {
    void pickFiles({ accept: ".penpot,.zip", multiple: true }).then(openFiles);
  }, [openFiles]);
  // import-template! of app.main.ui.dashboard.templates.
  const openTemplate = useCallback(
    (template: BuiltinTemplate) => {
      if (projectId === null) return;
      modal.open(
        <ImportDialog projectId={projectId} template={template} onFinishImport={onFinishImport} />,
      );
    },
    [modal, projectId, onFinishImport],
  );
  return { openFiles, openPicker, openTemplate };
}

// --- dialog -------------------------------------------------------------------

type ImportStage =
  | "analyze"
  | "import-ready"
  | "import-progress"
  | "import-success"
  | "import-error"
  | "library-resolution"
  | "library-summary";

export interface ImportDialogProps {
  projectId: string;
  files?: File[];
  template?: BuiltinTemplate;
  onFinishImport?: () => void;
}

function candidateLabel(candidate: ResolutionCandidate | undefined): string {
  if (candidate === undefined) return "";
  return candidate.name + " (" + candidate["project-name"] + ")";
}

// The error classification of import-files-stage*'s disclaimer list.
function errorDetail(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes("check error")) return tr("dashboard.import.import-error.check-error");
  if (lower.includes("corrupt")) return tr("dashboard.import.import-error.corrupt-file");
  return tr("dashboard.import.import-error.unknown-error");
}

interface ImportEntryRowProps {
  entry: { name: string; status: ImportEntryStatus | ImportStage; error?: string | undefined };
  canBeDeleted: boolean;
  isProgress: boolean;
  onDelete: () => void;
}

// import-entry*: the spinner until the entry settles, the name tinted by the
// outcome and the error line under it.
function ImportEntryRow({ entry, canBeDeleted, isProgress, onDelete }: ImportEntryRowProps) {
  const loading =
    entry.status === "analyze" ||
    entry.status === "import-progress" ||
    (isProgress && entry.status === "import-ready");
  const success = entry.status === "import-success" || entry.status === "import-ready";
  const failed = entry.status === "import-error" || entry.status === "analyze-error";
  const classes = ["pp-import-entry"];
  if (loading) classes.push("is-loading");
  else if (success) classes.push("is-success");
  else if (failed) classes.push("is-error");

  return (
    <div className={classes.join(" ")}>
      <div className="pp-import-entry-line">
        {loading ? <span className="pp-entry-spinner" aria-hidden="true" /> : null}
        <span className="pp-import-entry-name" title={entry.name}>
          {entry.name}
        </span>
        {canBeDeleted ? (
          <button
            type="button"
            className="pp-icon-btn"
            aria-label={tr("labels.delete")}
            onClick={onDelete}
          >
            {"\u00d7"}
          </button>
        ) : null}
      </div>
      {failed ? (
        <span className="pp-import-entry-error">
          {entry.error ??
            (entry.status === "analyze-error"
              ? tr("dashboard.import.analyze-error")
              : tr("labels.error"))}
        </span>
      ) : null}
    </div>
  );
}

// --- library resolution wizard ------------------------------------------------

interface ResolutionWizardProps {
  file: FileResolution;
  selection: Record<string, Record<string, string>>;
  onSelect: (fileId: string, libraryId: string, candidateId: string) => void;
  onDisconnect: (fileId: string, libraryId: string) => void;
}

// library-resolution*: one unresolved file's pending libraries, each with a
// checkbox and the candidate select.
function ResolutionWizard({ file, selection, onSelect, onDisconnect }: ResolutionWizardProps) {
  const fileSelection = selection[file.id] ?? {};

  // Default each pending library to another file's choice for it, if any,
  // else the first candidate. Keyed on the current file only (the CLJS deps
  // [candidates file-id]); selection is read but must not re-trigger this,
  // or unchecking a row would self-heal on the spot.
  useEffect(() => {
    for (const pending of file.pending) {
      if (fileSelection[pending.id] !== undefined) continue;
      const otherChoice = Object.values(selection)
        .map((librarySelection) => librarySelection[pending.id])
        .find((choice) => choice !== undefined);
      const first = pending.candidates[0];
      const defaultId = otherChoice ?? (first !== undefined ? String(first.id) : undefined);
      if (defaultId !== undefined) onSelect(file.id, pending.id, defaultId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const toggle = (pendingId: string, candidates: ResolutionCandidate[]) => {
    if (fileSelection[pendingId] !== undefined) {
      onDisconnect(file.id, pendingId);
      return;
    }
    const first = candidates[0];
    if (first !== undefined) onSelect(file.id, pendingId, String(first.id));
  };

  return (
    <div className="pp-resolution">
      <div className="pp-resolution-file-header">
        <span className="pp-resolution-file-name">{file.name}</span>
      </div>
      <p className="pp-resolution-message">{tr("dashboard.import.resolve-libraries")}</p>
      <table className="pp-resolution-table">
        <thead>
          <tr>
            <th className="pp-resolution-column">
              {tr("dashboard.import.resolve-libraries.original-library")}
            </th>
            <th className="pp-resolution-arrow" />
            <th className="pp-resolution-column">
              {tr("dashboard.import.resolve-libraries.connect-to")}
            </th>
          </tr>
        </thead>
        <tbody>
          {file.pending.map((pending) => {
            const selected = fileSelection[pending.id];
            const connected = selected !== undefined;
            const fallback =
              pending.candidates.find((candidate) => String(candidate.id) === selected) ??
              pending.candidates[0];
            return (
              <tr className="pp-resolution-item" key={pending.id}>
                <td className="pp-resolution-item-name">
                  <label className="pp-resolution-check">
                    <input
                      type="checkbox"
                      checked={connected}
                      onChange={() => toggle(pending.id, pending.candidates)}
                    />
                    <span>{pending.name}</span>
                  </label>
                </td>
                <td className="pp-resolution-arrow" aria-hidden="true">
                  {"\u2192"}
                </td>
                <td>
                  {connected ? (
                    <select
                      className="pp-resolution-select"
                      value={selected ?? ""}
                      onChange={(event) => onSelect(file.id, pending.id, event.target.value)}
                    >
                      {pending.candidates.map((candidate) => (
                        <option key={candidate.id} value={String(candidate.id)}>
                          {candidateLabel(candidate)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="pp-resolution-no-selection">{candidateLabel(fallback)}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- library resolution summary -----------------------------------------------

function SummaryFile({
  file,
  fileSelection,
}: {
  file: FileResolution;
  fileSelection: Record<string, string>;
}) {
  return (
    <div className="pp-summary-file">
      <div className="pp-summary-file-header">
        <span className="pp-summary-file-name">{file.name}</span>
      </div>
      <div className="pp-summary-body">
        {file.done.length > 0 ? (
          <div className="pp-summary-section">
            <ul className="pp-summary-list">
              {file.done.map((done) => (
                <li className="pp-summary-list-item" key={done.name}>
                  <span className="pp-summary-item-name">{done.name}</span>
                  <span className="pp-summary-linked-badge">
                    <span aria-hidden="true">{"\u2713"}</span>
                    {tr("dashboard.import.summary.linked")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {file.pending.length > 0 ? (
          <div className="pp-summary-section">
            <div className="pp-summary-section-header">
              <span className="pp-summary-section-title">
                {tr("dashboard.import.summary.manually-linked")}
              </span>
            </div>
            <ul className="pp-summary-list">
              <li className="pp-summary-list-item">
                <span className="pp-summary-item-name-header">
                  {tr("dashboard.import.summary.original")}
                </span>
                <span className="pp-summary-item-name-header">
                  {tr("dashboard.import.summary.new")}
                </span>
              </li>
              {file.pending.map((pending) => {
                const selectedId = fileSelection[pending.id];
                const selected =
                  selectedId === undefined
                    ? undefined
                    : pending.candidates.find(
                        (candidate) => String(candidate.id) === String(selectedId),
                      );
                return (
                  <li className="pp-summary-list-item" key={pending.id}>
                    <span className="pp-summary-item-name">{pending.name}</span>
                    <span className="pp-summary-linked-info">
                      <span aria-hidden="true">{"\u2192"}</span>
                      {selected !== undefined ? (
                        <span className="pp-summary-linked-name">{candidateLabel(selected)}</span>
                      ) : (
                        <span className="pp-summary-no-selection">
                          {tr("dashboard.import.summary.no-selection")}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// library-resolution-summary*: the auto-linked libraries and the manual
// choices, per imported file.
function ResolutionSummary({
  resolution,
  selection,
}: {
  resolution: ImportResolution;
  selection: Record<string, Record<string, string>>;
}) {
  return (
    <div className="pp-resolution">
      <p className="pp-resolution-message">
        {tr("dashboard.import.resolve-libraries-summary")}
      </p>
      {Object.entries(resolution).map(([fileId, file]) => (
        <SummaryFile key={fileId} file={file} fileSelection={selection[fileId] ?? {}} />
      ))}
    </div>
  );
}

// --- dialog body --------------------------------------------------------------

export function ImportDialog({
  projectId,
  files = [],
  template,
  onFinishImport,
}: ImportDialogProps) {
  const { close } = useModal();
  const notifications = useNotifications();

  // initialize-state: every picked file starts as one "analyze" placeholder;
  // sourceKey ties the analyze results (and the v3 upload groups) back to it.
  const [picked] = useState(() => files.map((file) => ({ key: crypto.randomUUID(), file })));
  const [entries, setEntries] = useState<ImportEntry[]>(() =>
    template !== undefined
      ? []
      : picked.map(({ key, file }) => ({
          sourceKey: key,
          file,
          name: file.name,
          fileId: null,
          format: null,
          status: "analyze" as const,
        })),
  );
  const [status, setStatus] = useState<ImportStage>("analyze");
  const [resolution, setResolution] = useState<ImportResolution | null>(null);
  // {file-id {old-library-id candidate-id}} of the resolution wizard.
  const [selection, setSelection] = useState<Record<string, Record<string, string>>>({});
  // The ordered "visited" stack of unresolved file ids: next conjes, previous
  // pops, and the current file is the first unresolved one not in it.
  const [visited, setVisited] = useState<string[]>([]);

  const visibleEntries = useMemo(
    () => entries.filter((entry) => entry.deleted !== true),
    [entries],
  );
  const unresolvedFiles = useMemo(
    () => (resolution === null ? [] : Object.values(resolution).filter(hasUnresolved)),
    [resolution],
  );
  const currentFile = unresolvedFiles.find((file) => !visited.includes(file.id));
  const lastFile =
    currentFile !== undefined &&
    unresolvedFiles.every((file) => file.id === currentFile.id || visited.includes(file.id));
  const pendingAnalysis = visibleEntries.some((entry) => entry.status === "analyze");

  const finish = useCallback(() => {
    close();
    onFinishImport?.();
  }, [close, onFinishImport]);

  const removeEntry = useCallback((target: ImportEntry) => {
    setEntries((current) =>
      current.map((entry) =>
        entry === target || (target.fileId !== null && entry.fileId === target.fileId)
          ? { ...entry, deleted: true }
          : entry,
      ),
    );
  }, []);

  // continue-entries: upload the ready rows and resolve once every upload
  // settled; the stage effect below picks up the outcome.
  const continueEntries = useCallback(() => {
    const ready = visibleEntries.filter(isImportReady);
    setStatus("import-progress");
    void runImport(projectId, ready, (message) => {
      setEntries((current) =>
        current.map((entry) =>
          entry.fileId === message.fileId
            ? {
                ...entry,
                status: message.status === "finish" ? "import-success" : "import-error",
                error: message.error,
              }
            : entry,
        ),
      );
    }).then((imported) => {
      if (Object.keys(imported).length > 0) setResolution(imported);
    });
  }, [projectId, visibleEntries]);

  // continue-template: clone-template and land on the success stage.
  const continueTemplate = useCallback(() => {
    if (template === undefined) return;
    setStatus("import-progress");
    void cloneTemplate(projectId, template.id).then(
      () => {
        setStatus("import-success");
        onFinishImport?.();
      },
      () => {
        close();
        notifications.error(tr("dashboard.libraries-and-templates.import-error"));
      },
    );
  }, [projectId, template, close, notifications, onFinishImport]);

  const selectLibrary = useCallback(
    (fileId: string, libraryId: string, candidateId: string) => {
      setSelection((current) => ({
        ...current,
        [fileId]: { ...(current[fileId] ?? {}), [libraryId]: candidateId },
      }));
    },
    [],
  );

  const disconnectLibrary = useCallback((fileId: string, libraryId: string) => {
    setSelection((current) => {
      const fileSelection = { ...(current[fileId] ?? {}) };
      delete fileSelection[libraryId];
      return { ...current, [fileId]: fileSelection };
    });
  }, []);

  const wizardNext = useCallback(() => {
    if (currentFile === undefined) return;
    const fileId = currentFile.id;
    setVisited((current) => (current.includes(fileId) ? current : [...current, fileId]));
  }, [currentFile]);

  const wizardPrev = useCallback(() => {
    setVisited((current) => current.slice(0, -1));
  }, []);

  const wizardSkip = useCallback(() => {
    if (currentFile === undefined) return;
    const fileId = currentFile.id;
    const pendingIds = currentFile.pending.map((row) => row.id);
    setSelection((current) => {
      const fileSelection = { ...(current[fileId] ?? {}) };
      for (const id of pendingIds) delete fileSelection[id];
      return { ...current, [fileId]: fileSelection };
    });
    setVisited((current) => (current.includes(fileId) ? current : [...current, fileId]));
  }, [currentFile]);

  const summaryBack = useCallback(() => {
    setVisited((current) => current.slice(0, -1));
    setStatus("library-resolution");
  }, []);

  // confirm-library-links: link every pending library to its selection; the
  // per-link failures are swallowed like link-files-to-library! does.
  const confirmLinks = useCallback(() => {
    if (resolution === null) return;
    const jobs: Array<Promise<unknown>> = [];
    for (const [fileId, fileResolution] of Object.entries(resolution)) {
      for (const pending of fileResolution.pending) {
        const target = selection[fileId]?.[pending.id];
        if (target !== undefined) {
          jobs.push(linkFileToLibrary(fileId, target).catch(() => undefined));
        }
      }
    }
    void Promise.all(jobs).then(finish);
  }, [resolution, selection, finish]);

  // The stage transitions of the [entries resolution] effect.
  useEffect(() => {
    if (template !== undefined) {
      setStatus("import-ready");
      return;
    }
    if (visibleEntries.length === 0) return;
    if (visibleEntries.every((entry) => entry.status === "import-ready")) {
      setStatus("import-ready");
    } else if (visibleEntries.every((entry) => entry.status === "import-success")) {
      if (resolution === null) setStatus("import-success");
      else if (Object.values(resolution).some(hasUnresolved)) setStatus("library-resolution");
      else setStatus("library-summary");
    } else if (
      visibleEntries.every((entry) => entry.status !== "import-ready") &&
      visibleEntries.some((entry) => entry.status === "import-error")
    ) {
      setStatus("import-error");
    }
  }, [template, visibleEntries, resolution]);

  // The [visited unresolved-files] effect: once every unresolved file was
  // visited the wizard hands off to the summary.
  useEffect(() => {
    if (unresolvedFiles.length === 0) return;
    if (unresolvedFiles.every((file) => visited.includes(file.id))) setStatus("library-summary");
  }, [unresolvedFiles, visited]);

  // Run the analyze pass on mount. The ref keeps the StrictMode double mount
  // from analyzing twice.
  const analyzeStarted = useRef(false);
  useEffect(() => {
    if (analyzeStarted.current) return;
    analyzeStarted.current = true;
    void (async () => {
      for (const item of picked) {
        const results = await analyzeImportFile(item);
        for (const result of results) setEntries((current) => applyAnalyzeUpdate(current, result));
      }
    })();
  }, [picked]);

  const successTotal =
    template !== undefined
      ? 1
      : visibleEntries.filter((entry) => entry.status === "import-success").length;
  const hasErrors =
    template !== undefined
      ? status === "import-error"
      : visibleEntries.some(
          (entry) => entry.status === "import-error" || entry.status === "analyze-error",
        ) || visibleEntries.length === 0;
  const autoLinkedCount =
    resolution === null
      ? 0
      : Object.values(resolution).reduce((total, file) => total + file.done.length, 0);

  const title = tr("dashboard.import");
  const closeLabel = tr("labels.close");

  if (status === "library-resolution" && currentFile !== undefined) {
    return (
      <ModalShell
        title={title}
        closeLabel={closeLabel}
        footer={
          <div className="pp-import-wizard-actions">
            {visited.length > 0 ? (
              <button type="button" className="pp-btn-secondary" onClick={wizardPrev}>
                {tr("labels.previous")}
              </button>
            ) : null}
            <div className="pp-import-wizard-actions-end">
              <button type="button" className="pp-btn-secondary" onClick={wizardSkip}>
                {tr("labels.skip")}
              </button>
              <button type="button" className="pp-btn-primary" onClick={wizardNext}>
                {lastFile
                  ? tr("dashboard.import.connect-selected-libraries")
                  : tr("dashboard.import.next-file")}
              </button>
            </div>
          </div>
        }
      >
        <ResolutionWizard
          file={currentFile}
          selection={selection}
          onSelect={selectLibrary}
          onDisconnect={disconnectLibrary}
        />
      </ModalShell>
    );
  }

  if (status === "library-summary" && resolution !== null) {
    return (
      <ModalShell
        title={title}
        closeLabel={closeLabel}
        footer={
          <div className="pp-import-wizard-actions">
            {visited.length > 0 ? (
              <button type="button" className="pp-btn-secondary" onClick={summaryBack}>
                {tr("labels.back")}
              </button>
            ) : null}
            <div className="pp-import-wizard-actions-end">
              <button type="button" className="pp-btn-primary" onClick={confirmLinks}>
                {tr("dashboard.import.confirm-library-links")}
              </button>
            </div>
          </div>
        }
      >
        <ResolutionSummary resolution={resolution} selection={selection} />
      </ModalShell>
    );
  }

  return (
    <ModalShell
      title={title}
      closeLabel={closeLabel}
      footer={
        <div className="pp-modal-actions">
          {status === "analyze" ? (
            <button type="button" className="pp-btn-secondary" onClick={close}>
              {tr("labels.cancel")}
            </button>
          ) : status === "import-ready" ? (
            <button
              type="button"
              className="pp-btn-primary"
              disabled={pendingAnalysis}
              onClick={() => {
                if (template !== undefined) continueTemplate();
                else continueEntries();
              }}
            >
              {tr("labels.continue")}
            </button>
          ) : status === "import-progress" ? (
            <button type="button" className="pp-btn-primary" disabled>
              {tr("labels.accept")}
            </button>
          ) : (
            <button type="button" className="pp-btn-primary" onClick={finish}>
              {tr("labels.accept")}
            </button>
          )}
        </div>
      }
    >
      {status === "analyze" && hasErrors ? (
        <div className="pp-import-notice is-warning">{tr("dashboard.import.import-warning")}</div>
      ) : null}
      {status === "import-success" ? (
        <>
          <div className={"pp-import-notice " + (successTotal === 0 ? "is-warning" : "is-success")}>
            {tr("dashboard.import.import-message", successTotal)}
          </div>
          {autoLinkedCount > 0 ? (
            <div className="pp-import-notice is-success">
              {tr("dashboard.import.auto-linked-libraries", autoLinkedCount)}
            </div>
          ) : null}
        </>
      ) : null}
      {status === "import-error" ? (
        <div className="pp-import-notice is-error">
          {tr("dashboard.import.import-error.disclaimer")}
        </div>
      ) : null}
      {status === "import-error" || (status === "analyze" && hasErrors) ? (
        <div className="pp-import-error-disclaimer">
          <div>{tr("dashboard.import.import-error.message1")}</div>
          <ul className="pp-import-error-list">
            {visibleEntries.map((entry) => {
              if (entry.status !== "import-error" && entry.status !== "analyze-error") return null;
              return (
                <li
                  className="pp-import-error-entry"
                  key={entry.sourceKey + "/" + (entry.fileId ?? "pending")}
                >
                  <div>{entry.name}</div>
                  {entry.error !== undefined ? (
                    <div className="pp-import-error-detail">{errorDetail(entry.error)}</div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div>{tr("dashboard.import.import-error.message2")}</div>
        </div>
      ) : null}
      <div className="pp-import-entries">
        {visibleEntries.map((entry) => (
          <ImportEntryRow
            key={entry.sourceKey + "/" + (entry.fileId ?? "pending")}
            entry={entry}
            canBeDeleted={visibleEntries.length > 1}
            isProgress={status === "import-progress"}
            onDelete={() => removeEntry(entry)}
          />
        ))}
        {template !== undefined ? (
          <ImportEntryRow
            entry={{ name: template.name, status }}
            canBeDeleted={false}
            isProgress={status === "import-progress"}
            onDelete={() => undefined}
          />
        ) : null}
      </div>
      {status === "import-progress" ? (
        <span role="status" aria-live="polite" className="pp-import-status-message">
          {tr("labels.uploading-file")}
        </span>
      ) : null}
    </ModalShell>
  );
}

