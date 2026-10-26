"use client";

// The multi-selection options of the workspace style panel (F9.9). Replaces
// the "N selected" message with the batch editing menus the CLJS multi
// selection shows (shapes/multiple.cljs): the layer flags, opacity, radius,
// shadow, blur, constraints and the layout-item sizing.
//
// A value the shapes disagree on reads as "Mixed": the field empties and
// shows the shared catalog placeholder, and a select shows a disabled mixed
// option. Every edit builds one ShapeUpdate per shape (lib/workspace-multi)
// and the canvas commits the whole batch in one update-file call.
//
// Deviations from the CLJS original, documented:
// - The batch edits the attributes the single-shape panel already covers;
//   fills, strokes and the per-shadow or per-blur rows stay single-shape.
// - The constraints of each shape keep their defaults, so the select shows a
//   value even when the attribute is not stored yet.

import { useState, type RefObject } from "react";

import { MinusIcon, PlusIcon } from "@/components/workspace-icons";
import {
  DraftField,
  SelectField,
  parseNumber,
} from "@/components/workspace-style-field";
import type { WorkspaceCanvasHandle } from "@/components/workspace-wasm-canvas";
import { tr } from "@/lib/i18n";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import { isAnyLayout } from "@/lib/workspace-layout";
import {
  constraintsOf,
  inFrameForConstraints,
  layoutItemValues,
} from "@/lib/workspace-layout-attrs";
import {
  blurAddUpdates,
  blurClearUpdates,
  constraintUpdates,
  flagUpdates,
  opacityUpdates,
  radiusUpdates,
  shadowAddUpdates,
  shadowClearUpdates,
  sharedFlag,
  sharedValue,
  sizingUpdates,
  type ShapeUpdate,
} from "@/lib/workspace-multi";
import { radiusOf, shapeOpacity, shadowsOf } from "@/lib/workspace-style";

export interface WorkspaceMultiOptionsProps {
  ids: readonly string[];
  objects: WorkspaceObjects;
  canEdit: boolean;
  canvas: RefObject<WorkspaceCanvasHandle | null>;
}

const SIZING_OPTIONS = [{ value: "fix" }, { value: "auto" }, { value: "fill" }];

export function WorkspaceMultiOptions({
  ids,
  objects,
  canEdit,
  canvas,
}: WorkspaceMultiOptionsProps) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [opacityDraft, setOpacityDraft] = useState<string | undefined>(undefined);
  const [radiusDraft, setRadiusDraft] = useState<string | undefined>(undefined);

  const shapes: WorkspaceShape[] = [];
  for (const id of ids) {
    const shape = objects[id];
    if (shape !== undefined && shape !== null) shapes.push(shape);
  }

  if (shapes.length === 0) {
    return <p className="pp-workspace-empty">{tr("labels.empty")}</p>;
  }

  const disabled = !canEdit || pending;

  const run = async (updates: readonly ShapeUpdate[]): Promise<void> => {
    if (updates.length === 0) return;
    const handle = canvas.current;
    if (handle === null) {
      setFailed(true);
      return;
    }
    setPending(true);
    setFailed(false);
    try {
      const ok = await handle.updateShapesAttrs(updates);
      if (!ok) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  const parentOf = (shape: WorkspaceShape): WorkspaceShape | null => {
    const parentId = shape["parent-id"];
    if (typeof parentId !== "string") return null;
    return objects[parentId] ?? null;
  };

  // The flags: undefined means mixed, which the button treats as off.
  const hidden = sharedFlag(shapes, "hidden");
  const blocked = sharedFlag(shapes, "blocked");

  // Opacity and radius share a value only when every shape agrees.
  const opacity = sharedValue(shapes, shapeOpacity);
  const radiusShapes = shapes.filter(
    (shape) => shape.type === "rect" || shape.type === "frame",
  );
  const radius = sharedValue(radiusShapes, (shape) => {
    const corners = radiusOf(shape);
    return corners.every((value) => value === corners[0]) ? corners[0] : null;
  });

  const constraintShapes = shapes.filter(inFrameForConstraints);
  const sharedConstraintH = sharedValue(constraintShapes, (shape) =>
    constraintsOf(shape, parentOf(shape)).h,
  );
  const sharedConstraintV = sharedValue(constraintShapes, (shape) =>
    constraintsOf(shape, parentOf(shape)).v,
  );

  const layoutShapes = shapes.filter((shape) => isAnyLayout(parentOf(shape)));
  const sharedSizingH = sharedValue(
    layoutShapes,
    (shape) => layoutItemValues(shape).hSizing,
  );
  const sharedSizingV = sharedValue(
    layoutShapes,
    (shape) => layoutItemValues(shape).vSizing,
  );

  const canClearShadow = shapes.some((shape) => shadowsOf(shape).length > 0);
  const canClearBlur = shapes.some(
    (shape) => shape.blur !== null && shape.blur !== undefined,
  );

  const commitOpacity = (raw: string | undefined): void => {
    setOpacityDraft(undefined);
    const value = raw === undefined ? null : parseNumber(raw);
    if (value === null) return;
    void run(opacityUpdates(shapes, value / 100));
  };

  const commitRadius = (raw: string | undefined): void => {
    setRadiusDraft(undefined);
    const value = raw === undefined ? null : parseNumber(raw);
    if (value === null) return;
    void run(radiusUpdates(radiusShapes, value));
  };

  const mixed = tr("settings.multiple");

  return (
    <div className="pp-workspace-style">
      <h3 className="pp-workspace-style-title">
        {tr("inspect.multiple-selected", shapes.length)}
      </h3>

      <div className="pp-workspace-style-layer">
        <button
          type="button"
          className="pp-workspace-style-toggle"
          title={hidden === true ? tr("labels.show") : tr("labels.hide")}
          disabled={disabled}
          onClick={() => void run(flagUpdates(shapes, "hidden", hidden !== true))}
        >
          {hidden === true ? tr("labels.show") : tr("labels.hide")}
        </button>
        <button
          type="button"
          className="pp-workspace-style-toggle"
          title={blocked === true ? tr("labels.unlock") : tr("labels.lock")}
          disabled={disabled}
          onClick={() => void run(flagUpdates(shapes, "blocked", blocked !== true))}
        >
          {blocked === true ? tr("labels.unlock") : tr("labels.lock")}
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
          fieldId="multi-opacity"
          type="number"
          label={tr("workspace.options.opacity")}
          value={opacity === undefined ? "" : String(Math.round(opacity * 100))}
          draft={opacityDraft}
          placeholder={mixed}
          disabled={disabled}
          min={0}
          max={100}
          step={1}
          unit="%"
          onDraft={(_, value) => setOpacityDraft(value)}
          onCommit={(_, raw) => commitOpacity(raw)}
          onCancel={() => setOpacityDraft(undefined)}
        />
      </section>

      {radiusShapes.length === 0 ? null : (
        <section className="pp-workspace-style-section">
          <h3 className="pp-workspace-style-title">
            {tr("workspace.options.radius")}
          </h3>
          <DraftField
            fieldId="multi-radius"
            type="number"
            label={tr("workspace.options.radius")}
            value={radius === undefined || radius === null ? "" : String(radius)}
            draft={radiusDraft}
            placeholder={mixed}
            disabled={disabled}
            min={0}
            step={0.1}
            onDraft={(_, value) => setRadiusDraft(value)}
            onCommit={(_, raw) => commitRadius(raw)}
            onCancel={() => setRadiusDraft(undefined)}
          />
        </section>
      )}

      <section className="pp-workspace-style-section">
        <header className="pp-workspace-style-header">
          <h3 className="pp-workspace-style-title">
            {tr("workspace.options.shadow-options.title")}
          </h3>
          <span className="pp-workspace-style-actions">
            <button
              type="button"
              className="pp-workspace-style-icon-button"
              aria-label={tr("workspace.options.shadow-options.add-shadow")}
              title={tr("workspace.options.shadow-options.add-shadow")}
              disabled={disabled}
              onClick={() =>
                void run(shadowAddUpdates(shapes, () => crypto.randomUUID()))
              }
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className="pp-workspace-style-icon-button"
              aria-label={tr("workspace.options.shadow-options.remove-shadow")}
              title={tr("workspace.options.shadow-options.remove-shadow")}
              disabled={disabled || !canClearShadow}
              onClick={() => void run(shadowClearUpdates(shapes))}
            >
              <MinusIcon />
            </button>
          </span>
        </header>
      </section>

      <section className="pp-workspace-style-section">
        <header className="pp-workspace-style-header">
          <h3 className="pp-workspace-style-title">{tr("labels.blur")}</h3>
          <span className="pp-workspace-style-actions">
            <button
              type="button"
              className="pp-workspace-style-icon-button"
              aria-label={tr("workspace.options.blur-options.add-blur")}
              title={tr("workspace.options.blur-options.add-blur")}
              disabled={disabled}
              onClick={() =>
                void run(blurAddUpdates(shapes, () => crypto.randomUUID()))
              }
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className="pp-workspace-style-icon-button"
              aria-label={tr("workspace.options.blur-options.remove-blur")}
              title={tr("workspace.options.blur-options.remove-blur")}
              disabled={disabled || !canClearBlur}
              onClick={() => void run(blurClearUpdates(shapes))}
            >
              <MinusIcon />
            </button>
          </span>
        </header>
      </section>

      {constraintShapes.length === 0 ? null : (
        <section className="pp-workspace-style-section">
          <h3 className="pp-workspace-style-title">
            {tr("workspace.options.constraints")}
          </h3>
          <div className="pp-workspace-style-grid">
            <SelectField
              label="Horizontal"
              value={sharedConstraintH ?? ""}
              options={[
                { value: "left", label: tr("workspace.options.constraints.left") },
                { value: "right", label: tr("workspace.options.constraints.right") },
                {
                  value: "leftright",
                  label: tr("workspace.options.constraints.leftright"),
                },
                {
                  value: "center",
                  label: tr("workspace.options.constraints.center"),
                },
                { value: "scale", label: tr("workspace.options.constraints.scale") },
              ]}
              disabled={disabled}
              mixedLabel={mixed}
              onChange={(next) => void run(constraintUpdates(shapes, next, null))}
            />
            <SelectField
              label="Vertical"
              value={sharedConstraintV ?? ""}
              options={[
                { value: "top", label: tr("workspace.options.constraints.top") },
                { value: "bottom", label: tr("workspace.options.constraints.bottom") },
                {
                  value: "topbottom",
                  label: tr("workspace.options.constraints.topbottom"),
                },
                {
                  value: "center",
                  label: tr("workspace.options.constraints.center"),
                },
                { value: "scale", label: tr("workspace.options.constraints.scale") },
              ]}
              disabled={disabled}
              mixedLabel={mixed}
              onChange={(next) => void run(constraintUpdates(shapes, null, next))}
            />
          </div>
        </section>
      )}

      {layoutShapes.length === 0 ? null : (
        <section className="pp-workspace-style-section">
          <h3 className="pp-workspace-style-title">Layout item</h3>
          <div className="pp-workspace-style-grid">
            <SelectField
              label={tr("workspace.options.width")}
              value={sharedSizingH ?? ""}
              options={SIZING_OPTIONS}
              disabled={disabled}
              mixedLabel={mixed}
              onChange={(next) => void run(sizingUpdates(layoutShapes, next, null))}
            />
            <SelectField
              label={tr("workspace.options.height")}
              value={sharedSizingV ?? ""}
              options={SIZING_OPTIONS}
              disabled={disabled}
              mixedLabel={mixed}
              onChange={(next) => void run(sizingUpdates(layoutShapes, null, next))}
            />
          </div>
        </section>
      )}
    </div>
  );
}
