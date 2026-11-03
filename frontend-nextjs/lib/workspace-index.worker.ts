// F9.15: the resident builder of the workspace hit-testing index. The CLJS
// workspace builds the worker/selection quadtree off the main thread
// (frontend/src/app/worker/selection.cljs); this shell rebuilt it on the
// canvas thread after every commit, page switch and history step (the
// sixteen createWorkspaceIndex sites in workspace-wasm-canvas, the page-load
// one aside). This worker takes the heavy half - the build - and holds
// itself resident across pages;
// the returned index is plain data (the quadtree nodes, the parents/clip
// entries and the shape snapshots), so it crosses back through the structured
// clone and the pointer hot paths keep querying it synchronously.
//
// The queries themselves stay on the main thread, unlike the CLJS worker:
// the hover/area adjudication runs through the wasm $APP adapters
// (sort-ids / intersect-position), which live with the GL context of the
// canvas instance and cannot enter a worker. The build is the expensive
// part (one quadtree insert per shape plus the clip/parent indexes); the
// queries are logarithmic tree walks over a handful of candidates.
//
// The protocol is one request in flight by construction: the client stamps
// every build with a sequence number and drops any reply it no longer waits
// for, so a slow build of a superseded page never overwrites the current
// index.

import { createWorkspaceIndex, type WorkspaceIndex } from "@/lib/workspace-index";
import type { IndexBuildReply, IndexBuildRequest } from "@/lib/workspace-index-client";

// The pure half, exported so vitest exercises the build without a Worker.
export function buildIndexReply(request: IndexBuildRequest): IndexBuildReply {
  try {
    const index: WorkspaceIndex = createWorkspaceIndex(request.objects);
    return { seq: request.seq, index };
  } catch (cause: unknown) {
    return { seq: request.seq, error: String(cause) };
  }
}

// A structural cast instead of DedicatedWorkerGlobalScope: the project's
// tsconfig also loads the DOM lib, whose `self`/postMessage would conflict
// (same device as lib/thumbnail.worker.ts). The typeof guard keeps the module
// importable outside a worker (vitest reads buildIndexReply from it); there
// is no self in the node test environment.
const scope: {
  onmessage: ((event: MessageEvent<IndexBuildRequest>) => void) | null;
  postMessage: (reply: IndexBuildReply) => void;
} | null =
  typeof self === "undefined"
    ? null
    : (self as unknown as {
        onmessage: ((event: MessageEvent<IndexBuildRequest>) => void) | null;
        postMessage: (reply: IndexBuildReply) => void;
      });

// The build is fully synchronous, so replies leave in request order; the
// client still gates on the sequence to defend against a future async pass.
if (scope !== null) {
  scope.onmessage = (event: MessageEvent<IndexBuildRequest>): void => {
    scope.postMessage(buildIndexReply(event.data));
  };
}

export type { IndexBuildReply, IndexBuildRequest } from "@/lib/workspace-index-client";