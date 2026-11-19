// app.handlers.resources: the ephemeral file a render writes into, the optional
// zip for multi-object exports, and the upload that turns the file into a
// temporary backend resource.
//
// A created resource is scheduled for deletion an hour from now (that is
// app.util.shell) and the job tracker keeps it alive only for the run. archiver
// and undici are loaded lazily: the exporter bundle ships without them today.

import { createWriteStream } from "node:fs";
import { readFile as readFileP } from "node:fs/promises";
import path from "node:path";
import { getInternalUri, managementKey } from "../config.js";
import { load } from "../deps.js";
import { raise } from "../errors.js";
import { decode } from "../transit.js";
import { ensurePathSlash, join } from "../uri.js";
import { next as nextUuid } from "../uuid.js";
import { get as getMime, getExtension, type ExportType } from "../util/mime.js";
import { getTmpdir, scheduleDeletion } from "../util/shell.js";

// The handle a command holds before the upload: the file does not exist yet,
// so there is no uri or size, just the names the response and the zip need.
export interface ResourceHandle {
  id: string;
  name: string;
  path: string;
  filename: string;
  mtype: string;
  [key: string]: unknown;
}

const SANITIZE = /[\\/:*?"<>|]/g;

function getPath(type: ExportType, id: string): string {
  return path.join(getTmpdir(), `penpot.resource.${type}.${id}`);
}

// Generates the ephemeral resource object a command hands to the job.
export function create(type: ExportType, name: string): ResourceHandle {
  const id = nextUuid();

  return {
    path: scheduleDeletion(getPath(type, id)),
    mtype: getMime(type),
    name,
    filename: `${name.replace(SANITIZE, "_")}${getExtension(type)}`,
    id,
  };
}

// --- ZIP

interface ArchiverEntry {
  name: string;
}

interface ZipArchive {
  on(event: "error", listener: (cause: unknown) => void): this;
  on(event: "end" | "close", listener: () => void): this;
  on(event: "entry", listener: (data: ArchiverEntry) => void): this;
  pipe(destination: unknown): void;
  file(filePath: string, options: { name: string }): void;
  finalize(): void;
}

interface ArchiverModule {
  ZipArchive: new () => ZipArchive;
}

let archiverModule: ArchiverModule | undefined;

// archiver is only needed for multi object exports; the tests supply a small
// stand-in instead of the real package.
export function setArchiverModule(next: ArchiverModule | undefined): void {
  archiverModule = next;
}

function archiver(): ArchiverModule {
  if (archiverModule === undefined) archiverModule = load<ArchiverModule>("archiver");
  return archiverModule;
}

export interface ZipOptions {
  resource: ResourceHandle;
  onComplete?: () => void;
  onProgress?: (progress: { done: number; filename: string }) => void;
  onError?: (cause: unknown) => void;
}

export function createZip(options: ZipOptions): ZipArchive {
  const zip = new (archiver().ZipArchive)();
  const out = createWriteStream(options.resource.path);
  let progress = 0;

  zip.on("error", options.onError ?? (() => undefined));
  zip.on("end", options.onComplete ?? (() => undefined));
  zip.on("entry", (data) => {
    progress += 1;
    options.onProgress?.({ done: progress, filename: data.name });
  });

  zip.pipe(out);
  return zip;
}

export function addToZip(zip: ZipArchive, filePath: string, name: string): void {
  zip.file(filePath, { name });
}

export function closeZip(zip: ZipArchive): Promise<void> {
  return new Promise<void>((resolve) => {
    zip.on("close", resolve);
    zip.finalize();
  });
}

// --- UPLOAD

export interface UploadedResource extends ResourceHandle {
  [key: string]: unknown;
}

interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: FormData;
  dispatcher?: unknown;
}

// The backend may be reached over https with a self signed certificate in a
// local deployment; undici is only needed for that case.
function dispatcherFor(uri: URL): unknown {
  if (uri.protocol !== "https:") return undefined;
  const undici = load<{ Agent: new (options: unknown) => unknown }>("undici");
  return new undici.Agent({ connect: { rejectUnauthorized: false } });
}

export async function uploadResource(
  authToken: string | undefined,
  resource: ResourceHandle,
): Promise<UploadedResource> {
  const buffer = await readFileP(resource.path);
  const blob = new Blob([new Uint8Array(buffer)], { type: resource.mtype });

  const form = new FormData();
  form.append("content", blob, resource.filename);

  const uri = new URL(join(ensurePathSlash(getInternalUri()), "api/management/methods/upload-tempfile"));
  const init: FetchInit = {
    headers: {
      "X-Shared-Key": `exporter ${managementKey()}`,
      Authorization: `Bearer ${authToken ?? ""}`,
    },
    method: "POST",
    body: form,
  };

  const dispatcher = dispatcherFor(uri);
  if (dispatcher !== undefined) init.dispatcher = dispatcher;

  const response = await fetch(uri, init as unknown as RequestInit);

  if (response.status !== 200) {
    return raise({
      type: "internal",
      code: "unable-to-upload-resource",
      hint: "unable to upload the exported resource",
      "response-status": response.status,
    });
  }

  const result = decode<Record<string, unknown>>(await response.text());
  const { id: _id, ...rest } = result;
  return { ...resource, ...rest };
}