// Unit tests for the binfile module: the ZIP reader the analyzer rides on,
// the analyze-result reducer, the export-type flag gate and the import
// pipeline grouping. The reader is exercised against archives built here, so
// the suite does not need the real Penpot writer.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/uploads", () => ({
  uploadBlobChunked: vi.fn(async () => ({ sessionId: "session-1" })),
}));

vi.mock("@/lib/rpc", () => ({
  cmd: vi.fn(),
  cmdSse: vi.fn(),
}));

import { cmdSse } from "@/lib/rpc";
import { uploadBlobChunked } from "@/lib/uploads";
import { RpcError } from "@/lib/errors";
import { tr } from "@/lib/i18n";
import {
  analyzeImportFile,
  applyAnalyzeUpdate,
  exportTypeOptions,
  importCauseMessage,
  readZipEntry,
  runImport,
  sniffImportFormat,
  type ImportEntry,
} from "@/lib/binfile";

const cmdSseMock = vi.mocked(cmdSse);
const uploadMock = vi.mocked(uploadBlobChunked);

// --- zip builder -------------------------------------------------------------

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >> 8) & 0xff;
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const source = new Blob([data as Uint8Array<ArrayBuffer>]).stream();
  const compressed = source.pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

interface ZipInput {
  name: string;
  content: string | Uint8Array;
  deflate?: boolean;
}

async function buildZip(files: ZipInput[]): Promise<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const entries: Array<{
    name: Uint8Array;
    method: number;
    data: Uint8Array;
    raw: Uint8Array;
    offset: number;
  }> = [];
  let offset = 0;

  for (const file of files) {
    const raw = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
    const method = file.deflate === true ? 8 : 0;
    const data = method === 8 ? await deflateRaw(raw) : raw;
    const name = encoder.encode(file.name);
    const local = new Uint8Array(30 + name.length);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 4, 20);
    writeU16(local, 8, method);
    writeU32(local, 18, data.length);
    writeU32(local, 22, raw.length);
    writeU16(local, 26, name.length);
    local.set(name, 30);
    entries.push({ name, method, data, raw, offset });
    parts.push(local, data);
    offset += local.length + data.length;
  }

  const cdOffset = offset;
  for (const entry of entries) {
    const central = new Uint8Array(46 + entry.name.length);
    writeU32(central, 0, 0x02014b50);
    writeU16(central, 4, 20);
    writeU16(central, 6, 20);
    writeU16(central, 10, entry.method);
    writeU32(central, 20, entry.data.length);
    writeU32(central, 24, entry.raw.length);
    writeU16(central, 28, entry.name.length);
    writeU32(central, 42, entry.offset);
    central.set(entry.name, 46);
    parts.push(central);
    offset += central.length;
  }

  const eocd = new Uint8Array(22);
  writeU32(eocd, 0, 0x06054b50);
  writeU16(eocd, 8, entries.length);
  writeU16(eocd, 10, entries.length);
  writeU32(eocd, 12, offset - cdOffset);
  writeU32(eocd, 16, cdOffset);
  parts.push(eocd);

  const total = parts.reduce((size, part) => size + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// --- sniffing ----------------------------------------------------------------

describe("sniffImportFormat", () => {
  it("recognizes the PK\\3\\4 zip magic", () => {
    expect(sniffImportFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe("zip");
  });

  it("recognizes the binfile-v1 magic", () => {
    expect(sniffImportFormat(new Uint8Array([0x01, 0x0b, 0x1a, 0x86, 0x00]))).toBe("binfile-v1");
  });

  it("returns unknown for anything else, including short input", () => {
    expect(sniffImportFormat(new Uint8Array([1, 2, 3, 4]))).toBe("unknown");
    expect(sniffImportFormat(new Uint8Array([0x50, 0x4b]))).toBe("unknown");
    expect(sniffImportFormat(new Uint8Array(0))).toBe("unknown");
  });
});

// --- zip reading -------------------------------------------------------------

describe("readZipEntry", () => {
  it("reads a stored entry", async () => {
    const zip = await buildZip([{ name: "hello.txt", content: "hello world" }]);
    const found = await readZipEntry(zip, "hello.txt");
    expect(found).not.toBeNull();
    expect(new TextDecoder().decode(found as Uint8Array)).toBe("hello world");
  });

  it("inflates a deflated entry", async () => {
    const zip = await buildZip([{ name: "manifest.json", content: '{"a":1}', deflate: true }]);
    const found = await readZipEntry(zip, "manifest.json");
    expect(new TextDecoder().decode(found as Uint8Array)).toBe('{"a":1}');
  });

  it("picks the right entry among several", async () => {
    const zip = await buildZip([
      { name: "first.bin", content: "one", deflate: true },
      { name: "second.bin", content: "two" },
    ]);
    const found = await readZipEntry(zip, "second.bin");
    expect(new TextDecoder().decode(found as Uint8Array)).toBe("two");
  });

  it("returns null for a missing entry", async () => {
    const zip = await buildZip([{ name: "hello.txt", content: "hello" }]);
    expect(await readZipEntry(zip, "missing.json")).toBeNull();
  });

  it("throws for bytes that are not a zip", async () => {
    await expect(readZipEntry(new Uint8Array([1, 2, 3, 4, 5, 6]), "x")).rejects.toThrow(
      /not a valid ZIP/,
    );
  });
});

// --- analyze -----------------------------------------------------------------

describe("analyzeImportFile", () => {
  it("expands a v3 manifest into one import-ready entry per inner file", async () => {
    const manifest = JSON.stringify({
      type: "penpot/export-files",
      files: [
        { id: "11111111-1111-4111-8111-111111111111", name: "Page one" },
        { id: "22222222-2222-4222-8222-222222222222", name: "Page two" },
      ],
    });
    const zip = await buildZip([{ name: "manifest.json", content: manifest, deflate: true }]);
    const file = new File([zip], "export.penpot");

    const entries = await analyzeImportFile({ key: "k1", file });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      sourceKey: "k1",
      file,
      name: "Page one",
      fileId: "11111111-1111-4111-8111-111111111111",
      format: "binfile-v3",
      status: "import-ready",
    });
    expect(entries[1]?.name).toBe("Page two");
  });

  it("flags a zip whose manifest announces another type", async () => {
    const zip = await buildZip([{ name: "manifest.json", content: '{"type":"other","files":[]}' }]);
    const file = new File([zip], "export.penpot");

    const entries = await analyzeImportFile({ key: "k1", file });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("analyze-error");
    expect(entries[0]?.error).toBe(tr("dashboard.import.analyze-error"));
  });

  it("flags a zip without a manifest with the worker's hint", async () => {
    const zip = await buildZip([{ name: "readme.txt", content: "hi" }]);
    const file = new File([zip], "export.penpot");

    const entries = await analyzeImportFile({ key: "k1", file });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("analyze-error");
    expect(entries[0]?.error).toBe("Not a valid Penpot file: manifest.json is missing");
  });

  it("treats the v1 magic as a legacy single file with a fresh id", async () => {
    const file = new File([new Uint8Array([0x01, 0x0b, 0x1a, 0x86, 0x00, 0x00])], "legacy.penpot");

    const entries = await analyzeImportFile({ key: "k1", file });

    expect(entries).toHaveLength(1);
    const entry = entries[0] as ImportEntry;
    expect(entry.status).toBe("import-ready");
    expect(entry.format).toBe("binfile-v1");
    expect(entry.name).toBe("legacy.penpot");
    expect(entry.fileId).toMatch(UUID_RE);
  });

  it("flags unrecognized bytes as an analyze error", async () => {
    const file = new File([new Uint8Array([9, 9, 9, 9])], "junk.bin");

    const entries = await analyzeImportFile({ key: "k1", file });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("analyze-error");
    expect(entries[0]?.error).toBe(tr("dashboard.import.analyze-error"));
  });
});

// --- analyze reducer ---------------------------------------------------------

describe("applyAnalyzeUpdate", () => {
  const file = new File([new Uint8Array(1)], "f.penpot");
  const placeholder: ImportEntry = {
    sourceKey: "k",
    file,
    name: "f.penpot",
    fileId: null,
    format: null,
    status: "analyze",
  };
  const analyzed: ImportEntry = {
    ...placeholder,
    fileId: "id-1",
    format: "binfile-v1",
    status: "import-ready",
  };

  it("drops the placeholders when the first result arrives", () => {
    expect(applyAnalyzeUpdate([placeholder], analyzed)).toEqual([analyzed]);
  });

  it("merges a later result into the analyzed entry with the same id", () => {
    const finished = { ...analyzed, status: "import-success" as const };
    expect(applyAnalyzeUpdate([analyzed], finished)).toEqual([finished]);
  });

  it("appends error entries without an id, which the next result drops again", () => {
    const failed: ImportEntry = { ...placeholder, status: "analyze-error", error: "boom" };
    const other: ImportEntry = { ...analyzed, fileId: "id-2" };

    expect(applyAnalyzeUpdate([analyzed], failed)).toEqual([analyzed, failed]);
    expect(applyAnalyzeUpdate([analyzed, failed], other)).toEqual([analyzed, other]);
  });
});

// --- export types ------------------------------------------------------------

describe("exportTypeOptions", () => {
  it("hides link-later without the flag", () => {
    expect(exportTypeOptions([])).toEqual([
      "include-libraries",
      "merge-libraries",
      "detach-libraries",
    ]);
  });

  it("shows all four with the flag", () => {
    expect(exportTypeOptions(["export-link-later"])).toEqual([
      "include-libraries",
      "merge-libraries",
      "detach-libraries",
      "link-later",
    ]);
  });
});

// --- import pipeline ---------------------------------------------------------

describe("runImport", () => {
  it("uploads a v1 file with the .penpot suffix stripped", async () => {
    cmdSseMock.mockReset();
    uploadMock.mockClear();
    cmdSseMock.mockResolvedValueOnce({ "file-ids": ["id-1"], resolution: {} });
    const file = new File([new Uint8Array(2)], "design.penpot");
    const entries: ImportEntry[] = [
      { sourceKey: "k", file, name: "design.penpot", fileId: "id-1", format: "binfile-v1", status: "import-ready" },
    ];
    const messages: unknown[] = [];

    const resolution = await runImport("project-1", entries, (message) => messages.push(message));

    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(cmdSseMock).toHaveBeenCalledWith(
      "import-binfile",
      { name: "design", version: 1, "upload-id": "session-1", "project-id": "project-1" },
      expect.anything(),
    );
    expect(messages).toEqual([{ fileId: "id-1", status: "finish" }]);
    expect(resolution).toEqual({});
  });

  it("uploads a v3 zip once and finishes every entry of the group", async () => {
    cmdSseMock.mockReset();
    uploadMock.mockClear();
    cmdSseMock.mockResolvedValueOnce({
      "file-ids": ["id-a", "id-b"],
      resolution: { "id-a": { id: "id-a", name: "Page one", done: [], pending: [] } },
    });
    const file = new File([new Uint8Array(2)], "export.penpot");
    const entries: ImportEntry[] = [
      { sourceKey: "k", file, name: "Page one", fileId: "id-a", format: "binfile-v3", status: "import-ready" },
      { sourceKey: "k", file, name: "Page two", fileId: "id-b", format: "binfile-v3", status: "import-ready" },
    ];
    const messages: unknown[] = [];

    const resolution = await runImport("project-1", entries, (message) => messages.push(message));

    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(cmdSseMock).toHaveBeenCalledWith(
      "import-binfile",
      { name: "Page one", version: 3, "upload-id": "session-1", "project-id": "project-1" },
      expect.anything(),
    );
    expect(messages).toEqual([
      { fileId: "id-a", status: "finish" },
      { fileId: "id-b", status: "finish" },
    ]);
    expect(resolution).toEqual({ "id-a": { id: "id-a", name: "Page one", done: [], pending: [] } });
  });

  it("reports every entry of a failed v3 group with the server hint", async () => {
    cmdSseMock.mockReset();
    uploadMock.mockClear();
    cmdSseMock.mockRejectedValueOnce(
      new RpcError("sse stream exception", { type: "internal", hint: "backend says no" }),
    );
    const file = new File([new Uint8Array(2)], "export.penpot");
    const entries: ImportEntry[] = [
      { sourceKey: "k", file, name: "Page one", fileId: "id-a", format: "binfile-v3", status: "import-ready" },
      { sourceKey: "k", file, name: "Page two", fileId: "id-b", format: "binfile-v3", status: "import-ready" },
    ];
    const messages: Array<{ status: string; error?: string }> = [];

    await runImport("project-1", entries, (message) => messages.push(message));

    expect(messages).toEqual([
      { fileId: "id-a", status: "error", error: "backend says no" },
      { fileId: "id-b", status: "error", error: "backend says no" },
    ]);
  });
});

// --- error messages ----------------------------------------------------------

describe("importCauseMessage", () => {
  it("prefers the server hint, then explain", () => {
    expect(
      importCauseMessage(new RpcError("sse stream exception", { type: "validation", hint: " hint " }), "fallback"),
    ).toBe("hint");
    expect(
      importCauseMessage(new RpcError("sse stream exception", { type: "validation", explain: "why" }), "fallback"),
    ).toBe("why");
  });

  it("falls back for the generic stream wrappers", () => {
    expect(importCauseMessage(new Error("stream exception"), "fallback")).toBe("fallback");
    expect(importCauseMessage(new Error("sse stream exception"), "fallback")).toBe("fallback");
    expect(importCauseMessage(new Error(""), "fallback")).toBe("fallback");
  });

  it("keeps any specific message", () => {
    expect(importCauseMessage(new Error("Not a valid Penpot file"), "fallback")).toBe(
      "Not a valid Penpot file",
    );
  });
});
