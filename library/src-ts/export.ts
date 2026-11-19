// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// Port of `lib.export`: it turns the builder state into the entries of a
// `.penpot` archive. The layout and the JSON shapes follow `export.cljs` so
// the files the penpot frontend imports stay identical.

import {
  BlobReader,
  BlobWriter,
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";

import type { Reader } from "@zip.js/zip.js";

import type { BuildContext } from "./api.ts";
import { withoutNils } from "./data.ts";
import { fail } from "./errors.ts";
import { mtypeToExtension } from "./media.ts";
import type {
  BuilderState,
  LibraryColor,
  LibraryTypography,
  Page,
  PathSegment,
  PenpotFile,
  Shape,
  Uuid,
} from "./model.ts";
import { RAW_STATE } from "./state.ts";
import { LIBRARY_VERSION } from "./version.ts";

/** The payload of one archive entry, read lazily when the entry is added. */
export type EntryData = string | Uint8Array | ArrayBuffer | Blob;

export interface ExportEntry {
  readonly path: string;
  readonly read: () => EntryData;
}

export interface ExportProgress {
  readonly total: number;
  readonly item: number;
  readonly path: string;
}

export interface ExportOptions {
  readonly onProgress?: (progress: ExportProgress) => void;
}

// ---------------------------------------------------------------------------
// JSON encoding
// ---------------------------------------------------------------------------

/**
 * The builder state already holds the JSON face of the CLJS records: strings
 * for keywords, ISO strings for instants and arrays for sets. `json/encode`
 * in the CLJS side is `JSON.stringify` after a keyword/collection walk, so a
 * plain `stringify` reproduces the same documents.
 */
function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function encodeFile(file: PenpotFile): string {
  // `generate-file-export-procs` selects a fixed set of attributes and adds
  // the file options when the data carries them.
  const data: Record<string, unknown> = {
    features: file.features,
    name: file.name,
    id: file.id,
    isShared: file.isShared,
    migrations: file.migrations,
    version: file.version,
  };

  if (file.data.options != null) data.options = file.data.options;

  return encodeJson(data);
}

function encodePage(page: Page, index: number): string {
  return encodeJson({ id: page.id, name: page.name, index });
}

function encodeShape(shape: Shape, pageId: Uuid): string {
  const data: Record<string, unknown> = { ...shape, pageId };

  // Path and bool content is a vector of segments in the archive. `(vec nil)`
  // in the CLJS encoder yields an empty vector.
  if (shape.type === "path" || shape.type === "bool") {
    data.content = Array.isArray(shape.content)
      ? [...(shape.content as PathSegment[])]
      : [];
  }

  return encodeJson(data);
}

function encodeColor(color: LibraryColor): string {
  const { fileId: _fileId, ...data } = color;

  if (data.path === "") delete data.path;

  return encodeJson(data);
}

function encodeTypography(typography: LibraryTypography): string {
  return encodeJson(typography);
}

function encodeFileMedia(fileMedia: { fileId: Uuid; [attr: string]: unknown }) {
  const { fileId: _fileId, ...data } = fileMedia;
  return encodeJson(data);
}

function encodeManifest(state: BuilderState): string {
  const files = Object.entries(state.files ?? {}).map(([id, file]) => ({
    id,
    name: file.name,
    features: file.features,
  }));

  const params = {
    type: "penpot/export-files",
    version: 1,
    generatedBy: `penpot-library/${LIBRARY_VERSION}`,
    referer: state.options?.referer,
    files,
    relations: Object.entries(state.relations ?? {}),
  };

  return encodeJson(withoutNils(params));
}

// ---------------------------------------------------------------------------
// Entry generation
// ---------------------------------------------------------------------------

function fileEntries(file: PenpotFile): ExportEntry[] {
  const entries: ExportEntry[] = [];
  const { id, data } = file;

  entries.push({ path: `files/${id}.json`, read: () => encodeFile(file) });

  (data.pages ?? []).forEach((pageId, index) => {
    const page = data.pagesIndex?.[pageId];
    if (page == null) return;

    entries.push({
      path: `files/${id}/pages/${pageId}.json`,
      read: () => encodePage(page, index),
    });

    for (const [shapeId, shape] of Object.entries(page.objects ?? {})) {
      entries.push({
        path: `files/${id}/pages/${pageId}/${shapeId}.json`,
        read: () => encodeShape(shape, pageId),
      });
    }
  });

  for (const [componentId, component] of Object.entries(data.components ?? {})) {
    entries.push({
      path: `files/${id}/components/${componentId}.json`,
      read: () => encodeJson(component),
    });
  }

  for (const [colorId, color] of Object.entries(data.colors ?? {})) {
    entries.push({
      path: `files/${id}/colors/${colorId}.json`,
      read: () => encodeColor(color),
    });
  }

  for (const [typographyId, typography] of Object.entries(
    data.typographies ?? {},
  )) {
    entries.push({
      path: `files/${id}/typographies/${typographyId}.json`,
      read: () => encodeTypography(typography),
    });
  }

  if (data.tokensLib != null) {
    entries.push({
      path: `files/${id}/tokens.json`,
      read: () => encodeJson(data.tokensLib),
    });
  }

  return entries;
}

function mediaEntries(state: BuilderState): ExportEntry[] {
  const entries: ExportEntry[] = [];

  for (const [fileMediaId, fileMedia] of Object.entries(state.fileMedia ?? {})) {
    const mediaId = fileMedia.mediaId;
    const media = state.media?.[mediaId];
    const blob = state.blobs?.[mediaId];

    entries.push({
      path: `objects/${mediaId}${mtypeToExtension(media?.contentType)}`,
      read: () => {
        if (blob == null) {
          fail("assertion", "invalid-type", "missing blob for media object");
        }
        return blob.blob;
      },
    });

    entries.push({
      path: `objects/${mediaId}.json`,
      read: () => encodeJson(media),
    });

    entries.push({
      path: `files/${fileMedia.fileId}/media/${fileMediaId}.json`,
      read: () => encodeFileMedia(fileMedia),
    });
  }

  return entries;
}

/** Builds the archive entries in the order `export.cljs` writes them. */
export function collectEntries(state: BuilderState): ExportEntry[] {
  const entries: ExportEntry[] = [
    { path: "manifest.json", read: () => encodeManifest(state) },
  ];

  for (const file of Object.values(state.files ?? {})) {
    entries.push(...fileEntries(file));
  }

  entries.push(...mediaEntries(state));
  return entries;
}

// ---------------------------------------------------------------------------
// Archive writing
// ---------------------------------------------------------------------------

function toReader(data: EntryData): Reader<unknown> {
  if (typeof data === "string") return new TextReader(data);
  if (data instanceof Uint8Array) return new Uint8ArrayReader(data);
  if (data instanceof ArrayBuffer) return new Uint8ArrayReader(new Uint8Array(data));
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new BlobReader(data);
  }

  return fail("assertion", "invalid-type", "invalid data received for zip/add fn");
}

function stateOf(context: BuildContext): BuilderState {
  return context[RAW_STATE]();
}

async function writeEntries<Type>(
  writer: ZipWriter<Type>,
  state: BuilderState,
  options?: ExportOptions,
): Promise<Type> {
  const entries = collectEntries(state);
  const total = entries.length;

  for (const [index, entry] of entries.entries()) {
    await writer.add(entry.path, toReader(entry.read()));
    options?.onProgress?.({ total, item: index + 1, path: entry.path });
  }

  return writer.close();
}

/** Exports the context as a `.penpot` archive in memory. */
export async function exportAsBytes(
  context: BuildContext,
  options?: ExportOptions,
): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  return writeEntries(writer, stateOf(context), options);
}

/** Exports the context as a `.penpot` blob. */
export async function exportAsBlob(
  context: BuildContext,
  options?: ExportOptions,
): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter("application/octet-stream"));
  return writeEntries(writer, stateOf(context), options);
}

/** Streams the `.penpot` archive into a writable stream. */
export async function exportStream(
  context: BuildContext,
  stream: WritableStream<Uint8Array>,
  options?: ExportOptions,
): Promise<void> {
  const writer = new ZipWriter(stream);
  await writeEntries(writer, stateOf(context), options);
}
