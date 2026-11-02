// The main-thread half of the import-analysis worker (F5.6).
//
// analyzeImportFile in lib/binfile asks this module first; a null answer
// (no Worker, a worker bundle that failed, or the node test environment)
// sends the caller to the synchronous reader. The worker is created once and
// kept for the life of the page: the analysis is stateless and every round
// trip only carries the picked File and the resulting format/rows.
//
// A worker that crashes settles every pending request with null, drops the
// instance and lets the next request respawn it; a failed spawn falls back
// for the current request only, so a browser without worker support keeps
// working.

import type { ImportAnalysis } from "@/lib/binfile";

interface AnalyzeResponse {
  id: number;
  result?: ImportAnalysis;
  error?: string;
}

type Settle = (analysis: ImportAnalysis | null) => void;

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, Settle>();

function report(message: AnalyzeResponse): void {
  const settle = pending.get(message.id);
  if (settle === undefined) return;
  pending.delete(message.id);
  if (typeof message.error === "string") {
    settle({ format: "error", message: message.error });
  } else if (message.result !== undefined) {
    settle(message.result);
  } else {
    settle({ format: "error", message: "" });
  }
}

function spawn(): Worker | null {
  // The node test environment has no window and no browser Worker: the
  // synchronous reader is the only path there.
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  try {
    const created = new Worker(new URL("./import-analyze.worker.ts", import.meta.url), {
      type: "module",
    });
    created.addEventListener("message", (event: MessageEvent<AnalyzeResponse>) => {
      report(event.data);
    });
    created.addEventListener("error", () => {
      for (const settle of pending.values()) settle(null);
      pending.clear();
      created.terminate();
      if (worker === created) worker = null;
    });
    return created;
  } catch {
    return null;
  }
}

export function analyzeImportFileOffThread(file: File): Promise<ImportAnalysis | null> {
  if (worker === null) worker = spawn();
  const running = worker;
  if (running === null) return Promise.resolve(null);
  const id = (nextId += 1);
  return new Promise<ImportAnalysis | null>((resolve) => {
    pending.set(id, resolve);
    try {
      running.postMessage({ id, file });
    } catch {
      pending.delete(id);
      resolve(null);
    }
  });
}

// finalize: drop the worker when the dashboard unmounts (a StrictMode replay
// respawns it on the next import).
export function disposeImportAnalyzer(): void {
  if (worker === null) return;
  worker.terminate();
  worker = null;
  for (const settle of pending.values()) settle(null);
  pending.clear();
}
