"use client";

// The workspace style panel (F9.5): the right-sidebar options for the single
// selected shape. Port of the basic segment of the CLJS options toolbox
// (sidebar/options/menus/{layer,fill,stroke,border_radius}.cljs): the layer
// flags, opacity, fills, strokes and the rect/frame radius.
//
// A controlled view over the store with local drafts (AD8): text, number and
// color edits keep a draft and commit on blur or Enter; Escape restores the
// store value; the toggles and add/remove commit at once. Every commit goes
// through the canvas handle (updateShapeAttrs), which owns the update-file
// envelope, the wasm sync and the local model apply; the panel never touches
// the file.
//
// The shell passes canEdit as a prop (R9): the panel never derives it and
// never imports the file. A read-only file disables every control and keeps
// the values visible.
//
// Deviations from the CLJS original, documented (AD12):
// - Basic segment only: no blend mode, layout, shadows, blur or exports.
// - Gradients and image strokes are read-only rows that can be removed,
//   never edited.
// - Radius uses four inputs for rect/frame, without the single-corner toggle
//   and without the circle case.
// - A multi selection shows its message instead of the mixed-value editing.

import { useRef, useState, useSyncExternalStore, type RefObject } from "react";

import { MinusIcon, PlusIcon } from "@/components/workspace-icons";
import type { WorkspaceCanvasHandle } from "@/components/workspace-wasm-canvas";
import { tr } from "@/lib/i18n";
import type { WorkspaceShape } from "@/lib/workspace";
import {
  addFill,
  addStroke,
  fillsOf,
  isSolidFill,
  isSolidStroke,
  radiusOf,
  removeFill,
  removeStroke,
  shapeBlocked,
  shapeHidden,
  shapeOpacity,
  strokesOf,
  supportsFillStroke,
  withFillColor,
  withFillOpacity,
  withStrokeColor,
  withStrokeOpacity,
  withStrokeWidth,
} from "@/lib/workspace-style";
import {
  getInitialWorkspaceState,
  getWorkspaceState,
  subscribeWorkspace,
} from "@/lib/workspace-store";

export interface WorkspaceStylePanelProps {
  // canEditFile(file) from the shell (R9): the panel never derives it.
  canEdit: boolean;
  canvas: RefObject<WorkspaceCanvasHandle | null>;
}

// <input type="color"> only accepts the six-digit form; a stored color in any
// other notation falls back to black for the swatch.
const FALLBACK_COLOR = "#000000";
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function clampNonNegative(value: number): number {
  return Math.max(0, Number.isFinite(value) ? value : 0);
}

// The 0..100 show of a 0..1 paint opacity; a missing value reads as 1.
function percentOf(value: unknown): number {
  return Math.round((typeof value === "number" ? clamp01(value) : 1) * 100);
}

function parseNumber(raw: string): number | null {
  const value = Number.parseFloat(raw.trim());
  return Number.isFinite(value) ? value : null;
}

function colorOf(value: unknown): string {
  return typeof value === "string" && HEX_COLOR_RE.test(value) ? value : FALLBACK_COLOR;
}

function attrOf(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

// Disambiguate the repeated inputs of a list ("Fill 2", "Opacity 1").
function rowLabel(label: string, index: number): string {
  return `${label} ${index + 1}`;
}

interface DraftFieldProps {
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
function DraftField({
  fieldId,
  value,
  draft,
  disabled,
  type,
  label,
  unit,
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

interface ShapeOptionsProps {
  shape: WorkspaceShape;
  canEdit: boolean;
  canvas: RefObject<WorkspaceCanvasHandle | null>;
}

// The sections of one selected shape. The caller keys this component on the
// shape id, so every selection change drops the drafts, the pending flag and
// the error.
function ShapeOptions({ shape, canEdit, canvas }: ShapeOptionsProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  // The value each field already sent: disabling an input on Enter fires a
  // second blur, which must not send the same value again.
  const sentRef = useRef<Record<string, string>>({});

  const disabled = !canEdit || pending;

  // The one commit path: disable the controls, run the handle and keep the
  // failure inline. The handle never throws for an RPC error, but a bug or a
  // missing canvas still surfaces as the same message.
  const run = async (attrs: Record<string, unknown>): Promise<void> => {
    const handle = canvas.current;
    if (handle === null) {
      setFailed(true);
      return;
    }
    setPending(true);
    setFailed(false);
    try {
      const ok = await handle.updateShapeAttrs(shape.id, attrs);
      if (!ok) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

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

  // Rows shift after an add or a remove, so their drafts would land on the
  // wrong row; drop all of them with the structural change.
  const dropAllDrafts = (): void => {
    sentRef.current = {};
    setDrafts({});
  };

  const commitNow = (attrs: Record<string, unknown>, resetDrafts = false): void => {
    if (resetDrafts) dropAllDrafts();
    void run(attrs);
  };

  // Commit one draft once, then clear it: on success the store shows the new
  // value, on failure it shows the old one again.
  const commitDraft = (
    fieldId: string,
    raw: string | undefined,
    attrs: Record<string, unknown>,
  ): void => {
    if (raw === undefined || sentRef.current[fieldId] === raw) return;
    sentRef.current[fieldId] = raw;
    void run(attrs).finally(() => dropDraft(fieldId));
  };

  // A field whose text does not parse reverts without a commit.
  const isInvalid = (fieldId: string, raw: string | undefined): boolean => {
    if (raw === undefined) return true;
    if (parseNumber(raw) !== null) return false;
    dropDraft(fieldId);
    return true;
  };

  const hidden = shapeHidden(shape);
  const blocked = shapeBlocked(shape);
  const opacity = String(Math.round(shapeOpacity(shape) * 100));
  const fills = fillsOf(shape);
  const strokes = strokesOf(shape);
  const radii = radiusOf(shape);
  const showPaint = supportsFillStroke(shape.type);
  const showRadius = shape.type === "rect" || shape.type === "frame";

  const commitOpacity = (fieldId: string, raw: string | undefined): void => {
    if (isInvalid(fieldId, raw)) return;
    const value = parseNumber(raw as string) as number;
    commitDraft(fieldId, raw, { opacity: clamp01(value / 100) });
  };

  const commitFillColor = (
    index: number,
    fieldId: string,
    raw: string | undefined,
  ): void => {
    if (raw === undefined) return;
    commitDraft(fieldId, raw, {
      fills: withFillColor(fills, index, colorOf(raw)),
    });
  };

  const commitFillOpacity = (
    index: number,
    fieldId: string,
    raw: string | undefined,
  ): void => {
    if (isInvalid(fieldId, raw)) return;
    const value = parseNumber(raw as string) as number;
    commitDraft(fieldId, raw, {
      fills: withFillOpacity(fills, index, clamp01(value / 100)),
    });
  };

  const commitStrokeColor = (
    index: number,
    fieldId: string,
    raw: string | undefined,
  ): void => {
    if (raw === undefined) return;
    commitDraft(fieldId, raw, {
      strokes: withStrokeColor(strokes, index, colorOf(raw)),
    });
  };

  const commitStrokeWidth = (
    index: number,
    fieldId: string,
    raw: string | undefined,
  ): void => {
    if (isInvalid(fieldId, raw)) return;
    const value = parseNumber(raw as string) as number;
    commitDraft(fieldId, raw, {
      strokes: withStrokeWidth(strokes, index, clampNonNegative(value)),
    });
  };

  const commitStrokeOpacity = (
    index: number,
    fieldId: string,
    raw: string | undefined,
  ): void => {
    if (isInvalid(fieldId, raw)) return;
    const value = parseNumber(raw as string) as number;
    commitDraft(fieldId, raw, {
      strokes: withStrokeOpacity(strokes, index, clamp01(value / 100)),
    });
  };

  // Radius sends all four corners together (AD7): one mod-obj, one edit.
  const commitRadius = (
    slot: number,
    fieldId: string,
    raw: string | undefined,
  ): void => {
    if (isInvalid(fieldId, raw)) return;
    const next = [...radii];
    next[slot] = clampNonNegative(parseNumber(raw as string) as number);
    commitDraft(fieldId, raw, {
      r1: next[0],
      r2: next[1],
      r3: next[2],
      r4: next[3],
    });
  };

  return (
    <div className="pp-workspace-style">
      <div className="pp-workspace-style-layer">
        <button
          type="button"
          className="pp-workspace-style-toggle"
          title={hidden ? tr("labels.show") : tr("labels.hide")}
          disabled={disabled}
          onClick={() => commitNow({ hidden: !hidden })}
        >
          {hidden ? tr("labels.show") : tr("labels.hide")}
        </button>
        <button
          type="button"
          className="pp-workspace-style-toggle"
          title={blocked ? tr("labels.unlock") : tr("labels.lock")}
          disabled={disabled}
          onClick={() => commitNow({ blocked: !blocked })}
        >
          {blocked ? tr("labels.unlock") : tr("labels.lock")}
        </button>
      </div>

      {failed ? (
        <p className="pp-workspace-style-error" role="alert">
          {tr("errors.generic")}
        </p>
      ) : null}

      <section className="pp-workspace-style-section">
        <h3 className="pp-workspace-style-title">
          {tr("workspace.options.opacity")}
        </h3>
        <DraftField
          fieldId="opacity"
          type="number"
          label={tr("workspace.options.opacity")}
          value={opacity}
          draft={drafts.opacity}
          disabled={disabled}
          min={0}
          max={100}
          step={1}
          unit="%"
          onDraft={setDraft}
          onCommit={commitOpacity}
          onCancel={dropDraft}
        />
      </section>

      {showPaint ? (
        <section className="pp-workspace-style-section">
          <header className="pp-workspace-style-header">
            <h3 className="pp-workspace-style-title">
              {tr("workspace.options.fill")}
            </h3>
            <button
              type="button"
              className="pp-workspace-style-icon-button"
              aria-label={tr("workspace.options.fill.add-fill")}
              title={tr("workspace.options.fill.add-fill")}
              disabled={disabled}
              onClick={() => commitNow({ fills: addFill(fills) }, true)}
            >
              <PlusIcon />
            </button>
          </header>

          {fills.map((fill, index) => {
            const solid = isSolidFill(fill);
            const colorId = `fill-${index}-color`;
            const opacityId = `fill-${index}-opacity`;
            return (
              <div className="pp-workspace-style-row" key={`fill-${index}`}>
                <DraftField
                  fieldId={colorId}
                  type="color"
                  label={rowLabel(tr("workspace.options.fill"), index)}
                  value={colorOf(attrOf(fill, "fill-color"))}
                  draft={drafts[colorId]}
                  disabled={disabled || !solid}
                  onDraft={setDraft}
                  onCommit={(fieldId, raw) =>
                    commitFillColor(index, fieldId, raw)
                  }
                  onCancel={dropDraft}
                />
                <DraftField
                  fieldId={opacityId}
                  type="number"
                  label={rowLabel(tr("workspace.options.opacity"), index)}
                  value={String(percentOf(attrOf(fill, "fill-opacity")))}
                  draft={drafts[opacityId]}
                  disabled={disabled || !solid}
                  min={0}
                  max={100}
                  step={1}
                  unit="%"
                  onDraft={setDraft}
                  onCommit={(fieldId, raw) =>
                    commitFillOpacity(index, fieldId, raw)
                  }
                  onCancel={dropDraft}
                />
                <button
                  type="button"
                  className="pp-workspace-style-icon-button"
                  aria-label={tr("workspace.options.fill.remove-fill")}
                  title={tr("workspace.options.fill.remove-fill")}
                  disabled={disabled}
                  onClick={() =>
                    commitNow({ fills: removeFill(fills, index) }, true)
                  }
                >
                  <MinusIcon />
                </button>
              </div>
            );
          })}
        </section>
      ) : null}

      {showPaint ? (
        <section className="pp-workspace-style-section">
          <header className="pp-workspace-style-header">
            <h3 className="pp-workspace-style-title">{tr("labels.stroke")}</h3>
            <button
              type="button"
              className="pp-workspace-style-icon-button"
              aria-label={tr("workspace.options.stroke.add-stroke")}
              title={tr("workspace.options.stroke.add-stroke")}
              disabled={disabled}
              onClick={() => commitNow({ strokes: addStroke(strokes) }, true)}
            >
              <PlusIcon />
            </button>
          </header>

          {strokes.map((stroke, index) => {
            const solid = isSolidStroke(stroke);
            const colorId = `stroke-${index}-color`;
            const widthId = `stroke-${index}-width`;
            const opacityId = `stroke-${index}-opacity`;
            return (
              <div
                className="pp-workspace-style-row pp-workspace-style-row--stroke"
                key={`stroke-${index}`}
              >
                <DraftField
                  fieldId={colorId}
                  type="color"
                  label={rowLabel(tr("workspace.options.stroke-color"), index)}
                  value={colorOf(attrOf(stroke, "stroke-color"))}
                  draft={drafts[colorId]}
                  disabled={disabled || !solid}
                  onDraft={setDraft}
                  onCommit={(fieldId, raw) =>
                    commitStrokeColor(index, fieldId, raw)
                  }
                  onCancel={dropDraft}
                />
                <DraftField
                  fieldId={widthId}
                  type="number"
                  label={rowLabel(tr("workspace.options.stroke-width"), index)}
                  value={String(
                    attrOf(stroke, "stroke-width") === undefined
                      ? 1
                      : clampNonNegative(
                          Number(attrOf(stroke, "stroke-width")) || 0,
                        ),
                  )}
                  draft={drafts[widthId]}
                  disabled={disabled || !solid}
                  min={0}
                  step={0.1}
                  onDraft={setDraft}
                  onCommit={(fieldId, raw) =>
                    commitStrokeWidth(index, fieldId, raw)
                  }
                  onCancel={dropDraft}
                />
                <DraftField
                  fieldId={opacityId}
                  type="number"
                  label={rowLabel(tr("workspace.options.opacity"), index)}
                  value={String(percentOf(attrOf(stroke, "stroke-opacity")))}
                  draft={drafts[opacityId]}
                  disabled={disabled || !solid}
                  min={0}
                  max={100}
                  step={1}
                  unit="%"
                  onDraft={setDraft}
                  onCommit={(fieldId, raw) =>
                    commitStrokeOpacity(index, fieldId, raw)
                  }
                  onCancel={dropDraft}
                />
                <button
                  type="button"
                  className="pp-workspace-style-icon-button"
                  aria-label={tr("workspace.options.stroke.remove-stroke")}
                  title={tr("workspace.options.stroke.remove-stroke")}
                  disabled={disabled}
                  onClick={() =>
                    commitNow({ strokes: removeStroke(strokes, index) }, true)
                  }
                >
                  <MinusIcon />
                </button>
              </div>
            );
          })}
        </section>
      ) : null}

      {showRadius ? (
        <section className="pp-workspace-style-section">
          <h3 className="pp-workspace-style-title">
            {tr("workspace.options.radius")}
          </h3>
          <div className="pp-workspace-style-radius">
            {[
              {
                key: "r1",
                label: tr("workspace.options.radius-top-left"),
                value: radii[0],
              },
              {
                key: "r2",
                label: tr("workspace.options.radius-top-right"),
                value: radii[1],
              },
              {
                key: "r3",
                label: tr("workspace.options.radius-bottom-right"),
                value: radii[2],
              },
              {
                key: "r4",
                label: tr("workspace.options.radius-bottom-left"),
                value: radii[3],
              },
            ].map((corner, slot) => (
              <DraftField
                key={corner.key}
                fieldId={`radius-${corner.key}`}
                type="number"
                label={corner.label}
                value={String(corner.value)}
                draft={drafts[`radius-${corner.key}`]}
                disabled={disabled}
                min={0}
                step={0.1}
                onDraft={setDraft}
                onCommit={(fieldId, raw) => commitRadius(slot, fieldId, raw)}
                onCancel={dropDraft}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function WorkspaceStylePanel({
  canEdit,
  canvas,
}: WorkspaceStylePanelProps) {
  const state = useSyncExternalStore(
    subscribeWorkspace,
    getWorkspaceState,
    getInitialWorkspaceState,
  );

  if (state.selection.length === 0) {
    return <p className="pp-workspace-empty">{tr("labels.empty")}</p>;
  }

  if (state.selection.length > 1) {
    return (
      <p className="pp-workspace-empty">
        {tr("inspect.multiple-selected", state.selection.length)}
      </p>
    );
  }

  const id = state.selection[0];
  const shape = state.objects === null ? undefined : state.objects[id];
  if (shape === undefined) {
    return <p className="pp-workspace-empty">{tr("labels.empty")}</p>;
  }

  return (
    <ShapeOptions key={id} shape={shape} canEdit={canEdit} canvas={canvas} />
  );
}
