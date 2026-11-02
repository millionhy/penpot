// Unit tests for the main-thread half of the import worker
// (lib/import-analyze-worker-client). The node environment has no window and
// no browser Worker, so the module must answer null and let the caller fall
// back to the synchronous reader; the worker itself is exercised by the
// binfile tests through the same fallback.

import { describe, expect, it } from "vitest";

import {
  analyzeImportFileOffThread,
  disposeImportAnalyzer,
} from "@/lib/import-analyze-worker-client";

describe("analyzeImportFileOffThread", () => {
  it("answers null without a browser worker, so the caller reads synchronously", async () => {
    disposeImportAnalyzer();
    const file = new File([new Uint8Array([1, 2, 3])], "file.penpot");
    await expect(analyzeImportFileOffThread(file)).resolves.toBeNull();
  });

  it("keeps answering null after a disposal", async () => {
    const file = new File([new Uint8Array(1)], "file.penpot");
    await analyzeImportFileOffThread(file);
    disposeImportAnalyzer();
    await expect(analyzeImportFileOffThread(file)).resolves.toBeNull();
  });
});
