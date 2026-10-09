"use client";

// Shortcut rows (F5.6). Port of shortcut-row* and shortcut-row-editable* in
// app.main.ui.shortcuts: the read-only row with keycaps, conflict title and
// disabled icon, and the editable row with the recording flow, the pending
// notifications and the save/disable/reset buttons.
//
// Deviations from the CLJS original, documented:
// - The recording listener is a native keydown on the recording div (the
//   CLJS goog.events.listen), not a React handler: the matcher listens on
//   the document, and a synthetic stopPropagation cannot keep a same-node
//   listener away. Stopping at the target keeps the keydown from reaching
//   the document, and so the matcher; nothing on the way runs React handlers
//   either, like the CLJS where the listener sits on the element.
// - The inline notifications are drawn here (pp-shortcut-msg-*) instead of
//   through the ds context-notification component; classes and texts match.
// - The ds tooltips become title attributes.
// - The rows take typed props (ShortcutTreeRow) instead of the CLJS element
//   lists; conflicts maps a shortcut key to the key already holding its
//   command.
// - The CLJS truthiness checks on recorded-command become explicit null
//   checks; "" is a valid recording state (the disable flow), never a
//   command.
// - Icons are the unicode glyphs used elsewhere in the shell.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
} from "react";
import { ShortcutKeys } from "@/components/shortcut-keys";
import { tr } from "@/lib/i18n";
import {
  eventToDisplayParts,
  eventToMousetrapCommand,
  findConflict,
  type ShortcutConflict,
  type ShortcutDefinitionShape,
  type ShortcutDisplayParts,
} from "@/lib/shortcuts";
import { type ShortcutTreeRow } from "@/lib/shortcuts-page";

// The definition map the conflict search walks, per section.
export type ShortcutContextMap = Record<string, ShortcutDefinitionShape & { labelKey?: string }>;

export interface ShortcutRowProps {
  row: ShortcutTreeRow;
  contextShortcuts: ShortcutContextMap;
  // Editable rows render the recording flow; the rest is the tree view.
  editable: boolean;
  conflicts?: Record<string, ShortcutConflict>;
  macos: boolean;
  onSave?: (key: string, command: string, conflictKey: string | null) => void;
  onDisable?: (key: string) => void;
  onReset?: (key: string, defaultCommand: string | string[] | null) => void;
}

// str/blank? over the command: a missing or whitespace-only string is blank;
// a vector keeps the CLJS behavior (the string form of a non-empty vector is
// never blank).
function isBlankContent(content: string | string[] | null): boolean {
  if (content === null) return true;
  if (Array.isArray(content)) {
    return content.length > 0 && content.every((part) => part.trim() === "");
  }
  return content.trim() === "";
}

export function ShortcutRow({
  row,
  contextShortcuts,
  editable,
  conflicts,
  macos,
  onSave,
  onDisable,
  onReset,
}: ShortcutRowProps) {
  if (editable && row.customizable) {
    return (
      <EditableShortcutRow
        row={row}
        contextShortcuts={contextShortcuts}
        conflict={conflicts?.[row.key]}
        macos={macos}
        onSave={onSave}
        onDisable={onDisable}
        onReset={onReset}
      />
    );
  }
  return <ReadOnlyShortcutRow row={row} conflict={conflicts?.[row.key]} macos={macos} />;
}

interface ReadOnlyShortcutRowProps {
  row: ShortcutTreeRow;
  conflict?: ShortcutConflict;
  macos: boolean;
}

function ReadOnlyShortcutRow({ row, conflict, macos }: ReadOnlyShortcutRowProps) {
  const customized = row.customState !== "default";
  const hasConflict = conflict !== undefined;

  return (
    <li
      className={"pp-shortcut-row" + (customized ? " pp-shortcut-row-customized" : "")}
      data-customized={String(customized)}
      data-conflict={String(hasConflict)}
      aria-label={row.translation}
    >
      <span>
        <span
          className={
            "pp-shortcut-command-name" + (row.customizable ? "" : " pp-shortcut-not-customizable")
          }
          id={row.translation + "-label"}
        >
          {row.translation}
        </span>
        {row.customizable ? null : (
          <span className="pp-shortcut-not-customizable">(not customizable)</span>
        )}
      </span>
      <div className="pp-shortcut-actions" aria-labelledby={row.translation + "-label"}>
        {customized && isBlankContent(row.command) ? (
          <span
            className="pp-shortcut-detach-icon"
            title={tr("shortcuts.disabled-shortcut")}
            aria-hidden={true}
          >
            {"\u26D3"}
          </span>
        ) : hasConflict ? (
          <span
            className="pp-shortcut-option-text"
            title={tr("shortcuts.overwritten-by", tr(conflict.labelKey))}
          >
            <ShortcutKeys
              content={row.command}
              command={row.key}
              macos={macos}
              customized={customized}
              conflict={true}
            />
          </span>
        ) : (
          <ShortcutKeys
            content={row.command}
            command={row.key}
            macos={macos}
            customized={customized}
          />
        )}
      </div>
    </li>
  );
}

interface EditableShortcutRowProps {
  row: ShortcutTreeRow;
  contextShortcuts: ShortcutContextMap;
  conflict?: ShortcutConflict;
  macos: boolean;
  onSave?: (key: string, command: string, conflictKey: string | null) => void;
  onDisable?: (key: string) => void;
  onReset?: (key: string, defaultCommand: string | string[] | null) => void;
}

function EditableShortcutRow({
  row,
  contextShortcuts,
  conflict,
  macos,
  onSave,
  onDisable,
  onReset,
}: EditableShortcutRowProps) {
  const customized = row.customState !== "default";
  const hasConflict = conflict !== undefined;

  const [isEditing, setIsEditing] = useState(false);
  const [displayParts, setDisplayParts] = useState<ShortcutDisplayParts | null>(null);
  const [recordedCommand, setRecordedCommand] = useState<string | string[] | null>(null);
  const [recordingConflict, setRecordingConflict] = useState<ShortcutConflict | null>(null);
  const [resetNotification, setResetNotification] = useState<string | string[] | null>(null);
  const [resetPending, setResetPending] = useState(false);

  const recordingRef = useRef<HTMLDivElement | null>(null);

  const cleanEditingState = useCallback(() => {
    setIsEditing(false);
    setDisplayParts(null);
    setRecordedCommand(null);
    setRecordingConflict(null);
    setResetNotification(null);
    setResetPending(false);
  }, []);

  const startEditing = useCallback(() => {
    setIsEditing(true);
    setDisplayParts(null);
    setRecordedCommand(null);
    setRecordingConflict(null);
  }, []);

  const stopEditing = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      cleanEditingState();
    },
    [cleanEditingState],
  );

  const onDisableShortcut = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      onDisable?.(row.key);
      cleanEditingState();
    },
    [row.key, onDisable, cleanEditingState],
  );

  const onResetClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      setResetPending(true);
      setRecordedCommand(row.originalCommand);
      setResetNotification(row.originalCommand);
      setRecordingConflict(null);
      setDisplayParts(null);
    },
    [row.originalCommand],
  );

  const onSaveShortcut = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (recordedCommand !== null) {
        if (resetPending) {
          onReset?.(row.key, recordedCommand);
        } else if (typeof recordedCommand === "string") {
          onSave?.(row.key, recordedCommand, recordingConflict?.key ?? null);
        }
      }
      cleanEditingState();
    },
    [recordedCommand, resetPending, recordingConflict, row.key, onSave, onReset, cleanEditingState],
  );

  const onEditableContainerBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) cleanEditingState();
    },
    [cleanEditingState],
  );

  useEffect(() => {
    if (!isEditing) return;
    recordingRef.current?.focus();
  }, [isEditing]);

  useEffect(() => {
    if (displayParts === null) return;
    setResetNotification(null);
    setResetPending(false);
  }, [displayParts]);

  useEffect(() => {
    if (!isEditing) return;
    const node = recordingRef.current;
    if (node === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const command = eventToMousetrapCommand(event, macos);
      setDisplayParts(eventToDisplayParts(event, macos));
      if (command !== null) {
        setRecordedCommand(command);
        setRecordingConflict(findConflict(command, contextShortcuts, row.key));
      }
    };
    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [isEditing, macos, contextShortcuts, row.key]);

  return (
    <li
      className={
        "pp-shortcut-row-editable" +
        (isEditing ? " pp-shortcut-row-editing" : "") +
        (customized ? " pp-shortcut-row-customized" : "")
      }
      data-customized={String(customized)}
      data-conflict={String(hasConflict)}
      aria-label={row.translation}
    >
      <button
        type="button"
        className={"pp-shortcut-button" + (isEditing ? " pp-shortcut-button-editing" : "")}
        disabled={isEditing}
        aria-label={"Edit " + row.translation}
        onClick={startEditing}
      >
        <span className="pp-shortcut-command-name" id={row.translation + "-label"}>
          {row.translation}
        </span>
        <div className="pp-shortcut-actions" aria-labelledby={row.translation + "-label"}>
          {customized && isBlankContent(row.command) ? (
            <span className="pp-shortcut-detach-icon" aria-hidden={true}>
              {"\u26D3"}
            </span>
          ) : hasConflict ? (
            <span
              className="pp-shortcut-option-text"
              title={tr("shortcuts.overwritten-by", tr(conflict.labelKey))}
            >
              <ShortcutKeys
                content={row.command}
                command={row.key}
                macos={macos}
                customized={customized}
                conflict={true}
              />
            </span>
          ) : (
            <ShortcutKeys
              content={row.command}
              command={row.key}
              macos={macos}
              customized={customized}
            />
          )}
        </div>
      </button>
      {isEditing ? (
        <div
          className="pp-shortcut-editing"
          ref={recordingRef}
          tabIndex={0}
          onBlur={onEditableContainerBlur}
        >
          <div className="pp-shortcut-recording-area">
            {displayParts === null ? (
              <span className="pp-shortcut-placeholder">{tr("shortcuts.key-combo")}</span>
            ) : (
              <span className="pp-shortcut-recorded-keys">
                {displayParts.modifiers.map((modifier) => (
                  <span
                    className={"pp-shortcut-key" + (customized ? " pp-shortcut-key-customized" : "")}
                    key={modifier}
                  >
                    {modifier}
                  </span>
                ))}
                {displayParts.finalKey !== undefined ? (
                  <span
                    className={"pp-shortcut-key" + (customized ? " pp-shortcut-key-customized" : "")}
                  >
                    {displayParts.finalKey}
                  </span>
                ) : null}
                {displayParts.finalized ? null : (
                  <span className="pp-shortcut-recording-ellipsis">...</span>
                )}
              </span>
            )}
          </div>
          {resetNotification !== null ? (
            <div className="pp-shortcut-msg-info">
              {tr("shortcuts.edit-modal.reset-pending")}{" "}
              <ShortcutKeys content={resetNotification} command="default" macos={macos} />
            </div>
          ) : null}
          {recordedCommand !== null && !resetPending ? (
            recordingConflict !== null ? (
              <div className="pp-shortcut-msg-warning">
                {tr("shortcuts.edit-modal.conflict", tr(recordingConflict.labelKey))}
              </div>
            ) : (
              <div className="pp-shortcut-msg-success">{tr("shortcuts.edit-modal.success")}</div>
            )
          ) : null}
          <div className="pp-shortcut-edit-buttons">
            <div className="pp-shortcut-confirmation-buttons">
              <button
                type="button"
                className="pp-btn-secondary"
                aria-label={tr("labels.cancel")}
                onClick={stopEditing}
              >
                {"\u00D7"}
              </button>
              <button
                type="button"
                className="pp-btn-primary"
                aria-label={tr("labels.save")}
                onClick={onSaveShortcut}
              >
                {"\u2713"}
              </button>
            </div>
            <div className="pp-shortcut-confirmation-buttons">
              <button
                type="button"
                className="pp-btn-secondary"
                aria-label={tr("shortcuts.disable")}
                onClick={onDisableShortcut}
              >
                {"\u26D3"}
              </button>
              {customized ? (
                <button
                  type="button"
                  className="pp-btn-secondary"
                  aria-label={tr("shortcuts.reset")}
                  onClick={onResetClick}
                >
                  {"\u21BB"}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}
