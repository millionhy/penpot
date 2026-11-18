"use client";

// The exports menu of the workspace style panel (F9.14, G1): the :exports
// specs of a shape, ported from sidebar/options/menus/exports.cljs.
//
// A row is one spec: a format select (PNG, JPG, WEBP, SVG, PDF), a size select
// for the bitmap formats, a suffix input and a remove button, with the one
// download button of the menu under the list. The download asks the exporter
// service through lib/workspace-export (one POST, wait, download), which is
// the server branch of the CLJS request-export. The CLJS export-state widget
// is not ported: the panel keeps a local "exporting" flag instead, and the
// export does not need edit permission, only read access to the file.

import { useState } from "react";

import {
  DraftField,
  useDraftFields,
} from "@/components/workspace-style-field";
import { MinusIcon, PlusIcon } from "@/components/workspace-icons";
import { useNotifications } from "@/components/notifications";
import { tr } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import type { WorkspaceShape } from "@/lib/workspace";
import { exportShapes } from "@/lib/workspace-export";
import { getWorkspaceState } from "@/lib/workspace-store";
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
  const notifications = useNotifications();
  const { profile } = useSession();
  const [exporting, setExporting] = useState(false);
  const specs = exportsOf(shape);

  const commit = (fieldId: string, raw: string | undefined, next: ReturnType<typeof exportsOf>): void => {
    if (raw === undefined) return;
    commitAction(fieldId, raw, () => send({ exports: exportPatch(next) }));
  };

  // on-download of the CLJS menu: the specs of this shape, handed to the
  // exporter as one request (a multi-spec list comes back as a zip).
  const download = async (): Promise<void> => {
    if (exporting || specs.length === 0 || profile === null) return;
    const { fileId, pageId } = getWorkspaceState();
    if (fileId === null || pageId === null) return;
    setExporting(true);
    try {
      await exportShapes({
        fileId,
        pageId,
        profileId: profile.id,
        items: [{ shape: { id: shape.id, name: shape.name }, specs }],
      });
    } catch {
      notifications.error(tr("workspace.options.exporting-object-error"));
    } finally {
      setExporting(false);
    }
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
          exporter returns the single file, or a zip when the list has more
          than one spec. */}
      {specs.length === 0 ? null : (
        <button
          type="button"
          className="pp-workspace-style-export-button"
          title={tr("workspace.options.export")}
          disabled={exporting}
          onClick={() => void download()}
        >
          {exporting
            ? tr("workspace.options.exporting-object")
            : tr("workspace.options.export-object", 1)}
        </button>
      )}
    </section>
  );
}
