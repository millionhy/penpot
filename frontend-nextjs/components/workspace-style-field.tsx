"use client";

// The shared controls of the workspace style panel (F9.9): the draft input
// and select every section uses, the small value readers behind them and the
// draft hook that keeps one commit path for the whole panel.
//
// Extracted from components/workspace-style-panel.tsx so the layout,
// constraints and multi-selection panels reuse the exact behavior of the
// single-shape section: typing updates a draft, blur or Enter commits it,
// Escape drops it, and a repeated commit of the same text sends nothing.
//
// The hook owns no RPC: the caller passes the send, which keeps the pending
// flag, the error and the canvas handle in the panel that owns them.

import { useRef, useState } from "react";

// <input type="color"> only accepts the six-digit form; a stored color in any
// other notation falls back to black for the swatch.
export const FALLBACK_COLOR = "#000000";
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function clampNonNegative(value: number): number {
  return Math.max(0, Number.isFinite(value) ? value : 0);
}

// The 0..100 show of a 0..1 paint opacity; a missing value reads as 1.
export function percentOf(value: unknown): number {
  return Math.round((typeof value === "number" ? clamp01(value) : 1) * 100);
}

export function parseNumber(raw: string): number | null {
  const value = Number.parseFloat(raw.trim());
  return Number.isFinite(value) ? value : null;
}

export function colorOf(value: unknown): string {
  return typeof value === "string" && HEX_COLOR_RE.test(value) ? value : FALLBACK_COLOR;
}

export function attrOf(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

// A numeric attr of a list row, shown with its stored value or a fallback.
export function numberAttr(value: unknown, key: string, fallback: number): number {
  const attr = attrOf(value, key);
  return typeof attr === "number" && Number.isFinite(attr) ? attr : fallback;
}

// Disambiguate the repeated inputs of a list ("Fill 2", "Opacity 1").
export function rowLabel(label: string, index: number): string {
  return `${label} ${index + 1}`;
}

export interface DraftFieldProps {
  // Stable key of the draft in the section map.
  fieldId: string;
  // The formatted store value; shown whenever no draft exists.
  value: string;
  draft: string | undefined;
  disabled: boolean;
  type: "text" | "number" | "color";
  // The visible label, also the accessible name. A color field hides it.
  label: string;
  unit?: string;
  // Shown when the input is empty, the mixed state of a multi selection.
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  onDraft: (fieldId: string, value: string) => void;
  onCommit: (fieldId: string, raw: string | undefined) => void;
  onCancel: (fieldId: string) => void;
}

// One input with a local draft (AD8): typing updates the draft, blur or Enter
// commits it and Escape drops it. Enter blurs so a single path commits; the
// section guards against the blur that disabling the input fires afterwards.
export function DraftField({
  fieldId,
  value,
  draft,
  disabled,
  type,
  label,
  unit,
  placeholder,
  min,
  max,
  step,
  onDraft,
  onCommit,
  onCancel,
}: DraftFieldProps) {
  return (
    <label className="pp-workspace-style-field">
      {type === "color" ? null : (
        <span className="pp-workspace-style-label">{label}</span>
      )}
      <span className="pp-workspace-style-input-wrap">
        <input
          type={type}
          className="pp-workspace-style-input"
          value={draft ?? value}
          placeholder={placeholder}
          min={type === "color" ? undefined : min}
          max={type === "color" ? undefined : max}
          step={type === "color" ? undefined : step}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => onDraft(fieldId, event.currentTarget.value)}
          onBlur={() => onCommit(fieldId, draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancel(fieldId);
            }
          }}
        />
        {unit === undefined ? null : (
          <span className="pp-workspace-style-unit">{unit}</span>
        )}
      </span>
    </label>
  );
}

export interface SelectOption {
  value: string;
  // The visible label; the CLJS layout panel renders most enum titles as
  // icons, so the shell shows the stored value when no label is given.
  label?: string;
}

export interface SelectFieldProps {
  // The visible label, also the accessible name.
  label: string;
  // The store value; "" renders the disabled mixed option first.
  value: string;
  options: readonly SelectOption[];
  disabled: boolean;
  // The text of the mixed option ("Mixed"): shown when the shapes disagree.
  mixedLabel: string;
  onChange: (value: string) => void;
}

// One enum select. A commit happens on change, like the CLJS selects; the
// mixed option is a disabled placeholder so the browser never reports a
// value the store does not hold.
export function SelectField({
  label,
  value,
  options,
  disabled,
  mixedLabel,
  onChange,
}: SelectFieldProps) {
  return (
    <label className="pp-workspace-style-field">
      <span className="pp-workspace-style-label">{label}</span>
      <select
        className="pp-workspace-style-select pp-workspace-style-select--field"
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {value === "" ? (
          <option value="" disabled>
            {mixedLabel}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label ?? option.value}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface DraftFields {
  drafts: Record<string, string>;
  setDraft: (fieldId: string, value: string) => void;
  dropDraft: (fieldId: string) => void;
  dropAllDrafts: () => void;
  commitDraft: (
    fieldId: string,
    raw: string | undefined,
    attrs: Record<string, unknown>,
  ) => void;
  // The same once-per-value guard for a field that does not send attributes
  // (the measures fields go through the geometry handle instead).
  commitAction: (
    fieldId: string,
    raw: string | undefined,
    action: () => Promise<boolean>,
  ) => void;
}

// The draft state of one section: the sent values, the drafts map and the
// one commit path. A field already sent with the same text sends nothing
// again (disabling an input on Enter fires a second blur), and every commit
// drops its draft when the send settles, so the store value shows through.
export function useDraftFields(
  send: (attrs: Record<string, unknown>) => Promise<boolean>,
): DraftFields {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const sentRef = useRef<Record<string, string>>({});
  const sendRef = useRef(send);
  sendRef.current = send;

  const setDraft = (fieldId: string, value: string): void => {
    setDrafts((current) => ({ ...current, [fieldId]: value }));
  };

  const dropDraft = (fieldId: string): void => {
    delete sentRef.current[fieldId];
    setDrafts((current) => {
      if (!(fieldId in current)) return current;
      const next = { ...current };
      delete next[fieldId];
      return next;
    });
  };

  const dropAllDrafts = (): void => {
    sentRef.current = {};
    setDrafts({});
  };

  const commitAction = (
    fieldId: string,
    raw: string | undefined,
    action: () => Promise<boolean>,
  ): void => {
    if (raw === undefined || sentRef.current[fieldId] === raw) return;
    sentRef.current[fieldId] = raw;
    void action().finally(() => dropDraft(fieldId));
  };

  const commitDraft = (
    fieldId: string,
    raw: string | undefined,
    attrs: Record<string, unknown>,
  ): void => {
    commitAction(fieldId, raw, () => sendRef.current(attrs));
  };

  return { drafts, setDraft, dropDraft, dropAllDrafts, commitDraft, commitAction };
}
