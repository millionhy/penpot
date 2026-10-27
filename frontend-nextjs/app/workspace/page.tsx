"use client";

// Workspace route (F9.1): takes over /workspace from the RouteStub. The
// page loads the file through lib/workspace into the module store
// (lib/workspace-store) and, once the file resolves, renders the workspace
// shell (components/workspace-shell) around the read-only WASM canvas.
//
// Deviations from the CLJS original (app.main.ui.workspace), documented:
// - Shell slice (F9.4): the sidebars are the left header, the Layers panel
//   and an empty right skeleton; no palette, context menu, plugin UI, layout
//   presets or history yet.
// - F9.13 adds the page list of the left sidebar and its page switch. The
//   switch is a ?page-id= change: the effect below re-resolves the page on
//   the loaded file without re-downloading it.
// - initialize-workspace loads once per file-id; a page-id change on the
//   loaded file only re-resolves the open page. An unknown page-id falls
//   back to the first page (lib/workspace records the CLJS redirect).
// - finalize-workspace drops the store slice on unmount; the CLJS also
//   forces a persist there, which is a no-op until the editing slices land.
// - The document title carries the file name once it resolves
//   (title.workspace, the file-name effect of workspace*).
// - A missing ?file-id= renders the generic full-page message, like the
//   viewer port (the CLJS would sit on the loader forever).
// - A fetch failure renders the exception page for the :not-found /
//   :authentication causes and the generic message otherwise, mirroring
//   the viewer page.

import { useEffect, useState, useSyncExternalStore } from "react";

import { AuthGuard } from "@/components/auth-guard";
import { ExceptionPage } from "@/components/exception-page";
import { PenpotLoader } from "@/components/penpot-loader";
import { QueryParams } from "@/components/query-params";
import { WorkspaceShell } from "@/components/workspace-shell";
import { useDocumentTitle } from "@/lib/dom";
import { isExceptionCause } from "@/lib/exception-page";
import { tr } from "@/lib/i18n";
import {
  fetchWorkspaceFile,
  fetchWorkspaceProjectName,
  parseWorkspaceQuery,
  resolvePageId,
} from "@/lib/workspace";
import {
  getInitialWorkspaceState,
  getWorkspaceState,
  resetWorkspaceState,
  setWorkspaceState,
  subscribeWorkspace,
} from "@/lib/workspace-store";

// The full-page message of the states that never reach the canvas (no
// file-id in the URL, a failed fetch without an exception cause).
function WorkspaceMessage({ message }: { message: string }) {
  return (
    <div className="pp-workspace-message">
      <section className="pp-empty-state">
        <span>{message}</span>
      </section>
    </div>
  );
}

function WorkspaceRoute({ params }: { params: URLSearchParams }) {
  const query = parseWorkspaceQuery(params);
  const state = useSyncExternalStore(
    subscribeWorkspace,
    getWorkspaceState,
    getInitialWorkspaceState,
  );

  const fileId = query.fileId;
  const urlPageId = query.pageId;
  const projectId = query.projectId;

  // The project label above the file name (left_header.cljs). One lookup
  // per project-id; a failure leaves the label empty.
  const [projectName, setProjectName] = useState<string | null>(null);
  useEffect(() => {
    if (projectId === null) {
      setProjectName(null);
      return;
    }
    let live = true;
    fetchWorkspaceProjectName(projectId)
      .then((name) => {
        if (live) setProjectName(name);
      })
      .catch(() => {
        if (live) setProjectName(null);
      });
    return () => {
      live = false;
    };
  }, [projectId]);

  // initialize-workspace: one load per file-id. A page-id change on a file
  // already in the store re-resolves the open page without re-downloading
  // it.
  useEffect(() => {
    if (fileId === null) return;

    const current = getWorkspaceState();
    if (current.file !== null && current.fileId === fileId) {
      const pageId = resolvePageId(current.file, urlPageId);
      if (pageId !== current.pageId) setWorkspaceState({ pageId });
      return;
    }

    let live = true;
    setWorkspaceState({
      status: "loading",
      fileId,
      file: null,
      pageId: null,
      error: null,
    });
    fetchWorkspaceFile(fileId)
      .then((file) => {
        if (!live) return;
        setWorkspaceState({
          status: "ready",
          file,
          pageId: resolvePageId(file, urlPageId),
        });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setWorkspaceState({ status: "error", error });
      });
    return () => {
      live = false;
    };
  }, [fileId, urlPageId]);

  // finalize-workspace: drop the store slice on unmount, so a later visit
  // starts clean.
  useEffect(() => () => resetWorkspaceState(), []);

  const file = state.file;
  useDocumentTitle(file === null ? "" : tr("title.workspace", file.name));

  if (fileId === null) {
    return <WorkspaceMessage message={tr("errors.generic")} />;
  }

  if (state.status === "error" && state.fileId === fileId) {
    return isExceptionCause(state.error) ? (
      <ExceptionPage fileId={fileId} teamId={query.teamId} />
    ) : (
      <WorkspaceMessage message={tr("errors.generic")} />
    );
  }

  const pageId = state.pageId;
  if (
    state.status !== "ready" ||
    state.fileId !== fileId ||
    file === null ||
    pageId === null
  ) {
    return <PenpotLoader />;
  }

  return (
    <WorkspaceShell
      fileId={fileId}
      pageId={pageId}
      file={file}
      projectName={projectName}
    />
  );
}

export default function Page() {
  return (
    <AuthGuard>
      <QueryParams fallback={<PenpotLoader />}>
        {(params) => <WorkspaceRoute params={params} />}
      </QueryParams>
    </AuthGuard>
  );
}
