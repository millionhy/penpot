// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BlobReader,
  TextWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
} from "@zip.js/zip.js";

import type { FileEntry } from "@zip.js/zip.js";

import { createBuildContext, exportAsBlob, exportAsBytes, exportStream } from "../src-ts/index.ts";
import { LIBRARY_VERSION } from "../src-ts/version.ts";
import { ZERO } from "../src-ts/uuid.ts";

type Json = Record<string, any>;

interface OpenZip {
  readonly paths: string[];
  entry(name: string): FileEntry;
  close(): Promise<void>;
}

async function openZip(bytes: Uint8Array): Promise<OpenZip> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    useWebWorkers: false,
  });
  const entries = await reader.getEntries();
  const byName = new Map<string, FileEntry>();

  for (const entry of entries) {
    if (entry.directory) continue;
    byName.set(entry.filename, entry as FileEntry);
  }

  return {
    paths: [...byName.keys()],
    entry(name) {
      const entry = byName.get(name);
      assert.ok(entry, `missing zip entry ${name}`);
      return entry;
    },
    close: () => reader.close(),
  };
}

async function readJson(zip: OpenZip, name: string): Promise<Json> {
  return JSON.parse(await zip.entry(name).getData(new TextWriter()));
}

function buildFile(context: ReturnType<typeof createBuildContext>) {
  const fileId = context.addFile({ name: "sample" });
  const pageId = context.addPage({ name: "Page 1" });
  return { fileId, pageId };
}

test("exports one file with its page and shapes", async () => {
  const context = createBuildContext();
  const { fileId, pageId } = buildFile(context);

  const rectId = context.addRect({
    name: "Rect 1",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });

  const zip = await openZip(await exportAsBytes(context));

  assert.deepEqual(zip.paths, [
    "manifest.json",
    `files/${fileId}.json`,
    `files/${fileId}/pages/${pageId}.json`,
    `files/${fileId}/pages/${pageId}/${ZERO}.json`,
    `files/${fileId}/pages/${pageId}/${rectId}.json`,
  ]);

  const state = context.getInternalState() as Json;
  const file = state.files[fileId];

  const manifest = await readJson(zip, "manifest.json");
  assert.deepEqual(manifest, {
    type: "penpot/export-files",
    version: 1,
    generatedBy: `penpot-library/${LIBRARY_VERSION}`,
    files: [{ id: fileId, name: "sample", features: file.features }],
    relations: [],
  });

  const exportedFile = await readJson(zip, `files/${fileId}.json`);
  assert.deepEqual(Object.keys(exportedFile).sort(), [
    "features",
    "id",
    "isShared",
    "migrations",
    "name",
    "options",
    "version",
  ]);
  assert.equal(exportedFile.id, fileId);
  assert.equal(exportedFile.version, 67);
  assert.equal(exportedFile.isShared, false);
  assert.deepEqual(exportedFile.migrations, file.migrations);
  assert.equal(exportedFile.migrations.length, 84);
  assert.deepEqual(exportedFile.options, {
    componentsV2: true,
    baseFontSize: "16px",
  });

  assert.deepEqual(await readJson(zip, `files/${fileId}/pages/${pageId}.json`), {
    id: pageId,
    name: "Page 1",
    index: 0,
  });

  const rect = await readJson(zip, `files/${fileId}/pages/${pageId}/${rectId}.json`);
  assert.equal(rect.name, "Rect 1");
  assert.equal(rect.pageId, pageId);
  assert.equal(rect.frameId, ZERO);
  assert.equal(rect.selrect.width, 1);

  await zip.close();
});

test("path content is exported as segments", async () => {
  const context = createBuildContext();
  const { fileId, pageId } = buildFile(context);

  const pathId = context.addPath({
    content: [
      { command: "move-to", params: { x: 480, y: 839 } },
      { command: "line-to", params: { x: 439, y: 802 } },
      {
        command: "curve-to",
        params: { c1x: 368, c1y: 737, c2x: 310, c2y: 681, x: 264, y: 634 },
      },
      { command: "close-path", params: {} },
    ],
  });

  const zip = await openZip(await exportAsBytes(context));
  const path = await readJson(zip, `files/${fileId}/pages/${pageId}/${pathId}.json`);

  assert.equal(path.type, "path");
  assert.equal(path.x, null);
  assert.equal(path.selrect.width, 216);
  assert.deepEqual(path.content, [
    { command: "move-to", params: { x: 480, y: 839 } },
    { command: "line-to", params: { x: 439, y: 802 } },
    {
      command: "curve-to",
      params: { c1x: 368, c1y: 737, c2x: 310, c2y: 681, x: 264, y: 634 },
    },
    { command: "close-path", params: {} },
  ]);

  await zip.close();
});

test("colors and typographies keep the reference layout", async () => {
  const context = createBuildContext();
  const { fileId } = buildFile(context);

  const colorId = context.addLibraryColor({
    name: "Red",
    color: "#ff0000",
    opacity: 0.5,
    path: "",
  });

  const typographyId = context.addLibraryTypography({
    name: "Title",
    fontId: "sourcesanspro",
    fontVariantId: "400",
    fontFamily: "sans-serif",
    fontSize: "20",
    fontWeight: "400",
    fontStyle: "normal",
    textTransform: "none",
    textDecoration: "none",
    letterSpacing: "0",
    lineHeight: "1.2",
  });

  const zip = await openZip(await exportAsBytes(context));

  const color = await readJson(zip, `files/${fileId}/colors/${colorId}.json`);
  assert.equal(color.id, colorId);
  assert.equal(color.name, "Red");
  assert.equal(color.color, "#ff0000");
  assert.equal(color.opacity, 0.5);
  assert.equal(color.fileId, undefined);
  assert.equal("path" in color, false);
  assert.equal(typeof color.modifiedAt, "string");

  const typography = await readJson(
    zip,
    `files/${fileId}/typographies/${typographyId}.json`,
  );
  assert.equal(typography.id, typographyId);
  assert.equal(typography.fontId, "sourcesanspro");
  assert.equal(typography.lineHeight, "1.2");
  assert.equal(typography.fileId, undefined);

  await zip.close();
});

test("media is exported as three entries", async () => {
  const context = createBuildContext();
  const { fileId } = buildFile(context);

  const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const fileMediaId = context.addFileMedia(
    { name: "img.png", width: 2, height: 3 },
    new Blob([payload], { type: "image/png" }),
  );

  const state = context.getInternalState() as Json;
  const fileMedia = state.fileMedia[fileMediaId];
  const mediaId = fileMedia.mediaId;

  const zip = await openZip(await exportAsBytes(context));

  const binary = await zip.entry(`objects/${mediaId}.png`).getData(new Uint8ArrayWriter());
  assert.deepEqual([...binary], [...payload]);

  assert.deepEqual(await readJson(zip, `objects/${mediaId}.json`), {
    id: mediaId,
    bucket: "file-media-object",
    contentType: "image/png",
    size: payload.length,
  });

  const media = await readJson(zip, `files/${fileId}/media/${fileMediaId}.json`);
  assert.equal(media.id, fileMediaId);
  assert.equal(media.mediaId, mediaId);
  assert.equal(media.fileId, undefined);
  assert.equal(media.isLocal, true);
  assert.equal(media.width, 2);
  assert.equal(media.height, 3);

  await zip.close();
});

test("the manifest carries the referer and the relations", async () => {
  const context = createBuildContext({ referer: "https://example.com" });
  const fileId1 = context.addFile({ name: "sample 1" });
  const fileId2 = context.addFile({ name: "sample 2" });
  context.addRelation(fileId1, fileId2);

  const manifest = await readJson(
    await openZip(await exportAsBytes(context)),
    "manifest.json",
  );

  assert.equal(manifest.referer, "https://example.com");
  assert.deepEqual(manifest.relations, [[fileId1, fileId2]]);
  assert.deepEqual(
    manifest.files.map((file: Json) => file.id),
    [fileId1, fileId2],
  );
});

test("progress is reported once per entry", async () => {
  const context = createBuildContext();
  const { fileId, pageId } = buildFile(context);
  context.addRect({ x: 0, y: 0, width: 1, height: 1 });

  const reports: { total: number; item: number; path: string }[] = [];
  const bytes = await exportAsBytes(context, {
    onProgress: (progress) => reports.push({ ...progress }),
  });

  const zip = await openZip(bytes);
  assert.equal(reports.length, zip.paths.length);
  assert.deepEqual(
    reports.map((report) => report.path),
    zip.paths,
  );
  assert.ok(reports.every((report) => report.total === zip.paths.length));
  assert.deepEqual(
    reports.map((report) => report.item),
    zip.paths.map((_, index) => index + 1),
  );
  assert.equal(reports[0].path, "manifest.json");

  const expected = [
    "manifest.json",
    `files/${fileId}.json`,
    `files/${fileId}/pages/${pageId}.json`,
    `files/${fileId}/pages/${pageId}/${ZERO}.json`,
  ];
  assert.deepEqual(reports.slice(0, 4).map((report) => report.path), expected);

  await zip.close();
});

test("exportAsBlob returns a readable blob", async () => {
  const context = createBuildContext();
  buildFile(context);

  const blob = await exportAsBlob(context);
  assert.equal(blob.type, "application/octet-stream");
  assert.ok(blob.size > 0);

  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
  const entries = await reader.getEntries();
  assert.ok(entries.some((entry) => entry.filename === "manifest.json"));
  await reader.close();
});

test("exportStream writes the archive to a writable stream", async () => {
  const context = createBuildContext();
  const { fileId } = buildFile(context);

  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });

  await exportStream(context, stream);

  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  const zip = await openZip(bytes);
  assert.ok(zip.paths.includes("manifest.json"));
  assert.ok(zip.paths.includes(`files/${fileId}.json`));
  await zip.close();
});

test("the library version matches package.json", () => {
  let dir = path.dirname(fileURLToPath(import.meta.url));

  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (pkg.name === "@penpot/library") {
        assert.equal(LIBRARY_VERSION, pkg.version);
        return;
      }
    }

    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "cannot find the library package.json");
    dir = parent;
  }
});
