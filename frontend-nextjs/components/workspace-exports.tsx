"use client";

// The exports menu of the workspace style panel (F9.14): the :exports specs of
// a shape, ported from sidebar/options/menus/exports.cljs.
//
// A row is one spec: a format select (PNG, JPG, WEBP, SVG, PDF), a size select
// for the bitmap formats, a suffix input and a remove button, with the one
// download button of the menu under the list. The button stays disabled: the
// render-wasm build ships no export entry point, so the panel edits and
// persists the specs only. The deviation is documented in lib/workspace-exports.

import {
  DraftField,
  useDraftFields,
} from "@/components/workspace-style-field";
import { MinusIcon, PlusIcon } from "@/components/workspace-icons";
import { tr } from "@/lib/i18n";
import type { WorkspaceShape } from "@/lib/workspace";
import {
  EXPORT_SCALES,
  EXPORT_TYPES,
  addExport,
  exportPatch,
  exportsOf,
  removeExport,
  scaleEnabled,
  withExportScale,
  withExportSuffix,
  withExportType,
  type ExportType,
} from "@/lib/workspace-exports";

export interface WorkspaceExportsProps {
  shape: WorkspaceShape;
  disabled: boolean;
  send: (attrs: Record<string, unknown>) => Promise<boolean>;
}

export function WorkspaceExports({ shape, disabled, send }: WorkspaceExportsProps) {
  const { drafts, setDraft, dropDraft, dropAllDrafts, commitAction } = useDraftFields(send);
  const specs = exportsOf(shape);

  const commit = (fieldId: string, raw: string | undefined, next: ReturnType<typeof exportsOf>): void => {
    if (raw === undefined) return;
    commitAction(fieldId, raw, () => send({ exports: exportPatch(next) }));
  };

  return (
    <section className="pp-workspace-style-section">
      <header className="pp-workspace-style-header">
        <h3 className="pp-workspace-style-title">
          {specs.length > 1
            ? tr("workspace.options.export-multiple")
            : tr("workspace.options.export")}
        </h3>
        <button
          type="button"
          className="pp-workspace-style-icon-button"
          aria-label={tr("workspace.options.export.add-export")}
          title={tr("workspace.options.export.add-export")}
          disabled={disabled}
          onClick={() => {
            dropAllDrafts();
            void send({ exports: exportPatch(addExport(specs)) });
          }}
        >
          <PlusIcon />
        </button>
      </header>

      {specs.map((spec, index) => {
        const suffixId = `export-${index}-suffix`;
        return (
          <div
            className="pp-workspace-style-row pp-workspace-style-row--export"
            key={`export-${index}`}
          >
            <select
              className="pp-workspace-style-select"
              value={spec.type}
              disabled={disabled}
              aria-label={tr("workspace.options.export")}
              onChange={(event) => {
                dropAllDrafts();
                void send({
                  exports: exportPatch(
                    withExportType(specs, index, event.currentTarget.value as ExportType),
                  ),
                });
              }}
            >
              {EXPORT_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {scaleEnabled(spec) ? (
              <select
                className="pp-workspace-style-select"
                value={String(spec.scale)}
                disabled={disabled}
                aria-label={tr("workspace.options.size")}
                onChange={(event) => {
                  dropAllDrafts();
                  void send({
                    exports: exportPatch(
                      withExportScale(specs, index, Number(event.currentTarget.value)),
                    ),
                  });
                }}
              >
                {EXPORT_SCALES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="pp-workspace-style-select pp-workspace-style-select--placeholder">
                -
              </span>
            )}
            <DraftField
              fieldId={suffixId}
              type="text"
              label={tr("workspace.options.export.suffix")}
              placeholder={tr("workspace.options.export.suffix")}
              value={spec.suffix}
              draft={drafts[suffixId]}
              disabled={disabled}
              onDraft={setDraft}
              onCommit={(fieldId, raw) => {
                if (raw === undefined) return;
                commit(fieldId, raw, withExportSuffix(specs, index, raw));
              }}
              onCancel={dropDraft}
            />
            <button
              type="button"
              className="pp-workspace-style-icon-button"
              aria-label={tr("workspace.options.export.remove-export")}
              title={tr("workspace.options.export.remove-export")}
              disabled={disabled}
              onClick={() => {
                dropAllDrafts();
                void send({ exports: exportPatch(removeExport(specs, index)) });
              }}
            >
              <MinusIcon />
            </button>
          </div>
        );
      })}

      {/* The download of exports.cljs: one button for the whole list. The
          renderer ships no export entry point, so it stays disabled. */}
      {specs.length === 0 ? null : (
        <button
          type="button"
          className="pp-workspace-style-export-button"
          title={tr("workspace.options.export")}
          disabled
        >
          {tr("workspace.options.export-object", specs.length)}
        </button>
      )}
    </section>
  );
}
