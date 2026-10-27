"use client";

// The workspace style panel (F9.5, extended by F9.9): the right-sidebar
// options for the selected shapes. Port of the CLJS options toolbox
// (sidebar/options/menus/{measures,layer,fill,stroke,shadow,blur,
// border_radius,layout_container,layout_item,constraints}.cljs): the
// size/position/rotation fields, the layer flags, the layout container and
// layout item menus, the constraints, opacity, fills, strokes, shadows, the
// layer blur and the rect/frame radius. A multi selection swaps the single
// shape sections for components/workspace-multi-options.
//
// A controlled view over the store with local drafts (AD8): text, number and
// color edits keep a draft and commit on blur or Enter; Escape restores the
// store value; the toggles, the selects and add/remove commit at once. Every
// commit goes through the canvas handle (updateShapeAttrs for attributes,
// updateShapeGeometry for the measures fields), which owns the update-file
// envelope, the wasm sync and the local model apply; the panel never touches
// the file.
//
// The shell passes canEdit as a prop (R9): the panel never derives it and
// never imports the file. A read-only file disables every control and keeps
// the values visible.
//
// Deviations from the CLJS original, documented (AD12):
// - No blend mode, grids or exports yet.
// - Gradients and image strokes are read-only rows that can be removed,
//   never edited.
// - Radius uses four inputs for rect/frame, without the single-corner toggle
//   and without the circle case.
// - The measures block has no proportion lock, no frame presets and the
//   layout-driven disabling is partial: it locks x/y for a flow child and
//   the axes an auto or fill sizing owns, from measureLocks. It hides for
//   the types the geometry helpers cannot rewrite (text, svg-raw, blocked
//   shapes).
// - The shadow menu edits one shadow per row with a style select, and the
//   blur menu only knows the layer blur.
// - The multi selection edits the shared values through
//   components/workspace-multi-options and shows the mixed values as the
//   "multiple" placeholder; it has no layer ordering or alignment rows.

import { useState, useSyncExternalStore, type CSSProperties, type RefObject } from "react";

import { MinusIcon, PlusIcon } from "@/components/workspace-icons";
import {
  ConstraintsOptions,
  GridCellOptions,
  LayoutItemOptions,
  LayoutOptions,
  isGridCellParent,
  isLayoutParent,
} from "@/components/workspace-layout-options";
import type { WorkspaceCanvasHandle } from "@/components/workspace-wasm-canvas";
import { WorkspaceMultiOptions } from "@/components/workspace-multi-options";
import {
  DraftField,
  attrOf,
  clamp01,
  clampNonNegative,
  colorOf,
  numberAttr,
  parseNumber,
  percentOf,
  rowLabel,
  useDraftFields,
} from "@/components/workspace-style-field";
import { tr } from "@/lib/i18n";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import {
  MIN_SIZE,
  geometryEditable,
  geometryOf,
  type GeometryTarget,
} from "@/lib/workspace-geometry";
import { measureLocks } from "@/lib/workspace-layout-attrs";
import { isPositionAbsolute } from "@/lib/workspace-layout";
import {
  addBlur,
  addFill,
  addShadow,
  addStroke,
  blurOf,
  fillsOf,
  isSolidFill,
  isSolidStroke,
  radiusOf,
  removeFill,
  removeShadow,
  removeStroke,
  shadowsOf,
  shadowsPatch,
  shapeBlocked,
  shapeHidden,
  shapeOpacity,
  strokesOf,
  supportsFillStroke,
  withBlurHidden,
  withBlurValue,
  withFillColor,
  withFillOpacity,
  withShadowColor,
  withShadowHidden,
  withShadowNumber,
  withShadowOpacity,
  withShadowStyle,
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

interface ShapeOptionsProps {
  shape: WorkspaceShape;
  // The parent record of the shape, for the layout and constraint sections
  // (a missing parent reads as the root board).
  parent: WorkspaceShape | null;
  // The page objects: the grid cell section rebuilds the parent's cell map
  // over its children (F9.12).
  objects: WorkspaceObjects;
  canEdit: boolean;
  canvas: RefObject<WorkspaceCanvasHandle | null>;
}

// The sections of one selected shape. The caller keys this component on the
// shape id, so every selection change drops the drafts, the pending flag and
// the error.
function ShapeOptions({ shape, parent, objects, canEdit, canvas }: ShapeOptionsProps) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const disabled = !canEdit || pending;

  // The one commit path: disable the controls, run the handle action and keep
  // the failure inline. The handle never throws for an RPC error, but a bug
  // or a missing canvas still surfaces as the same message. The action is a
  // closure so the attribute and the geometry commits share it. The answer
  // drives the draft cleanup of useDraftFields.
  const run = async (
    action: (handle: WorkspaceCanvasHandle) => Promise<boolean>,
  ): Promise<boolean> => {
    const handle = canvas.current;
    if (handle === null) {
      setFailed(true);
      return false;
    }
    setPending(true);
    setFailed(false);
    try {
      const ok = await action(handle);
      if (!ok) setFailed(true);
      return ok;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setPending(false);
    }
  };

  const send = (attrs: Record<string, unknown>): Promise<boolean> =>
    run((handle) => handle.updateShapeAttrs(shape.id, attrs));

  // The grid cell section edits the layout frame the child sits in: a cell
  // is part of the frame's layout-grid-cells map, not of the child.
  const sendParent = (attrs: Record<string, unknown>): Promise<boolean> => {
    const frame = parent;
    if (frame === null) return Promise.resolve(false);
    return run((handle) => handle.updateShapeAttrs(frame.id, attrs));
  };

  // The draft bookkeeping is shared with the layout, constraints and
  // multi-selection sections (components/workspace-style-field).
  const { drafts, setDraft, dropDraft, dropAllDrafts, commitDraft, commitAction } =
    useDraftFields(send);

  const commitNow = (attrs: Record<string, unknown>, resetDrafts = false): void => {
    if (resetDrafts) dropAllDrafts();
    void send(attrs);
  };

  // The measures fields take the geometry path: the canvas turns the target
  // into the same world matrix a resize or a rotate gesture builds, so the
  // panel needs no matrix math of its own.
  const commitMeasureDraft = (
    fieldId: string,
    raw: string | undefined,
    target: GeometryTarget,
  ): void => {
    commitAction(fieldId, raw, () =>
      run((handle) => handle.updateShapeGeometry(shape.id, target)),
    );
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
  // The measures block hides for the types the geometry helpers cannot
  // rewrite (text, svg-raw, blocked shapes).
  const geometry = geometryEditable(shape) ? geometryOf(shape) : null;
  const shadows = shadowsOf(shape);
  const blur = blurOf(shape);
  // The flex layout locks the derived measures, like menus/measures.cljs:
  // a flow child has no x/y of its own, and an auto or fill axis is set by
  // the parent.
  const locks = measureLocks(shape, parent);
  const showLayout = shape.type === "frame";
  const showLayoutItem = isLayoutParent(parent);
  // The grid cell menu, for a grid child the layout actually places; an
  // absolute (or hidden) child has no cell to edit.
  const showGridCell = isGridCellParent(parent) && !isPositionAbsolute(shape);

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

  // One measure field. The size fields keep the panel minimum; x/y and the
  // rotation take the typed number (the canvas normalizes the stored
  // rotation into [0, 360)).
  const commitMeasure = (
    fieldId: string,
    raw: string | undefined,
    field: keyof GeometryTarget,
  ): void => {
    if (isInvalid(fieldId, raw)) return;
    const value = parseNumber(raw as string) as number;
    if (field === "width") {
      commitMeasureDraft(fieldId, raw, { width: Math.max(value, MIN_SIZE) });
    } else if (field === "height") {
      commitMeasureDraft(fieldId, raw, { height: Math.max(value, MIN_SIZE) });
    } else if (field === "x") {
      commitMeasureDraft(fieldId, raw, { x: value });
    } else if (field === "y") {
      commitMeasureDraft(fieldId, raw, { y: value });
    } else {
      commitMeasureDraft(fieldId, raw, { rotation: value });
    }
  };

  const commitShadowNumber = (
    index: number,
    fieldId: string,
    raw: string | undefined,
    field: "offset-x" | "offset-y" | "blur" | "spread",
  ): void => {
    if (isInvalid(fieldId, raw)) return;
    commitDraft(fieldId, raw, {
      shadow: withShadowNumber(shadows, index, field, parseNumber(raw as string) as number),
    });
  };

  const commitShadowColor = (
    index: number,
    fieldId: string,
    raw: string | undefined,
  ): void => {
    if (raw === undefined) return;
    commitDraft(fieldId, raw, {
      shadow: withShadowColor(shadows, index, colorOf(raw)),
    });
  };

  const commitShadowOpacity = (
    index: number,
    fieldId: string,
    raw: string | undefined,
  ): void => {
    if (isInvalid(fieldId, raw)) return;
    const value = parseNumber(raw as string) as number;
    commitDraft(fieldId, raw, {
      shadow: withShadowOpacity(shadows, index, clamp01(value / 100)),
    });
  };

  // add-shadow prepends and remove-shadow splices; an empty list commits a
  // nil, which deletes :shadow instead of leaving an empty vector.
  const addShadowRow = (): void => {
    commitNow({ shadow: shadowsPatch(addShadow(shadows, crypto.randomUUID())) }, true);
  };

  const removeShadowRow = (index: number): void => {
    commitNow({ shadow: shadowsPatch(removeShadow(shadows, index)) }, true);
  };

  const commitBlurValue = (fieldId: string, raw: string | undefined): void => {
    if (isInvalid(fieldId, raw)) return;
    if (blur === null) return;
    commitDraft(fieldId, raw, {
      blur: withBlurValue(blur, parseNumber(raw as string) as number),
    });
  };

  // The shape holds one layer blur. Removing sends the nil val that deletes
  // :blur (schema:blur has no empty form).
  const addBlurRow = (): void => {
    commitNow({ blur: addBlur(crypto.randomUUID()) }, true);
  };

  const removeBlurRow = (): void => {
    commitNow({ blur: null }, true);
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

      {geometry === null ? null : (
        <section className="pp-workspace-style-section">
          <div className="pp-workspace-style-grid">
            <DraftField
              fieldId="measure-width"
              type="number"
              label={tr("workspace.options.width")}
              value={String(geometry.width)}
              draft={drafts["measure-width"]}
              disabled={disabled || locks.width}
              min={MIN_SIZE}
              step={1}
              onDraft={setDraft}
              onCommit={(fieldId, raw) => commitMeasure(fieldId, raw, "width")}
              onCancel={dropDraft}
            />
            <DraftField
              fieldId="measure-height"
              type="number"
              label={tr("workspace.options.height")}
              value={String(geometry.height)}
              draft={drafts["measure-height"]}
              disabled={disabled || locks.height}
              min={MIN_SIZE}
              step={1}
              onDraft={setDraft}
              onCommit={(fieldId, raw) => commitMeasure(fieldId, raw, "height")}
              onCancel={dropDraft}
            />
            <DraftField
              fieldId="measure-x"
              type="number"
              label={tr("workspace.options.x")}
              value={String(geometry.x)}
              draft={drafts["measure-x"]}
              disabled={disabled || locks.position}
              step={1}
              onDraft={setDraft}
              onCommit={(fieldId, raw) => commitMeasure(fieldId, raw, "x")}
              onCancel={dropDraft}
            />
            <DraftField
              fieldId="measure-y"
              type="number"
              label={tr("workspace.options.y")}
              value={String(geometry.y)}
              draft={drafts["measure-y"]}
              disabled={disabled || locks.position}
              step={1}
              onDraft={setDraft}
              onCommit={(fieldId, raw) => commitMeasure(fieldId, raw, "y")}
              onCancel={dropDraft}
            />
            <DraftField
              fieldId="measure-rotation"
              type="number"
              label={tr("workspace.options.rotation")}
              value={String(geometry.rotation)}
              draft={drafts["measure-rotation"]}
              disabled={disabled}
              min={-359}
              max={359}
              step={1}
              unit="°"
              onDraft={setDraft}
              onCommit={(fieldId, raw) => commitMeasure(fieldId, raw, "rotation")}
              onCancel={dropDraft}
            />
          </div>
        </section>
      )}

      {showLayout ? (
        <LayoutOptions
          shape={shape}
          parent={parent}
          objects={objects}
          disabled={disabled}
          send={send}
        />
      ) : null}

      {showLayoutItem ? (
        <LayoutItemOptions
          shape={shape}
          parent={parent}
          objects={objects}
          disabled={disabled}
          send={send}
        />
      ) : null}

      {showGridCell && parent !== null ? (
        <GridCellOptions
          shape={shape}
          parent={parent}
          objects={objects}
          disabled={disabled}
          sendParent={sendParent}
        />
      ) : null}

      <ConstraintsOptions
        shape={shape}
        parent={parent}
        objects={objects}
        disabled={disabled}
        send={send}
      />

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

      <section className="pp-workspace-style-section">
        <header className="pp-workspace-style-header">
          <h3 className="pp-workspace-style-title">
            {tr("workspace.options.shadow-options.title")}
          </h3>
          <button
            type="button"
            className="pp-workspace-style-icon-button"
            aria-label={tr("workspace.options.shadow-options.add-shadow")}
            title={tr("workspace.options.shadow-options.add-shadow")}
            disabled={disabled}
            onClick={addShadowRow}
          >
            <PlusIcon />
          </button>
        </header>

        {shadows.map((shadow, index) => {
          const style = attrOf(shadow, "style");
          const color = attrOf(shadow, "color");
          const colorId = `shadow-${index}-color`;
          const opacityId = `shadow-${index}-opacity`;
          const offsetXId = `shadow-${index}-offset-x`;
          const offsetYId = `shadow-${index}-offset-y`;
          const blurId = `shadow-${index}-blur`;
          const spreadId = `shadow-${index}-spread`;
          return (
            <div className="pp-workspace-style-shadow" key={`shadow-${index}`}>
              <div className="pp-workspace-style-shadow-head">
                <select
                  className="pp-workspace-style-select"
                  value={typeof style === "string" ? style : "drop-shadow"}
                  aria-label={rowLabel(
                    tr("workspace.options.shadow-options.title"),
                    index,
                  )}
                  disabled={disabled}
                  onChange={(event) =>
                    commitNow({
                      shadow: withShadowStyle(
                        shadows,
                        index,
                        event.currentTarget.value,
                      ),
                    })
                  }
                >
                  <option value="drop-shadow">
                    {tr("workspace.options.shadow-options.drop-shadow")}
                  </option>
                  <option value="inner-shadow">
                    {tr("workspace.options.shadow-options.inner-shadow")}
                  </option>
                </select>
                <label
                  className="pp-workspace-style-check"
                  title={rowLabel(tr("labels.hide"), index)}
                >
                  <input
                    type="checkbox"
                    checked={attrOf(shadow, "hidden") === true}
                    disabled={disabled}
                    aria-label={rowLabel(tr("labels.hide"), index)}
                    onChange={(event) =>
                      commitNow({
                        shadow: withShadowHidden(
                          shadows,
                          index,
                          event.currentTarget.checked,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="pp-workspace-style-icon-button"
                  aria-label={tr("workspace.options.shadow-options.remove-shadow")}
                  title={tr("workspace.options.shadow-options.remove-shadow")}
                  disabled={disabled}
                  onClick={() => removeShadowRow(index)}
                >
                  <MinusIcon />
                </button>
              </div>
              <div className="pp-workspace-style-grid">
                <DraftField
                  fieldId={colorId}
                  type="color"
                  label={tr("workspace.options.shadow-options.color")}
                  value={colorOf(attrOf(color, "color"))}
                  draft={drafts[colorId]}
                  disabled={disabled}
                  onDraft={setDraft}
                  onCommit={(fieldId, raw) =>
                    commitShadowColor(index, fieldId, raw)
                  }
                  onCancel={dropDraft}
                />
                <DraftField
                  fieldId={opacityId}
                  type="number"
                  label={rowLabel(tr("workspace.options.opacity"), index)}
                  value={String(percentOf(attrOf(color, "opacity")))}
                  draft={drafts[opacityId]}
                  disabled={disabled}
                  min={0}
                  max={100}
                  step={1}
                  unit="%"
                  onDraft={setDraft}
                  onCommit={(fieldId, raw) =>
                    commitShadowOpacity(index, fieldId, raw)
                  }
                  onCancel={dropDraft}
                />
                <DraftField
                  fieldId={offsetXId}
                  type="number"
                  label={rowLabel(
                    tr("workspace.options.shadow-options.offsetx"),
                    index,
                  )}
                  value={String(numberAttr(shadow, "offset-x", 0))}
                  draft={drafts[offsetXId]}
                  disabled={disabled}
                  step={1}
                  onDraft={setDraft}
                  onCommit={(fieldId, raw) =>
                    commitShadowNumber(index, fieldId, raw, "offset-x")
                  }
                  onCancel={dropDraft}
                />
                <DraftField
                  fieldId={offsetYId}
                  type="number"
                  label={rowLabel(
                    tr("workspace.options.shadow-options.offsety"),
                    index,
                  )}
                  value={String(numberAttr(shadow, "offset-y", 0))}
                  draft={drafts[offsetYId]}
                  disabled={disabled}
                  step={1}
                  onDraft={setDraft}
                  onCommit={(fieldId, raw) =>
                    commitShadowNumber(index, fieldId, raw, "offset-y")
                  }
                  onCancel={dropDraft}
                />
                <DraftField
                  fieldId={blurId}
                  type="number"
                  label={rowLabel(
                    tr("workspace.options.shadow-options.blur"),
                    index,
                  )}
                  value={String(numberAttr(shadow, "blur", 0))}
                  draft={drafts[blurId]}
                  disabled={disabled}
                  min={0}
                  step={1}
                  onDraft={setDraft}
                  onCommit={(fieldId, raw) =>
                    commitShadowNumber(index, fieldId, raw, "blur")
                  }
                  onCancel={dropDraft}
                />
                <DraftField
                  fieldId={spreadId}
                  type="number"
                  label={rowLabel(
                    tr("workspace.options.shadow-options.spread"),
                    index,
                  )}
                  value={String(numberAttr(shadow, "spread", 0))}
                  draft={drafts[spreadId]}
                  disabled={disabled}
                  step={1}
                  onDraft={setDraft}
                  onCommit={(fieldId, raw) =>
                    commitShadowNumber(index, fieldId, raw, "spread")
                  }
                  onCancel={dropDraft}
                />
              </div>
            </div>
          );
        })}
      </section>

      <section className="pp-workspace-style-section">
        <header className="pp-workspace-style-header">
          <h3 className="pp-workspace-style-title">{tr("labels.blur")}</h3>
          {blur === null ? (
            <button
              type="button"
              className="pp-workspace-style-icon-button"
              aria-label={tr("workspace.options.blur-options.add-blur")}
              title={tr("workspace.options.blur-options.add-blur")}
              disabled={disabled}
              onClick={addBlurRow}
            >
              <PlusIcon />
            </button>
          ) : null}
        </header>

        {blur === null ? null : (
          <div className="pp-workspace-style-row pp-workspace-style-row--blur">
            <DraftField
              fieldId="blur-value"
              type="number"
              label={tr("workspace.options.blur-options.layer-blur")}
              value={String(numberAttr(blur, "value", 0))}
              draft={drafts["blur-value"]}
              disabled={disabled}
              min={0}
              step={1}
              onDraft={setDraft}
              onCommit={commitBlurValue}
              onCancel={dropDraft}
            />
            <label
              className="pp-workspace-style-check"
              title={tr("workspace.options.blur-options.toggle-blur")}
            >
              <input
                type="checkbox"
                checked={blur["hidden"] === true}
                disabled={disabled}
                aria-label={tr("workspace.options.blur-options.toggle-blur")}
                onChange={(event) =>
                  commitNow({
                    blur: withBlurHidden(blur, event.currentTarget.checked),
                  })
                }
              />
            </label>
            <button
              type="button"
              className="pp-workspace-style-icon-button"
              aria-label={tr("workspace.options.blur-options.remove-blur")}
              title={tr("workspace.options.blur-options.remove-blur")}
              disabled={disabled}
              onClick={removeBlurRow}
            >
              <MinusIcon />
            </button>
          </div>
        )}
      </section>

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

// page.cljs options*: the design tab without a selection shows the two
// page-level color rows (canvas background, pixel grid), each as an
// element-set with a title-bar and a color-row copied from color_row.cljs
// and swatch.cljs.
function WorkspacePageOptions() {
  return (
    <div className="pp-workspace-design-options">
      <section
        className="pp-workspace-element-set"
        aria-label={tr("workspace.options.canvas-background-section")}
      >
        <div className="pp-workspace-element-title">
          <div className="pp-workspace-title-bar">
            <h3 className="pp-workspace-title-only">
              {tr("workspace.options.canvas-background")}
            </h3>
          </div>
        </div>
        <div className="pp-workspace-element-content">
          <div className="pp-workspace-color-info">
            <div className="pp-workspace-color-name-wrapper pp-workspace-color-name-wrapper--no-opacity">
              <div className="pp-workspace-color-bullet-wrapper">
                <div className="pp-workspace-swatch pp-workspace-swatch--small">
                  <div className="pp-workspace-swatch-opacity">
                    <span
                      className="pp-workspace-swatch-solid-side"
                      style={{ backgroundColor: "#E8E9EA" }}
                    />
                    <span
                      className="pp-workspace-swatch-opacity-side pp-workspace-swatch-opacity-side-solid-color"
                      style={{ "--solid-color-overlay": "#E8E9EA" } as CSSProperties}
                    />
                  </div>
                </div>
              </div>
              <div className="pp-workspace-color-input-wrapper">
                <input
                  className="pp-workspace-color-input"
                  value="E8E9EA"
                  readOnly
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="pp-workspace-element-set">
        <div className="pp-workspace-element-title">
          <div className="pp-workspace-title-bar">
            <h3 className="pp-workspace-title-only">
              {tr("workspace.options.pixel-grid-color")}
            </h3>
          </div>
        </div>
        <div className="pp-workspace-element-content">
          <div className="pp-workspace-color-info">
            <div className="pp-workspace-color-name-wrapper">
              <div className="pp-workspace-color-bullet-wrapper">
                <div className="pp-workspace-swatch pp-workspace-swatch--small">
                  <div className="pp-workspace-swatch-opacity">
                    <span
                      className="pp-workspace-swatch-solid-side"
                      style={{ backgroundColor: "#0070E4" }}
                    />
                    <span
                      className="pp-workspace-swatch-opacity-side pp-workspace-swatch-opacity-side-transparency"
                      style={
                        { "--solid-color-overlay": "rgba(0, 112, 228, 0.2)" } as CSSProperties
                      }
                    />
                  </div>
                </div>
              </div>
              <div className="pp-workspace-color-input-wrapper">
                <input
                  className="pp-workspace-color-input"
                  value="0070E4"
                  readOnly
                />
              </div>
            </div>
            <div className="pp-workspace-opacity-element-wrapper">
              <span className="pp-workspace-icon-text">%</span>
              <input className="pp-workspace-opacity-input" value="20" readOnly />
            </div>
          </div>
        </div>
      </section>
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
    return <WorkspacePageOptions />;
  }

  if (state.selection.length > 1) {
    if (state.objects === null) {
      return <p className="pp-workspace-empty">{tr("labels.empty")}</p>;
    }
    return (
      <WorkspaceMultiOptions
        ids={state.selection}
        objects={state.objects}
        canEdit={canEdit}
        canvas={canvas}
      />
    );
  }

  const id = state.selection[0];
  const objects = state.objects;
  if (objects === null) {
    return <p className="pp-workspace-empty">{tr("labels.empty")}</p>;
  }
  const shape = objects[id];
  if (shape === undefined) {
    return <p className="pp-workspace-empty">{tr("labels.empty")}</p>;
  }

  const parentId = shape["parent-id"];
  const parent =
    typeof parentId !== "string" ? null : (objects[parentId] ?? null);

  return (
    <ShapeOptions
      key={id}
      shape={shape}
      parent={parent}
      objects={objects}
      canEdit={canEdit}
      canvas={canvas}
    />
  );
}
