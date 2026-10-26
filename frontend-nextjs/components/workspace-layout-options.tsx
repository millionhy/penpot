"use client";

// The layout, layout-item and constraints sections of the workspace style
// panel (F9.9). Port of the CLJS menus layout_container.cljs,
// layout_item.cljs and constraints.cljs, reduced to the attributes the shell
// can edit today.
//
// Each section keeps its own drafts through useDraftFields, so a text edit
// commits on blur or Enter and a select or a checkbox commits at once, the
// same rule the single-shape sections follow. The caller passes `send`, the
// canvas commit of one shape; the panel owns the pending flag and the error.
//
// Deviations from the CLJS original, documented:
// - The enum titles are hardcoded English, like the layout_container.cljs
//   titles (the CLJS panel renders most of them as icon titles). The shared
//   po files carry no keys for these enums, so the values are also the
//   visible labels.
// - No grid cell editing and no "edit grid" mode: the grid section edits the
//   direction, the alignment, the gap, the padding and the track lists.
// - The layout-item menu edits the sizing, the margin, the min/max sizes,
//   align-self and the absolute flag; the z-index input is not ported.
// - A layout or a constraint change is stored and uploaded, but the client
//   does not reflow: see lib/workspace-layout-attrs and lib/workspace-transform
//   for the two documented limits.

import { MinusIcon, PlusIcon } from "@/components/workspace-icons";
import {
  DraftField,
  SelectField,
  parseNumber,
  useDraftFields,
} from "@/components/workspace-style-field";
import { tr } from "@/lib/i18n";
import type { WorkspaceShape } from "@/lib/workspace";
import { isAnyLayout } from "@/lib/workspace-layout";
import {
  ALIGN_CONTENT,
  ALIGN_ITEMS,
  ALIGN_SELF,
  FLEX_DIRECTIONS,
  GAP_TYPES,
  GRID_DIRECTIONS,
  JUSTIFY_CONTENT,
  JUSTIFY_ITEMS,
  PADDING_TYPES,
  SIZING,
  TRACK_TYPES,
  constraintPatch,
  constraintsOf,
  defaultTrack,
  fixedScrollVisible,
  gapPatch,
  inFrameForConstraints,
  layoutItemValues,
  layoutPatch,
  layoutValues,
  marginPatch,
  paddingPatch,
  removeLayoutPatch,
  simpleQuad,
  trackPatch,
  tracksPatch,
  type GridTrack,
  type LayoutKind,
} from "@/lib/workspace-layout-attrs";

export interface LayoutSectionProps {
  shape: WorkspaceShape;
  parent: WorkspaceShape | null;
  disabled: boolean;
  // The attribute commit of the shape (one mod-obj); the section never
  // touches the file.
  send: (attrs: Record<string, unknown>) => Promise<boolean>;
}

function enumOptions(values: readonly string[]) {
  return values.map((value) => ({ value }));
}

// The four sides of a multiple padding/margin, in the CLJS order. The tr
// calls stay static so the translation extractor sees the keys (a computed
// key would fall back to the raw msgid at runtime).
function quadLabels(): readonly string[] {
  return [
    tr("workspace.layout-grid.editor.padding.top"),
    tr("workspace.layout-grid.editor.padding.right"),
    tr("workspace.layout-grid.editor.padding.bottom"),
    tr("workspace.layout-grid.editor.padding.left"),
  ];
}

export function LayoutOptions({ shape, disabled, send }: LayoutSectionProps) {
  const values = layoutValues(shape);
  const { drafts, setDraft, dropDraft, dropAllDrafts, commitDraft } =
    useDraftFields(send);

  // A structural change (add, remove, kind switch) shifts the rows, so every
  // draft goes with it.
  const commitStructural = (attrs: Record<string, unknown>): void => {
    dropAllDrafts();
    void send(attrs);
  };

  const commitGap = (
    fieldId: string,
    raw: string | undefined,
    slot: "row" | "column",
  ): void => {
    const value = parseNumber(raw ?? "");
    if (value === null) {
      dropDraft(fieldId);
      return;
    }
    commitDraft(
      fieldId,
      raw,
      gapPatch(
        values.gapType,
        slot === "row" ? value : values.rowGap,
        slot === "column" ? value : values.columnGap,
      ),
    );
  };

  const commitPadding = (
    fieldId: string,
    raw: string | undefined,
    slot: 0 | 1 | 2 | 3,
    pair = false,
  ): void => {
    const value = parseNumber(raw ?? "");
    if (value === null) {
      dropDraft(fieldId);
      return;
    }
    const quad = [...values.padding] as [number, number, number, number];
    if (pair) {
      // The simple mode edits vertical (slots 0 and 2) or horizontal
      // (slots 1 and 3) together.
      quad[slot] = value;
      quad[slot + 2] = value;
      commitDraft(fieldId, raw, paddingPatch(values.paddingType, quad));
      return;
    }
    quad[slot] = value;
    commitDraft(fieldId, raw, paddingPatch(values.paddingType, quad));
  };

  // The kind switch reinitializes the layout, like get-layout-initializer.
  const rows = values.rows;
  const columns = values.columns;

  const commitTrackValue = (
    axis: "rows" | "columns",
    index: number,
    fieldId: string,
    raw: string | undefined,
  ): void => {
    const value = parseNumber(raw ?? "");
    if (value === null) {
      dropDraft(fieldId);
      return;
    }
    const tracks = (axis === "rows" ? rows : columns).map((track, position) =>
      position === index ? trackPatch(track.type, Math.max(0, value)) : track,
    );
    commitDraft(fieldId, raw, tracksPatch(axis, tracks));
  };

  const changeTrackType = (
    axis: "rows" | "columns",
    index: number,
    type: string,
  ): void => {
    dropAllDrafts();
    const tracks = (axis === "rows" ? rows : columns).map((track, position) =>
      position === index
        ? trackPatch(type, track.value === undefined ? 1 : track.value)
        : track,
    );
    void send(tracksPatch(axis, tracks));
  };

  const addTrack = (axis: "rows" | "columns"): void => {
    const tracks: GridTrack[] = [...(axis === "rows" ? rows : columns), defaultTrack()];
    commitStructural(tracksPatch(axis, tracks));
  };

  const removeTrack = (axis: "rows" | "columns", index: number): void => {
    const tracks = (axis === "rows" ? rows : columns).filter(
      (_, position) => position !== index,
    );
    commitStructural(tracksPatch(axis, tracks));
  };

  if (values.kind === null) {
    return (
      <section className="pp-workspace-style-section">
        <h3 className="pp-workspace-style-title">{tr("labels.layout")}</h3>
        <div className="pp-workspace-style-layer">
          <button
            type="button"
            className="pp-workspace-style-toggle"
            title={tr("labels.flex-layout")}
            disabled={disabled}
            onClick={() => commitStructural(layoutPatch("flex"))}
          >
            {tr("labels.flex-layout")}
          </button>
          <button
            type="button"
            className="pp-workspace-style-toggle"
            title={tr("labels.grid-layout")}
            disabled={disabled}
            onClick={() => commitStructural(layoutPatch("grid"))}
          >
            {tr("labels.grid-layout")}
          </button>
        </div>
      </section>
    );
  }

  const kind: LayoutKind = values.kind;
  const grid = kind === "grid";
  const directions = grid ? GRID_DIRECTIONS : FLEX_DIRECTIONS;

  return (
    <section className="pp-workspace-style-section">
      <header className="pp-workspace-style-header">
        <h3 className="pp-workspace-style-title">{tr("labels.layout")}</h3>
        <button
          type="button"
          className="pp-workspace-style-icon-button"
          aria-label={tr("workspace.shape.menu.remove-layout")}
          title={tr("workspace.shape.menu.remove-layout")}
          disabled={disabled}
          onClick={() => commitStructural(removeLayoutPatch())}
        >
          <MinusIcon />
        </button>
      </header>

      <div className="pp-workspace-style-grid">
        <SelectField
          label={tr("labels.layout")}
          value={kind}
          options={[
            { value: "flex", label: tr("labels.flex-layout") },
            { value: "grid", label: tr("labels.grid-layout") },
          ]}
          disabled={disabled}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) => commitStructural(layoutPatch(next as LayoutKind))}
        />
        <SelectField
          label="Direction"
          value={values.direction}
          options={enumOptions(directions)}
          disabled={disabled}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) =>
            void send({
              [grid ? "layout-grid-dir" : "layout-flex-dir"]: next,
            })
          }
        />
        <SelectField
          label="Align items"
          value={values.alignItems}
          options={enumOptions(ALIGN_ITEMS)}
          disabled={disabled}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) => void send({ "layout-align-items": next })}
        />
        {grid ? (
          <SelectField
            label="Justify items"
            value={values.justifyItems}
            options={enumOptions(JUSTIFY_ITEMS)}
            disabled={disabled}
            mixedLabel={tr("settings.multiple")}
            onChange={(next) => void send({ "layout-justify-items": next })}
          />
        ) : (
          <SelectField
            label="Wrap"
            value={values.wrap}
            options={enumOptions(["wrap", "nowrap"])}
            disabled={disabled}
            mixedLabel={tr("settings.multiple")}
            onChange={(next) => void send({ "layout-wrap-type": next })}
          />
        )}
        <SelectField
          label="Align content"
          value={values.alignContent}
          options={enumOptions(ALIGN_CONTENT)}
          disabled={disabled}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) => void send({ "layout-align-content": next })}
        />
        <SelectField
          label="Justify content"
          value={values.justifyContent}
          options={enumOptions(JUSTIFY_CONTENT)}
          disabled={disabled}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) => void send({ "layout-justify-content": next })}
        />
      </div>

      <div className="pp-workspace-style-grid">
        <SelectField
          label={tr("workspace.options.stroke-gap")}
          value={values.gapType}
          options={enumOptions(GAP_TYPES)}
          disabled={disabled}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) => {
            dropAllDrafts();
            void send(gapPatch(next, values.rowGap, values.columnGap));
          }}
        />
        {values.gapType === "multiple" ? (
          <>
            <DraftField
              fieldId="gap-row"
              type="number"
              label={tr("workspace.layout-grid.editor.padding.vertical")}
              value={String(values.rowGap)}
              draft={drafts["gap-row"]}
              disabled={disabled}
              min={0}
              step={1}
              onDraft={setDraft}
              onCommit={(fieldId, raw) => commitGap(fieldId, raw, "row")}
              onCancel={dropDraft}
            />
            <DraftField
              fieldId="gap-column"
              type="number"
              label={tr("workspace.layout-grid.editor.padding.horizontal")}
              value={String(values.columnGap)}
              draft={drafts["gap-column"]}
              disabled={disabled}
              min={0}
              step={1}
              onDraft={setDraft}
              onCommit={(fieldId, raw) => commitGap(fieldId, raw, "column")}
              onCancel={dropDraft}
            />
          </>
        ) : (
          <DraftField
            fieldId="gap-simple"
            type="number"
            label={tr("workspace.options.stroke-gap")}
            value={String(values.rowGap)}
            draft={drafts["gap-simple"]}
            disabled={disabled}
            min={0}
            step={1}
            onDraft={setDraft}
            onCommit={(fieldId, raw) => commitGap(fieldId, raw, "row")}
            onCancel={dropDraft}
          />
        )}
      </div>

      <div className="pp-workspace-style-grid">
        <SelectField
          label="Padding type"
          value={values.paddingType}
          options={enumOptions(PADDING_TYPES)}
          disabled={disabled}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) => {
            commitStructural(
              paddingPatch(next, simpleQuad(values.padding[0], values.padding[1])),
            );
          }}
        />
        {values.paddingType === "multiple" ? (
          <>
            {quadLabels().map((label, slot) => (
              <DraftField
                key={label}
                fieldId={`padding-${slot}`}
                type="number"
                label={label}
                value={String(values.padding[slot])}
                draft={drafts[`padding-${slot}`]}
                disabled={disabled}
                min={0}
                step={1}
                onDraft={setDraft}
                onCommit={(fieldId, raw) =>
                  commitPadding(fieldId, raw, slot as 0 | 1 | 2 | 3)
                }
                onCancel={dropDraft}
              />
            ))}
          </>
        ) : (
          <>
            <DraftField
              fieldId="padding-vertical"
              type="number"
              label={tr("workspace.layout-grid.editor.padding.vertical")}
              value={String(values.padding[0])}
              draft={drafts["padding-vertical"]}
              disabled={disabled}
              min={0}
              step={1}
              onDraft={setDraft}
              onCommit={(fieldId, raw) => commitPadding(fieldId, raw, 0, true)}
              onCancel={dropDraft}
            />
            <DraftField
              fieldId="padding-horizontal"
              type="number"
              label={tr("workspace.layout-grid.editor.padding.horizontal")}
              value={String(values.padding[1])}
              draft={drafts["padding-horizontal"]}
              disabled={disabled}
              min={0}
              step={1}
              onDraft={setDraft}
              onCommit={(fieldId, raw) => commitPadding(fieldId, raw, 1, true)}
              onCancel={dropDraft}
            />
          </>
        )}
      </div>

      {grid ? (
        <div className="pp-workspace-style-tracks">
          {(["rows", "columns"] as const).map((axis) => {
            const tracks = axis === "rows" ? rows : columns;
            return (
              <div className="pp-workspace-style-track" key={axis}>
                <header className="pp-workspace-style-header">
                  <h4 className="pp-workspace-style-title">
                    {axis === "rows" ? "Rows" : "Columns"}
                  </h4>
                  <button
                    type="button"
                    className="pp-workspace-style-icon-button"
                    aria-label={`Add ${axis === "rows" ? "row" : "column"}`}
                    title={`Add ${axis === "rows" ? "row" : "column"}`}
                    disabled={disabled}
                    onClick={() => addTrack(axis)}
                  >
                    <PlusIcon />
                  </button>
                </header>
                {tracks.map((track, index) => (
                  <div
                    className="pp-workspace-style-row pp-workspace-style-row--track"
                    key={`${axis}-${index}`}
                  >
                    <SelectField
                      label={axis === "rows" ? "Row size" : "Column size"}
                      value={track.type}
                      options={enumOptions(TRACK_TYPES)}
                      disabled={disabled}
                      mixedLabel={tr("settings.multiple")}
                      onChange={(next) => changeTrackType(axis, index, next)}
                    />
                    {track.type === "auto" ? (
                      <span className="pp-workspace-style-label">Auto</span>
                    ) : (
                      <DraftField
                        fieldId={`track-${axis}-${index}`}
                        type="number"
                        label={axis === "rows" ? "Row value" : "Column value"}
                        value={String(track.value ?? 1)}
                        draft={drafts[`track-${axis}-${index}`]}
                        disabled={disabled}
                        min={0}
                        step={1}
                        onDraft={setDraft}
                        onCommit={(fieldId, raw) =>
                          commitTrackValue(axis, index, fieldId, raw)
                        }
                        onCancel={dropDraft}
                      />
                    )}
                    <button
                      type="button"
                      className="pp-workspace-style-icon-button"
                      aria-label={`Remove ${axis === "rows" ? "row" : "column"}`}
                      title={`Remove ${axis === "rows" ? "row" : "column"}`}
                      disabled={disabled}
                      onClick={() => removeTrack(axis, index)}
                    >
                      <MinusIcon />
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

export function LayoutItemOptions({
  shape,
  disabled,
  send,
}: LayoutSectionProps) {
  const values = layoutItemValues(shape);
  const { drafts, setDraft, dropDraft, commitDraft } = useDraftFields(send);

  const commitSizing = (axis: "h" | "v", value: string): void => {
    void send({ [axis === "h" ? "layout-item-h-sizing" : "layout-item-v-sizing"]: value });
  };

  const commitMargin = (
    fieldId: string,
    raw: string | undefined,
    slot: 0 | 1 | 2 | 3,
    pair = false,
  ): void => {
    const value = parseNumber(raw ?? "");
    if (value === null) {
      dropDraft(fieldId);
      return;
    }
    const quad = [...values.margin] as [number, number, number, number];
    if (pair) {
      quad[slot] = value;
      quad[slot + 2] = value;
    } else {
      quad[slot] = value;
    }
    commitDraft(fieldId, raw, marginPatch(values.marginType, quad));
  };

  // A min/max field: empty deletes the attribute (the schema leaves it
  // optional), a number sets it.
  const commitBound = (
    fieldId: string,
    raw: string | undefined,
    attr: "layout-item-min-w" | "layout-item-min-h" | "layout-item-max-w" | "layout-item-max-h",
  ): void => {
    if (raw === undefined) return;
    if (raw.trim() === "") {
      commitDraft(fieldId, raw, { [attr]: null });
      return;
    }
    const value = parseNumber(raw);
    if (value === null) {
      dropDraft(fieldId);
      return;
    }
    commitDraft(fieldId, raw, { [attr]: Math.max(0, value) });
  };

  const boundFields = [
    {
      fieldId: "layout-item-min-w",
      label: tr("workspace.options.layout-item.layout-item-min-w"),
      value: values.minW,
      attr: "layout-item-min-w" as const,
    },
    {
      fieldId: "layout-item-min-h",
      label: tr("workspace.options.layout-item.layout-item-min-h"),
      value: values.minH,
      attr: "layout-item-min-h" as const,
    },
    {
      fieldId: "layout-item-max-w",
      label: tr("workspace.options.layout-item.layout-item-max-w"),
      value: values.maxW,
      attr: "layout-item-max-w" as const,
    },
    {
      fieldId: "layout-item-max-h",
      label: tr("workspace.options.layout-item.layout-item-max-h"),
      value: values.maxH,
      attr: "layout-item-max-h" as const,
    },
  ];

  return (
    <section className="pp-workspace-style-section">
      <h3 className="pp-workspace-style-title">Layout item</h3>

      <div className="pp-workspace-style-grid">
        <SelectField
          label={tr("workspace.options.width")}
          value={values.hSizing}
          options={enumOptions(SIZING)}
          disabled={disabled}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) => commitSizing("h", next)}
        />
        <SelectField
          label={tr("workspace.options.height")}
          value={values.vSizing}
          options={enumOptions(SIZING)}
          disabled={disabled}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) => commitSizing("v", next)}
        />
        <SelectField
          label="Align self"
          value={values.alignSelf}
          options={enumOptions(ALIGN_SELF)}
          disabled={disabled}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) => void send({ "layout-item-align-self": next })}
        />
        <label
          className="pp-workspace-style-check pp-workspace-style-check--labeled"
          title="Absolute"
        >
          <input
            type="checkbox"
            checked={values.absolute}
            disabled={disabled}
            aria-label="Absolute"
            onChange={(event) =>
              void send({ "layout-item-absolute": event.currentTarget.checked })
            }
          />
          <span className="pp-workspace-style-label">Absolute</span>
        </label>
      </div>

      <div className="pp-workspace-style-grid">
        <SelectField
          label={tr("workspace.options.grid.params.margin")}
          value={values.marginType}
          options={enumOptions(PADDING_TYPES)}
          disabled={disabled}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) => {
            void send(marginPatch(next, values.margin));
          }}
        />
        {values.marginType === "multiple" ? (
          <>
            {quadLabels().map((label, slot) => (
              <DraftField
                key={label}
                fieldId={`margin-${slot}`}
                type="number"
                label={label}
                value={String(values.margin[slot])}
                draft={drafts[`margin-${slot}`]}
                disabled={disabled}
                step={1}
                onDraft={setDraft}
                onCommit={(fieldId, raw) =>
                  commitMargin(fieldId, raw, slot as 0 | 1 | 2 | 3)
                }
                onCancel={dropDraft}
              />
            ))}
          </>
        ) : (
          <>
            <DraftField
              fieldId="margin-vertical"
              type="number"
              label={tr("workspace.layout-grid.editor.padding.vertical")}
              value={String(values.margin[0])}
              draft={drafts["margin-vertical"]}
              disabled={disabled}
              step={1}
              onDraft={setDraft}
              onCommit={(fieldId, raw) => commitMargin(fieldId, raw, 0, true)}
              onCancel={dropDraft}
            />
            <DraftField
              fieldId="margin-horizontal"
              type="number"
              label={tr("workspace.layout-grid.editor.padding.horizontal")}
              value={String(values.margin[1])}
              draft={drafts["margin-horizontal"]}
              disabled={disabled}
              step={1}
              onDraft={setDraft}
              onCommit={(fieldId, raw) => commitMargin(fieldId, raw, 1, true)}
              onCancel={dropDraft}
            />
          </>
        )}
      </div>

      <div className="pp-workspace-style-grid">
        {boundFields.map((field) => (
          <DraftField
            key={field.fieldId}
            fieldId={field.fieldId}
            type="number"
            label={field.label}
            value={field.value === null ? "" : String(field.value)}
            draft={drafts[field.fieldId]}
            disabled={disabled}
            min={0}
            step={1}
            onDraft={setDraft}
            onCommit={(fieldId, raw) => commitBound(fieldId, raw, field.attr)}
            onCancel={dropDraft}
          />
        ))}
      </div>
    </section>
  );
}

export function ConstraintsOptions({
  shape,
  parent,
  disabled,
  send,
}: LayoutSectionProps) {
  const values = constraintsOf(shape, parent);
  const showFixedScroll = fixedScrollVisible(shape);

  if (!inFrameForConstraints(shape)) return null;

  // The static tr calls let the translation extractor pick the keys up; the
  // labels come from the shared catalog, the values from the schema.
  const hOptions = [
    { value: "left", label: tr("workspace.options.constraints.left") },
    { value: "right", label: tr("workspace.options.constraints.right") },
    { value: "leftright", label: tr("workspace.options.constraints.leftright") },
    { value: "center", label: tr("workspace.options.constraints.center") },
    { value: "scale", label: tr("workspace.options.constraints.scale") },
  ];
  const vOptions = [
    { value: "top", label: tr("workspace.options.constraints.top") },
    { value: "bottom", label: tr("workspace.options.constraints.bottom") },
    { value: "topbottom", label: tr("workspace.options.constraints.topbottom") },
    { value: "center", label: tr("workspace.options.constraints.center") },
    { value: "scale", label: tr("workspace.options.constraints.scale") },
  ];

  return (
    <section className="pp-workspace-style-section">
      <h3 className="pp-workspace-style-title">
        {tr("workspace.options.constraints")}
      </h3>
      <div className="pp-workspace-style-grid">
        <SelectField
          label="Horizontal"
          value={values.h}
          options={hOptions}
          disabled={disabled}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) => void send(constraintPatch(next, null))}
        />
        <SelectField
          label="Vertical"
          value={values.v}
          options={vOptions}
          disabled={disabled}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) => void send(constraintPatch(null, next))}
        />
        {showFixedScroll ? (
          <label
            className="pp-workspace-style-check pp-workspace-style-check--labeled"
            title={tr("workspace.options.constraints.fix-when-scrolling")}
          >
            <input
              type="checkbox"
              checked={values.fixedScroll}
              disabled={disabled}
              aria-label={tr("workspace.options.constraints.fix-when-scrolling")}
              onChange={(event) =>
                void send({ "fixed-scroll": event.currentTarget.checked })
              }
            />
            <span className="pp-workspace-style-label">
              {tr("workspace.options.constraints.fix-when-scrolling")}
            </span>
          </label>
        ) : null}
      </div>
    </section>
  );
}

// The sections the single-shape panel shows for a shape inside a layout.
// Exported so the style panel decides with one call and the layout module
// keeps the predicate next to the attributes it reads.
export function isLayoutParent(parent: WorkspaceShape | null): boolean {
  return isAnyLayout(parent);
}
