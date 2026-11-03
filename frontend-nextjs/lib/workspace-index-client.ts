// The main-thread half of the workspace index worker (F9.15): the resident
// pass that takes the quadtree build off the canvas thread. The canvas
// scheduleIndex helper is the only caller: every objects update (commit,
// page switch, history step) hands the new model here, and the finished
// index lands back through the deliver callback.
//
// Like lib/thumbnail-worker-client.ts and lib/import-analyze-worker-client.ts
// there is no Worker in the node test environment or an old browser, and no
// spawn here would be fatal: every such path builds synchronously on the
// calling thread instead. A worker whose pass or channel fails is dropped
// after warning once, and this builder stays on the sync path for its life.
//
// Only the newest build matters: every schedule stamps a fresh sequence, and
// a reply for an older one is discarded, so a slow build of a superseded
// model can never overwrite the current index. The caller keeps serving
// queries from the previous index until the reply lands (the CLJS worker is
// asynchronous the same way); the first index of a page is built
// synchronously so the very first hover never sees an empty one.

import { createWorkspaceIndex, type WorkspaceIndex } from "@/lib/workspace-index";
import type { WorkspaceObjects } from "@/lib/workspace";

export interface IndexBuildRequest {
  seq: number;
  objects: WorkspaceObjects;
}

export interface IndexBuildReply {
  seq: number;
  index?: WorkspaceIndex;
  error?: string;
}

export interface IndexBuilder {
  // Ask for the index of the next model. The callback runs once per
  // schedule: synchronously when no worker serves the build, from the
  // message handler otherwise. Schedules that a newer one supersedes may
  // never deliver.
  schedule(objects: WorkspaceObjects, deliver: (index: WorkspaceIndex) => void): void;
  // Drop the resident worker; the next schedule respawns it (or builds
  // synchronously when the environment has none).
  dispose(): void;
}

type Spawn = (onReply: (reply: IndexBuildReply) => void, onBroken: () => void) => Worker | null;

function defaultSpawn(onReply: (reply: IndexBuildReply) => void, onBroken: () => void): Worker | null {
  // The node test environment has no window and no browser Worker.
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  try {
    const created = new Worker(
      new URL("./workspace-index.worker.ts", import.meta.url),
      { type: "module" },
    );
    created.addEventListener("message", (event: MessageEvent<IndexBuildReply>) => {
      onReply(event.data);
    });
    created.addEventListener("error", onBroken);
    return created;
  } catch {
    return null;
  }
}

export function createIndexBuilder(spawn: Spawn = defaultSpawn): IndexBuilder {
  let worker: Worker | null = null;
  // False until the first spawn attempt; a failed one never retries.
  let spawnTried = false;
  let broken = false;
  let seq = 0;
  // The deliver of the newest scheduled build, settled by the matching reply.
  let waiting: ((index: WorkspaceIndex) => void) | null = null;
  // The objects of the in-flight build, so a broken worker can still settle
  // the waiting deliver synchronously.
  let pendingObjects: WorkspaceObjects | null = null;

  const syncBuild = (objects: WorkspaceObjects, deliver: (index: WorkspaceIndex) => void): void => {
    waiting = null;
    deliver(createWorkspaceIndex(objects));
  };

  const handleReply = (reply: IndexBuildReply): void => {
    if (typeof reply.error === "string") {
      // A throwing build is a bug, not an environment fact: name it once.
      console.warn("[workspace-index] the worker could not build the index:", reply.error);
      dropWorker();
      return;
    }
    if (waiting === null || reply.seq !== seq) return;
    const deliver = waiting;
    waiting = null;
    if (reply.index !== undefined && reply.index !== null) deliver(reply.index);
  };

  const dropWorker = (): void => {
    broken = true;
    if (worker !== null) worker.terminate();
    worker = null;
    // The in-flight build will never come back: take the sync path for it.
    if (pendingObjects !== null && waiting !== null) {
      const deliver = waiting;
      syncBuild(pendingObjects, deliver);
    } else {
      waiting = null;
    }
  };

  return {
    schedule(objects, deliver) {
      pendingObjects = objects;
      if (broken) {
        syncBuild(objects, deliver);
        return;
      }
      if (!spawnTried) {
        spawnTried = true;
        worker = spawn(handleReply, dropWorker);
        if (worker === null) {
          syncBuild(objects, deliver);
          return;
        }
      }
      const running = worker;
      if (running === null) {
        syncBuild(objects, deliver);
        return;
      }
      seq += 1;
      waiting = deliver;
      try {
        running.postMessage({ seq, objects } satisfies IndexBuildRequest);
      } catch (cause) {
        console.warn("[workspace-index] the build request failed; building on the main thread:", cause);
        dropWorker();
        syncBuild(objects, deliver);
      }
    },
    dispose() {
      if (worker !== null) worker.terminate();
      worker = null;
      spawnTried = false;
      waiting = null;
      pendingObjects = null;
    },
  };
}