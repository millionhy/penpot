// Binfile import/export (F5.6). Ports the pieces that move .penpot files in
// and out of the dashboard:
// - app.main.data.exports.files: the export-types set and the export-binfile
//   call behind the files export dialog.
// - app.worker.import: the ZIP / legacy analysis and the upload-fed
//   import-binfile pipeline (including the error-message resolution of
//   import-cause-message).
// - the link-file-to-library calls of app.main.ui.dashboard.import and the
//   clone-template / get-builtin-templates commands of app.main.data.dashboard.
//
// The CLJS worker analyzes Blobs behind object URIs; the shell receives the
// picked File objects directly and reads them here, so there is no worker hop
// and no URI lifecycle to manage.
//
// Deviations, documented:
// - export-binfile is sent without the :version 3 the CLJS call site still
//   passes; the backend schema dropped the parameter in 2.12 (see the
//   ::doc/changes entry of export-binfile).
// - The 200 ms pacing the CLJS worker puts between analyze results is
//   dropped; the shell results arrive as the local reads settle.
// - The name-editing path of the import dialog stays unported: it only
//   appears for the removed "legacy-zip" format (editable? requires it).
// - A zip without a manifest reports the CLJS validation hint as a plain
//   Error message ("Not a valid Penpot file: manifest.json is missing");
//   other zip failures carry the reader's own text.

import { RpcError } from "./errors";
import { tr } from "./i18n";
import { cmd, cmdSse } from "./rpc";
import { keyword } from "./transit";
import { uploadBlobChunked } from "./uploads";

// --- export (app.main.data.exports.files) ------------------------------------

// fexp/valid-types, in the display order of the dialog.
export const EXPORT_TYPES = [
  "include-libraries",
  "merge-libraries",
  "detach-libraries",
  "link-later",
] as const;

export type ExportType = (typeof EXPORT_TYPES)[number];

// The export-types binding of the export dialog: the link-later option hides
// behind the export-link-later flag.
export function exportTypeOptions(flags: readonly string[]): ExportType[] {
  return EXPORT_TYPES.filter(
    (type) => type !== "link-later" || flags.includes("export-link-later"),
  );
}

// rp/cmd! ::sse/export-binfile: the stream's "end" payload is the download
// URI of the exported file (public-uri + assets/by-id/<object-id>, valid for
// one hour).
export function exportBinfile(
  fileId: string,
  type: ExportType,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  return cmdSse<string>("export-binfile", { "file-id": fileId, type: keyword(type) }, opts);
}

// --- entry model shared by the import dialog and the pipeline ----------------

export type ImportFormat = "binfile-v1" | "binfile-v3";

export type ImportEntryStatus =
  | "analyze"
  | "import-ready"
  | "import-progress"
  | "import-success"
  | "import-error"
  | "analyze-error";

// One row of the import dialog. A picked file starts as a single "analyze"
// placeholder; each analyze result replaces it with one entry per inner file
// (a v3 zip expands to as many entries as manifest.files, all sharing the
// picked File behind sourceKey).
export interface ImportEntry {
  sourceKey: string;
  file: File;
  name: string;
  fileId: string | null;
  format: ImportFormat | null;
  status: ImportEntryStatus;
  error?: string;
  deleted?: boolean;
}

export interface ImportRunMessage {
  fileId: string;
  status: "finish" | "error";
  error?: string;
}

// The backend's library-resolution payload (add-to-file in app.binfile.v3):
// auto-linked libraries under "done", multi-match libraries under "pending"
// with the candidate libraries the user can pick from.
export interface ResolutionCandidate {
  id: string;
  name: string;
  "project-id": string;
  "project-name": string;
}

export interface ResolutionPending {
  id: string;
  name: string;
  candidates: ResolutionCandidate[];
}

export interface ResolutionDone {
  id: string;
  name: string;
  "linked-to"?: string;
}

export interface FileResolution {
  id: string;
  name: string;
  done: ResolutionDone[];
  pending: ResolutionPending[];
}

export type ImportResolution = Record<string, FileResolution>;

export function hasUnresolved(resolutionFile: FileResolution): boolean {
  return (resolutionFile.pending ?? []).length > 0;
}

// --- ZIP reading -------------------------------------------------------------

// binfile exports are ZIP archives (binfile-v3) or the legacy single-payload
// container (binfile-v1), told apart by the first four bytes (parse-mtype in
// app.worker.import, kept in the octal spelling of the CLJS source: "120 113
// 3 4" is PK\3\4 and "1 13 32 206" is the v1 magic).
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const BINFILE_V1_SIGNATURE = [0x01, 0x0b, 0x1a, 0x86];

export type ImportSniff = "zip" | "binfile-v1" | "unknown";

export function sniffImportFormat(bytes: Uint8Array): ImportSniff {
  const startsWith = (signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (startsWith(ZIP_SIGNATURE)) return "zip";
  if (startsWith(BINFILE_V1_SIGNATURE)) return "binfile-v1";
  return "unknown";
}

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;

interface ZipDirectoryEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 0x100;
}

function readU32(bytes: Uint8Array, offset: number): number {
  const value =
    bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
  return value >>> 0;
}

function readU64(bytes: Uint8Array, offset: number): number {
  return readU32(bytes, offset) + readU32(bytes, offset + 4) * 0x100000000;
}

// End of central directory: fixed 22 bytes plus an optional comment of up to
// 0xffff bytes, so the signature can sit anywhere in the last 65557 bytes.
function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const earliest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (readU32(bytes, offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("The file is not a valid ZIP archive: end of central directory not found");
}

function readZipDirectory(bytes: Uint8Array): ZipDirectoryEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  let count = readU16(bytes, eocd + 10);
  let cdOffset = readU32(bytes, eocd + 16);

  // ZIP64: the 16-bit count / 32-bit offset saturate; the real values live in
  // the ZIP64 EOCD record the locator (directly before the EOCD) points to.
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && readU32(bytes, locator) === ZIP64_LOCATOR_SIGNATURE) {
      const zip64Eocd = readU64(bytes, locator + 8);
      if (readU32(bytes, zip64Eocd) === ZIP64_EOCD_SIGNATURE) {
        count = readU64(bytes, zip64Eocd + 32);
        cdOffset = readU64(bytes, zip64Eocd + 48);
      }
    }
  }

  const entries: ZipDirectoryEntry[] = [];
  let offset = cdOffset;
  for (let index = 0; index < count; index += 1) {
    if (readU32(bytes, offset) !== CENTRAL_SIGNATURE) {
      throw new Error("The file is not a valid ZIP archive: corrupt central directory");
    }
    const method = readU16(bytes, offset + 10);
    const uncompressedSize = readU32(bytes, offset + 24);
    let compressedSize = readU32(bytes, offset + 20);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    let localOffset = readU32(bytes, offset + 42);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    if (
      uncompressedSize === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      // ZIP64 extended information extra field: only the saturated fields are
      // present, in the fixed order uncompressed size, compressed size, local
      // header offset.
      let field = offset + 46 + nameLength;
      const end = field + extraLength;
      while (field + 4 <= end) {
        const id = readU16(bytes, field);
        const size = readU16(bytes, field + 2);
        if (id === ZIP64_EXTRA_ID) {
          let cursor = field + 4;
          if (uncompressedSize === 0xffffffff) cursor += 8;
          if (compressedSize === 0xffffffff) {
            compressedSize = readU64(bytes, cursor);
            cursor += 8;
          }
          if (localOffset === 0xffffffff) {
            localOffset = readU64(bytes, cursor);
          }
          break;
        }
        field += 4 + size;
      }
    }

    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // The reader always hands over a slice of an ArrayBuffer-backed Uint8Array;
  // the assertion only satisfies the Blob/DecompressionStream typings, which
  // exclude the SharedArrayBuffer arm of ArrayBufferLike.
  const source = new Blob([data as Uint8Array<ArrayBuffer>]).stream();
  const inflated = source.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(inflated).arrayBuffer());
}

// uz/get-entry + uz/read-as-text: one entry's bytes, or null when the name is
// not in the archive. Sizes come from the central directory, which is reliable
// even when the local header carries a data descriptor.
export async function readZipEntry(bytes: Uint8Array, name: string): Promise<Uint8Array | null> {
  const entry = readZipDirectory(bytes).find((candidate) => candidate.name === name);
  if (entry === undefined) return null;

  const localOffset = entry.localOffset;
  if (readU32(bytes, localOffset) !== LOCAL_SIGNATURE) {
    throw new Error("The file is not a valid ZIP archive: corrupt local header");
  }
  const nameLength = readU16(bytes, localOffset + 26);
  const extraLength = readU16(bytes, localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const data = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return data; // stored
  if (entry.method === 8) return await inflateRaw(data); // deflate
  throw new Error(
    `The file is not a valid ZIP archive: unsupported compression method ${entry.method}`,
  );
}

export interface ImportManifestFile {
  id: string;
  name: string;
}

interface ZipManifest {
  type: string;
  files: ImportManifestFile[];
}

// read-zip-manifest of the worker: the manifest is mandatory, announces the
// v3 format through its type and lists the inner files as {id, name}.
async function readZipManifest(bytes: Uint8Array): Promise<ZipManifest> {
  const raw = await readZipEntry(bytes, "manifest.json");
  if (raw === null) {
    throw new Error("Not a valid Penpot file: manifest.json is missing");
  }
  const decoded = JSON.parse(new TextDecoder().decode(raw)) as {
    type?: unknown;
    files?: unknown;
  };
  const rows = Array.isArray(decoded.files)
    ? (decoded.files as Array<{ id?: unknown; name?: unknown }>)
    : undefined;
  if (
    typeof decoded.type !== "string" ||
    rows === undefined ||
    rows.some((row) => typeof row.id !== "string" || typeof row.name !== "string")
  ) {
    throw new Error("Not a valid Penpot file: invalid manifest.json");
  }
  return { type: decoded.type, files: rows as ImportManifestFile[] };
}

function createUuid(): string {
  return crypto.randomUUID();
}

// analyze-file of the worker, reading the File directly. Every failure comes
// back as one "analyze-error" entry, like the worker's catch branch: the
// dialog never throws.
export async function analyzeImportFile(picked: { key: string; file: File }): Promise<ImportEntry[]> {
  const fallback = tr("dashboard.import.analyze-error");
  const base = { sourceKey: picked.key, file: picked.file, name: picked.file.name };
  try {
    const bytes = new Uint8Array(await picked.file.arrayBuffer());
    const sniff = sniffImportFormat(bytes);
    if (sniff === "zip") {
      const manifest = await readZipManifest(bytes);
      if (manifest.type === "penpot/export-files") {
        return manifest.files.map((inner) => ({
          ...base,
          name: inner.name,
          fileId: inner.id,
          format: "binfile-v3" as const,
          status: "import-ready" as const,
        }));
      }
      return [{ ...base, fileId: null, format: null, status: "analyze-error", error: fallback }];
    }
    if (sniff === "binfile-v1") {
      return [
        {
          ...base,
          fileId: createUuid(),
          format: "binfile-v1" as const,
          status: "import-ready" as const,
        },
      ];
    }
    return [{ ...base, fileId: null, format: null, status: "analyze-error", error: fallback }];
  } catch (cause) {
    return [
      {
        ...base,
        fileId: null,
        format: null,
        status: "analyze-error",
        error: importCauseMessage(cause, fallback),
      },
    ];
  }
}

// update-with-analyze-result: the placeholder rows (no id yet) are dropped by
// the first result, which then appends or merges by file id.
export function applyAnalyzeUpdate(entries: ImportEntry[], updated: ImportEntry): ImportEntry[] {
  const analyzed = entries.filter((entry) => entry.fileId !== null);
  const index = analyzed.findIndex((entry) => entry.fileId === updated.fileId);
  if (index === -1) return [...analyzed, updated];
  return analyzed.map((entry, entryIndex) =>
    entryIndex === index ? { ...entry, ...updated } : entry,
  );
}

export function isImportReady(entry: ImportEntry): boolean {
  return entry.status === "import-ready" && entry.deleted !== true;
}

// --- import pipeline (app.worker.import :import-files) -----------------------

interface ImportUploadParams {
  name: string;
  version: 1 | 3;
  projectId: string;
}

// upload-blob-chunked + rp/cmd! ::sse/import-binfile: resolves with the end
// payload ({:file-ids, :resolution}).
async function importBinfileUpload(
  file: File,
  params: ImportUploadParams,
  opts: { signal?: AbortSignal },
): Promise<{ "file-ids"?: string[]; resolution?: ImportResolution } | undefined> {
  const { sessionId } = await uploadBlobChunked(file);
  return cmdSse(
    "import-binfile",
    {
      name: params.name,
      version: params.version,
      "upload-id": sessionId,
      "project-id": params.projectId,
    },
    opts,
  );
}

// import-files of the worker: v1 rows upload one by one (.penpot stripped,
// version 1); v3 rows sharing a picked zip upload once (the first name wins,
// version 3) and merge the resolutions the backend reports. onMessage carries
// the per-row "finish" / "error" updates; the merged resolution map resolves
// when every upload settled.
export async function runImport(
  projectId: string,
  entries: ImportEntry[],
  onMessage: (message: ImportRunMessage) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<ImportResolution> {
  const resolutions: ImportResolution = {};
  const tasks: Promise<void>[] = [];
  const failure = (cause: unknown) =>
    importCauseMessage(cause, tr("labels.error"));

  for (const entry of entries) {
    const fileId = entry.fileId;
    if (fileId === null || entry.format !== "binfile-v1") continue;
    tasks.push(
      importBinfileUpload(
        entry.file,
        {
          // The CLJS source writes the regex as #".penpot$": the dot is
          // unescaped there and kept as-is here.
          name: entry.name.replace(/.penpot$/, ""),
          version: 1,
          projectId,
        },
        opts,
      ).then(
        () => onMessage({ fileId, status: "finish" }),
        (cause: unknown) => onMessage({ fileId, status: "error", error: failure(cause) }),
      ),
    );
  }

  const groups = new Map<string, { file: File; rows: Array<{ fileId: string; name: string }> }>();
  for (const entry of entries) {
    const fileId = entry.fileId;
    if (entry.format !== "binfile-v3" || fileId === null) continue;
    const group = groups.get(entry.sourceKey);
    if (group === undefined) {
      groups.set(entry.sourceKey, { file: entry.file, rows: [{ fileId, name: entry.name }] });
    } else {
      group.rows.push({ fileId, name: entry.name });
    }
  }
  for (const group of groups.values()) {
    const first = group.rows[0];
    if (first === undefined) continue;
    tasks.push(
      importBinfileUpload(group.file, { name: first.name, version: 3, projectId }, opts).then(
        (result) => {
          const resolution = result?.resolution;
          if (resolution !== undefined && resolution !== null && Object.keys(resolution).length > 0) {
            Object.assign(resolutions, resolution);
          }
          for (const row of group.rows) onMessage({ fileId: row.fileId, status: "finish" });
        },
        (cause: unknown) => {
          const error = failure(cause);
          for (const row of group.rows) onMessage({ fileId: row.fileId, status: "error", error });
        },
      ),
    );
  }

  await Promise.all(tasks);
  return resolutions;
}

// import-cause-message of the worker: the server hint wins, then explain,
// then any specific message; the generic stream wrappers fall back to the
// given default.
export function importCauseMessage(cause: unknown, fallback: string): string {
  if (cause instanceof RpcError) {
    const hint = typeof cause.data.hint === "string" ? cause.data.hint.trim() : "";
    if (hint.length > 0) return hint;
    const explain = typeof cause.data.explain === "string" ? cause.data.explain.trim() : "";
    if (explain.length > 0) return explain;
  }
  const message = cause instanceof Error ? cause.message.trim() : "";
  if (
    message.length === 0 ||
    message === "stream exception" || // ex-info message in app.util.sse
    message === "sse stream exception" // lib/rpc.ts cmdSse
  ) {
    return fallback;
  }
  return message;
}

// --- libraries + templates ---------------------------------------------------

// rp/cmd! :has-file-libraries: whether the file links any library (drives the
// export dialog's auto-start).
export async function hasFileLibraries(fileId: string): Promise<boolean> {
  const result = await cmd<unknown>("has-file-libraries", { "file-id": fileId });
  return result === true;
}

// rp/cmd! :link-file-to-library: the confirm step of the resolution wizard.
export function linkFileToLibrary(
  fileId: string,
  libraryId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  return cmd("link-file-to-library", { "file-id": fileId, "library-id": libraryId }, opts);
}

export interface BuiltinTemplate {
  id: string;
  name: string;
}

// dd/fetch-builtin-templates: get-builtin-templates; both fields are strings.
export async function getBuiltinTemplates(): Promise<BuiltinTemplate[]> {
  const rows = await cmd<BuiltinTemplate[]>("get-builtin-templates", {});
  return Array.isArray(rows) ? rows : [];
}

// dd/clone-template (SSE): resolves when the project carries the template's
// cloned files.
export function cloneTemplate(
  projectId: string,
  templateId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<unknown> {
  return cmdSse("clone-template", { "project-id": projectId, "template-id": templateId }, opts);
}
