"use client";

// The selected-colors menu of the workspace style panel (F9.14): every
// distinct color of the selection (fills, strokes and shadow colors) with the
// shapes that use it, ported from
// sidebar/options/menus/color_selection.cljs and color_row.cljs.
//
// The rows are grouped by hex plus opacity (lib/workspace-selected-colors), so
// two shapes that share a color share one row and one edit rewrites both.
// Each row edits the hex and the percentage, and the trailing button selects
// the shapes that use the color (the CLJS select-only branch).
//
// The section reads shapes, never the file: the caller passes the batch
// commit, the panel keeps the pending flag and the canvas owns the RPC.

import {
  DraftField,
  clamp01,
  colorOf,
  parseNumber,
  percentOf,
  useDraftFields,
} from "@/components/workspace-style-field";
import { tr } from "@/lib/i18n";
import type { WorkspaceShape } from "@/lib/workspace";
import {
  selectedColors,
  usageShapeIds,
  type ColorEdit,
  type ColorUsage,
} from "@/lib/workspace-selected-colors";

export interface WorkspaceColorSelectionProps {
  shapes: readonly WorkspaceShape[];
  disabled: boolean;
  // The batch commit of the panel: one update-file call for every usage.
  onEdit: (usages: readonly ColorUsage[], edit: ColorEdit) => Promise<boolean>;
  // The shapes button of a row (dws/select-shapes).
  onSelectShapes: (ids: string[]) => void;
}

export function WorkspaceColorSelection({
  shapes,
  disabled,
  onEdit,
  onSelectShapes,
}: WorkspaceColorSelectionProps) {
  const { drafts, setDraft, dropDraft, commitAction } = useDraftFields(() =>
    Promise.resolve(true),
  );
  const colors = selectedColors(shapes);
  if (colors.length === 0) return null;

  return (
    <section
      className="pp-workspace-style-section pp-workspace-colors"
      aria-label={tr("workspace.options.selection-color.section")}
    >
      <header className="pp-workspace-style-header">
        <h3 className="pp-workspace-style-title">{tr("workspace.options.selection-color")}</h3>
        <span className="pp-workspace-colors-count">{colors.length}</span>
      </header>

      {colors.map((group, index) => {
        const colorId = `color-${index}-hex`;
        const opacityId = `color-${index}-opacity`;
        const users = usageShapeIds(group);
        return (
          <div className="pp-workspace-style-row" key={`${group.color}-${group.opacity}-${index}`}>
            <DraftField
              fieldId={colorId}
              type="color"
              label={tr("labels.color")}
              value={colorOf(group.color)}
              draft={drafts[colorId]}
              disabled={disabled}
              onDraft={setDraft}
              onCommit={(fieldId, raw) => {
                if (raw === undefined) return;
                commitAction(fieldId, raw, () => onEdit(group.usages, { color: raw }));
              }}
              onCancel={dropDraft}
            />
            <DraftField
              fieldId={opacityId}
              type="number"
              label={tr("workspace.options.opacity")}
              value={String(percentOf(group.opacity))}
              draft={drafts[opacityId]}
              disabled={disabled}
              min={0}
              max={100}
              step={1}
              unit="%"
              onDraft={setDraft}
              onCommit={(fieldId, raw) => {
                if (raw === undefined) return;
                const value = parseNumber(raw);
                if (value === null) {
                  dropDraft(fieldId);
                  return;
                }
                commitAction(fieldId, raw, () =>
                  onEdit(group.usages, { opacity: clamp01(value / 100) }),
                );
              }}
              onCancel={dropDraft}
            />
            <button
              type="button"
              className="pp-workspace-style-icon-button pp-workspace-colors-usage"
              title={tr("settings.select-this-color")}
              aria-label={tr("settings.select-this-color")}
              disabled={disabled || users.length === 0}
              onClick={() => onSelectShapes(users)}
            >
              {users.length}
            </button>
          </div>
        );
      })}
    </section>
  );
}
