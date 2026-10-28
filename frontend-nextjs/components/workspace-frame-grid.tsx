"use client";

// The guides menu of the workspace style panel (F9.14): the layout grids of a
// frame, ported from sidebar/options/menus/frame_grid.cljs.
//
// A row is one grid of the frame's :grids vector: a type select (square,
// columns, rows), a show toggle, the size (the columns and rows grids accept
// an empty value, the auto item length of the backend), the gutter, the
// margin, the item length, the color and a remove button. Every edit commits
// the whole vector through the caller's send.
//
// The renderer does not draw the grids yet (the wasm bridge has no grid
// pass), so the rows persist the attribute and the canvas stays unchanged;
// the deviation is documented in lib/workspace-guides.

import {
  DraftField,
  colorOf,
  numberAttr,
  parseNumber,
  useDraftFields,
} from "@/components/workspace-style-field";
import { EyeOffIcon, MinusIcon, PlusIcon, ShownIcon } from "@/components/workspace-icons";
import { tr } from "@/lib/i18n";
import type { WorkspaceShape } from "@/lib/workspace";
import {
  addGuide,
  guideColorOf,
  guidePatch,
  guidesOf,
  removeGuide,
  withGuideColor,
  withGuideDisplay,
  withGuideItemLength,
  withGuideParams,
  withGuideSize,
  withGuideType,
  type GuideType,
} from "@/lib/workspace-guides";

export interface WorkspaceFrameGridProps {
  shape: WorkspaceShape;
  disabled: boolean;
  send: (attrs: Record<string, unknown>) => Promise<boolean>;
}

const TYPES: readonly { value: GuideType; labelKey: string }[] = [
  { value: "square", labelKey: "workspace.options.grid.square" },
  { value: "column", labelKey: "workspace.options.grid.column" },
  { value: "row", labelKey: "workspace.options.grid.row" },
];

export function WorkspaceFrameGrid({ shape, disabled, send }: WorkspaceFrameGridProps) {
  const { drafts, setDraft, dropDraft, dropAllDrafts, commitAction } = useDraftFields(send);
  const guides = guidesOf(shape);

  const commit = (fieldId: string, raw: string | undefined, next: ReturnType<typeof guidesOf>): void => {
    if (raw === undefined) return;
    commitAction(fieldId, raw, () => send({ grids: guidePatch(next) }));
  };

  const width = typeof shape["width"] === "number" ? shape["width"] : 0;
  const height = typeof shape["height"] === "number" ? shape["height"] : 0;

  return (
    <section className="pp-workspace-style-section">
      <header className="pp-workspace-style-header">
        <h3 className="pp-workspace-style-title">{tr("workspace.options.guides.title")}</h3>
        <button
          type="button"
          className="pp-workspace-style-icon-button"
          aria-label={tr("workspace.options.guides.add-guide")}
          title={tr("workspace.options.guides.add-guide")}
          disabled={disabled}
          onClick={() => {
            dropAllDrafts();
            void send({ grids: guidePatch(addGuide(guides)) });
          }}
        >
          <PlusIcon />
        </button>
      </header>

      {guides.map((grid, index) => {
        const params = grid.params;
        const layout = grid.type !== "square";
        const frameLength = grid.type === "column" ? width : height;
        const color = guideColorOf(grid);
        const sizeId = `grid-${index}-size`;
        const gutterId = `grid-${index}-gutter`;
        const marginId = `grid-${index}-margin`;
        const itemId = `grid-${index}-item`;
        const colorId = `grid-${index}-color`;
        return (
          <div className="pp-workspace-grid-row" key={`grid-${index}`}>
            <div className="pp-workspace-style-row pp-workspace-style-row--grid">
              <label className="pp-workspace-style-field">
                <span className="pp-workspace-style-label">
                  {tr("workspace.options.guides.title")}
                </span>
                <select
                  className="pp-workspace-style-select pp-workspace-style-select--field"
                  value={grid.type}
                  disabled={disabled}
                  aria-label={tr("workspace.options.guides.title")}
                  onChange={(event) => {
                    dropAllDrafts();
                    void send({
                      grids: guidePatch(
                        withGuideType(guides, index, event.currentTarget.value as GuideType),
                      ),
                    });
                  }}
                >
                  {TYPES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {tr(option.labelKey)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="pp-workspace-style-icon-button"
                aria-label={tr("workspace.options.guides.toggle-guide")}
                title={tr("workspace.options.guides.toggle-guide")}
                disabled={disabled}
                onClick={() => {
                  dropAllDrafts();
                  void send({
                    grids: guidePatch(withGuideDisplay(guides, index, !grid.display)),
                  });
                }}
              >
                {grid.display ? <ShownIcon /> : <EyeOffIcon />}
              </button>
              <DraftField
                fieldId={sizeId}
                type="number"
                label={tr("workspace.options.size")}
                value={String(numberAttr(params, "size", 0))}
                draft={drafts[sizeId]}
                disabled={disabled}
                min={0}
                step={1}
                onDraft={setDraft}
                onCommit={(fieldId, raw) => {
                  if (raw === undefined) return;
                  if (raw.trim() === "") {
                    // The empty size asks the backend for its default item
                    // length over the frame side.
                    commit(fieldId, raw, withGuideSize(guides, index, null, frameLength));
                    return;
                  }
                  const value = parseNumber(raw);
                  if (value === null) {
                    dropDraft(fieldId);
                    return;
                  }
                  commit(fieldId, raw, withGuideSize(guides, index, value, frameLength));
                }}
                onCancel={dropDraft}
              />
              <DraftField
                fieldId={colorId}
                type="color"
                label={tr("workspace.options.grid.params.color")}
                value={colorOf(color.color)}
                draft={drafts[colorId]}
                disabled={disabled}
                onDraft={setDraft}
                onCommit={(fieldId, raw) => {
                  if (raw === undefined) return;
                  commit(fieldId, raw, withGuideColor(guides, index, raw));
                }}
                onCancel={dropDraft}
              />
              <button
                type="button"
                className="pp-workspace-style-icon-button"
                aria-label={tr("workspace.options.guides.remove-guide")}
                title={tr("workspace.options.guides.remove-guide")}
                disabled={disabled}
                onClick={() => {
                  dropAllDrafts();
                  void send({ grids: guidePatch(removeGuide(guides, index)) });
                }}
              >
                <MinusIcon />
              </button>
            </div>

            {layout ? (
              <div className="pp-workspace-style-row">
                <DraftField
                  fieldId={gutterId}
                  type="number"
                  label={tr("workspace.options.grid.params.gutter")}
                  value={String(numberAttr(params, "gutter", 0))}
                  draft={drafts[gutterId]}
                  disabled={disabled}
                  min={0}
                  step={1}
                  onDraft={setDraft}
                  onCommit={(fieldId, raw) => {
                    if (raw === undefined) return;
                    const value = parseNumber(raw);
                    if (value === null) {
                      dropDraft(fieldId);
                      return;
                    }
                    commit(fieldId, raw, withGuideParams(guides, index, { gutter: value }));
                  }}
                  onCancel={dropDraft}
                />
                <DraftField
                  fieldId={marginId}
                  type="number"
                  label={tr("workspace.options.grid.params.margin")}
                  value={String(numberAttr(params, "margin", 0))}
                  draft={drafts[marginId]}
                  disabled={disabled}
                  min={0}
                  step={1}
                  onDraft={setDraft}
                  onCommit={(fieldId, raw) => {
                    if (raw === undefined) return;
                    const value = parseNumber(raw);
                    if (value === null) {
                      dropDraft(fieldId);
                      return;
                    }
                    commit(fieldId, raw, withGuideParams(guides, index, { margin: value }));
                  }}
                  onCancel={dropDraft}
                />
                <DraftField
                  fieldId={itemId}
                  type="number"
                  label={tr(
                    grid.type === "column"
                      ? "workspace.options.grid.params.width"
                      : "workspace.options.grid.params.height",
                  )}
                  value={
                    params["item-length"] === null || params["item-length"] === undefined
                      ? ""
                      : String(numberAttr(params, "item-length", 0))
                  }
                  draft={drafts[itemId]}
                  disabled={disabled}
                  min={0}
                  step={1}
                  onDraft={setDraft}
                  onCommit={(fieldId, raw) => {
                    if (raw === undefined) return;
                    if (raw.trim() === "") {
                      commit(fieldId, raw, withGuideItemLength(guides, index, null));
                      return;
                    }
                    const value = parseNumber(raw);
                    if (value === null) {
                      dropDraft(fieldId);
                      return;
                    }
                    commit(fieldId, raw, withGuideItemLength(guides, index, value));
                  }}
                  onCancel={dropDraft}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
