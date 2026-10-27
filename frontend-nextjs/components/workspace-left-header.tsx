"use client";

// The workspace left header (F9.4): the dashboard link, the file name with
// inline rename and the main-menu trigger. Port of
// app.main.ui.workspace.left-header.
//
// Rename ownership: this component owns the editing state, so the main
// menu's Rename item calls the startRename() method exposed through
// WorkspaceLeftHeaderHandle instead of duplicating the input elsewhere.
//
// Deviations from the CLJS original, documented (AD10):
// - The shared badge and the persistence widget variants are not ported;
//   a 6px saved dot stands in for the persistence widget of this
//   read-only slice.
// - The project name is passed in (the route resolves it from ?project-id=)
//   instead of read off the workspace state.

import { useImperativeHandle, useRef, useState, type Ref } from "react";

import {
  MenuIcon,
  PenpotLogoIcon,
} from "@/components/workspace-icons";
import { tr } from "@/lib/i18n";
import { renameWorkspaceFile, type WorkspaceFile } from "@/lib/workspace";
import { getWorkspaceState, setWorkspaceState } from "@/lib/workspace-store";

export interface WorkspaceLeftHeaderHandle {
  startRename(): void;
  focusMenuButton(): void;
}

export interface WorkspaceLeftHeaderProps {
  file: WorkspaceFile;
  // The containing project (the DRAFTS label above the file name).
  projectName: string | null;
  canEdit: boolean;
  menuOpen: boolean;
  onMenuClick(anchor: HTMLElement): void;
  ref?: Ref<WorkspaceLeftHeaderHandle>;
}

export function WorkspaceLeftHeader({
  file,
  projectName,
  canEdit,
  menuOpen,
  onMenuClick,
  ref,
}: WorkspaceLeftHeaderProps) {
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const submittingRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(file.name);
  const [error, setError] = useState<string | null>(null);

  const cancelRename = (): void => {
    if (submittingRef.current) return;
    setEditing(false);
    setDraft(file.name);
    setError(null);
  };

  const startRename = (): void => {
    if (!canEdit || submittingRef.current) return;
    setDraft(file.name);
    setError(null);
    setEditing(true);
  };

  // dw/rename-file: Enter commits, Escape/blur cancels (the CLJS commits on
  // blur, but the plan keeps blur as the cancel path so a stray click never
  // renames a file).
  const commitRename = async (): Promise<void> => {
    if (submittingRef.current) return;
    const name = draft.trim();
    if (name === "" || name === file.name) {
      cancelRename();
      return;
    }

    submittingRef.current = true;
    try {
      const renamed = await renameWorkspaceFile(file.id, name);
      const current = getWorkspaceState().file ?? file;
      setWorkspaceState({ file: { ...current, name: renamed.name } });
      setDraft(renamed.name);
      setError(null);
      setEditing(false);
    } catch {
      // The backend rejected the rename (permissions, validation): restore
      // the old name and leave a visible status line.
      setDraft(file.name);
      setEditing(false);
      setError(tr("errors.generic"));
    } finally {
      submittingRef.current = false;
    }
  };

  useImperativeHandle(ref, () => ({
    startRename,
    focusMenuButton: () => menuButtonRef.current?.focus(),
  }));

  return (
    <>
      <header className="pp-workspace-left-header">
        <a
          className="pp-workspace-logo"
          href="/dashboard/recent"
          title={tr("labels.dashboard")}
          aria-label={tr("labels.dashboard")}
        >
          <PenpotLogoIcon />
        </a>

        <div className="pp-workspace-project-tree">
          <div className="pp-workspace-project-name" title={projectName ?? undefined}>
            {projectName}
          </div>

          {editing ? (
            <input
              className="pp-workspace-file-input"
              value={draft}
              maxLength={200}
              autoFocus
              aria-label={tr("labels.rename")}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={cancelRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="pp-workspace-file-name"
              title={file.name}
              aria-disabled={!canEdit}
              onDoubleClick={startRename}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "F2") {
                  event.preventDefault();
                  startRename();
                }
              }}
            >
              <span
                className="pp-workspace-status-dot"
                role="img"
                title={tr("workspace.header.saved")}
                aria-label={tr("workspace.header.saved")}
              />
              <span className="pp-workspace-file-name-label">{file.name}</span>
            </button>
          )}
        </div>

        {/* Keep DashboardMenu's document mousedown listener from closing
            the menu before this click toggles it. */}
        <button
          ref={menuButtonRef}
          type="button"
          className="pp-workspace-menu-button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={tr("labels.options")}
          title={tr("labels.options")}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => onMenuClick(event.currentTarget)}
        >
          <MenuIcon />
        </button>
      </header>

      {error !== null ? (
        <p className="pp-workspace-rename-error" role="status">
          {error}
        </p>
      ) : null}
    </>
  );
}
