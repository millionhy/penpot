"use client";

// Delete-shared dialog (F5.2). Port of app.main.ui.delete-shared, the modal
// the file menu opens before deleting, unpublishing or moving shared
// libraries across teams: it lists the files that link each library
// (get-library-file-references) so the user sees what loses the link.
//
// Deviations: the CLJS dialog also binds a document-level Enter shortcut and
// emits telemetry; the shell relies on the modal host's Escape/backdrop close
// and has no analytics seam.

import { useEffect, useState } from "react";
import { ModalShell, useModal } from "@/components/modal";
import { getLibraryFileReferences, type LibraryFileReference } from "@/lib/dashboard";
import { tr } from "@/lib/i18n";

export type DeleteSharedOrigin = "delete" | "unpublish" | "move";

export interface DeleteSharedDialogProps {
  origin: DeleteSharedOrigin;
  ids: string[];
  countLibraries: number;
  onAccept: () => void;
}

export function DeleteSharedDialog({
  origin,
  ids,
  countLibraries,
  onAccept,
}: DeleteSharedDialogProps) {
  const { close } = useModal();
  const [references, setReferences] = useState<LibraryFileReference[] | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const rows: LibraryFileReference[] = [];
      for (const id of ids) {
        try {
          const found = await getLibraryFileReferences(id);
          if (Array.isArray(found)) rows.push(...found);
        } catch {
          // A failed lookup only costs one entry in the reference list; the
          // CLJS dialog keeps whatever arrived the same way.
        }
      }
      if (live) setReferences(rows);
    })();
    return () => {
      live = false;
    };
  }, [ids]);

  const titleKey =
    origin === "delete"
      ? "modals.delete-shared-confirm.title"
      : origin === "unpublish"
        ? "modals.unpublish-shared-confirm.title"
        : "modals.move-shared-confirm.title";
  const messageKey =
    origin === "delete"
      ? "modals.delete-shared-confirm.message"
      : origin === "unpublish"
        ? "modals.unpublish-shared-confirm.message"
        : "modals.move-shared-confirm.message";
  const acceptKey =
    origin === "delete"
      ? "modals.delete-shared-confirm.accept"
      : origin === "unpublish"
        ? "modals.unpublish-shared-confirm.accept"
        : "modals.move-shared-confirm.accept";

  const countFiles = references?.length ?? 0;
  const acceptStyleDanger = origin !== "move";

  return (
    <ModalShell
      title={tr(titleKey, countLibraries)}
      titleTestId="delete-shared-title"
      closeLabel={tr("labels.cancel")}
      footer={
        <div className="pp-modal-actions">
          <button type="button" className="pp-btn-secondary" onClick={close}>
            {tr("labels.cancel")}
          </button>
          <button
            type="button"
            className={acceptStyleDanger ? "pp-btn-danger" : "pp-btn-primary"}
            data-testid="delete-shared-accept"
            onClick={() => {
              close();
              onAccept();
            }}
          >
            {tr(acceptKey, countLibraries)}
          </button>
        </div>
      }
    >
      <h3 className="pp-modal-subtitle">{tr(messageKey, countLibraries)}</h3>
      {countLibraries !== 0 ? (
        references !== null && references.length > 0 ? (
          <>
            <p className="pp-modal-scd-msg">
              {tr("modals.delete-shared-confirm.activated.scd-message", countLibraries)}
            </p>
            <ul className="pp-shared-reference-list">
              {references.map((reference) => (
                <li key={reference.id}>
                  <span>{"- " + reference.name}</span>
                </li>
              ))}
            </ul>
            <p className="pp-modal-hint">
              {tr("modals.delete-unpublish-shared-confirm.activated.hint", countFiles)}
            </p>
          </>
        ) : references !== null ? (
          <h3 className="pp-modal-msg">
            {tr("modals.delete-shared-confirm.activated.no-files-message", countLibraries)}
          </h3>
        ) : null
      ) : null}
    </ModalShell>
  );
}
