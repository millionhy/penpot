// The import-analysis worker (F5.6): the off-thread half of
// analyzeImportFile.
//
// The CLJS shell handed every picked Blob to app.worker.import, which read
// the container, sniffed the format and inflated the manifest; this worker
// keeps that shape. The dashboard thread only receives the plain analysis
// (a format plus the manifest rows), so a large export never blocks it.
//
// The worker shares the byte-level reader with the synchronous fallback
// (analyzeImportBytes in lib/binfile), so the two paths cannot drift.

import { analyzeImportBytes } from "@/lib/binfile";

interface AnalyzeRequest {
  id: number;
  file: File;
}

// A structural cast instead of DedicatedWorkerGlobalScope: the project's
// tsconfig also loads the DOM lib, whose `self` would conflict.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

scope.onmessage = (event: MessageEvent<AnalyzeRequest>): void => {
  const { id, file } = event.data;
  void (async () => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      scope.postMessage({ id, result: await analyzeImportBytes(bytes) });
    } catch (cause: unknown) {
      // The dialog maps the message through importCauseMessage, like the
      // synchronous reader does.
      scope.postMessage({
        id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  })();
};
