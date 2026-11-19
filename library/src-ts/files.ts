// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// Port of the file and page initialization in `app.common.types.file`,
// `app.common.types.page` and `app.common.files.builder`.

import type {
  FileData,
  Page,
  PenpotFile,
  Shape,
  Uuid,
} from "./model.ts";
import { setupShape } from "./shapes.ts";
import { ZERO, next } from "./uuid.ts";
import { isNil, withoutNils } from "./data.ts";
import { fail } from "./errors.ts";

export const VERSION = 67;
export const BASE_FONT_SIZE = "16px";
export const ROOT_ID: Uuid = ZERO;

// WORKAROUND: a copy of the staging features so the generated files stay
// compatible with the released Penpot. Mirrors the CLJS builder.
export const DEFAULT_FEATURES: string[] = [
  "fdata/shape-data-type",
  "styles/v2",
  "layout/grid",
  "components/v2",
  "plugins/runtime",
  "design-tokens/v1",
  "variants/v1",
];

// WORKAROUND: the same for migrations. The three entries the CLJS builder
// removes are left out here.
export const AVAILABLE_MIGRATIONS: string[] = [
  "legacy-2",
  "legacy-3",
  "legacy-5",
  "legacy-6",
  "legacy-7",
  "legacy-8",
  "legacy-9",
  "legacy-10",
  "legacy-11",
  "legacy-12",
  "legacy-13",
  "legacy-14",
  "legacy-16",
  "legacy-17",
  "legacy-18",
  "legacy-19",
  "legacy-25",
  "legacy-26",
  "legacy-27",
  "legacy-28",
  "legacy-29",
  "legacy-31",
  "legacy-32",
  "legacy-33",
  "legacy-34",
  "legacy-36",
  "legacy-37",
  "legacy-38",
  "legacy-39",
  "legacy-40",
  "legacy-41",
  "legacy-42",
  "legacy-43",
  "legacy-44",
  "legacy-45",
  "legacy-46",
  "legacy-47",
  "legacy-48",
  "legacy-49",
  "legacy-50",
  "legacy-51",
  "legacy-52",
  "legacy-53",
  "legacy-54",
  "legacy-55",
  "legacy-56",
  "legacy-57",
  "legacy-59",
  "legacy-62",
  "legacy-65",
  "legacy-66",
  "legacy-67",
  "0001-remove-tokens-from-groups",
  "0002-normalize-bool-content-v2",
  "0003-convert-path-content-v2",
  "0005-deprecate-image-type",
  "0006-fix-old-texts-fills",
  "0008-fix-library-colors-v4",
  "0009-clean-library-colors",
  "0009-add-partial-text-touched-flags",
  "0010-fix-swap-slots-pointing-non-existent-shapes",
  "0011-fix-invalid-text-touched-flags",
  "0012-fix-position-data",
  "0013-fix-component-path",
  "0013-clear-invalid-strokes-and-fills",
  "0014-fix-tokens-lib-duplicate-ids",
  "0014-clear-components-nil-objects",
  "0015-fix-text-attrs-blank-strings",
  "0015-clean-shadow-color",
  "0016-copy-fills-from-position-data-to-text-node",
  "0017-fix-layout-flex-dir",
  "0018-remove-unneeded-objects-from-components",
  "0019-fix-missing-swap-slots",
  "0020-sync-component-id-with-near-main",
  "0021-fix-shape-svg-attrs",
  "0022-normalize-component-root-and-resync",
  "0023-repair-token-themes-with-inexistent-sets",
  "0024b-fix-stroke-cap-placement",
  "0025-repair-empty-text-content",
  "0026-fix-svg-raw-shapes-uuids",
  "0027-separate-tokens-status",
  "0028-normalize-constrained-values",
  "0029-move-background-blur-out-of-blur",
  "0030-remove-stroke-per-side-attr",
];

export function now(): string {
  return new Date().toISOString();
}

export function rootShape(): Shape {
  return setupShape({
    id: ROOT_ID,
    type: "frame",
    parentId: ROOT_ID,
    frameId: ROOT_ID,
    name: "Root Frame",
  });
}

export function emptyPageData(): { objects: Record<Uuid, Shape> } {
  return { objects: { [ROOT_ID]: rootShape() } };
}

export function makeEmptyPage(params: {
  id?: Uuid | null;
  name?: string | null;
  background?: string | null;
} = {}): Page {
  const page = emptyPageData() as Page;
  page.id = params.id ?? next();
  page.name = params.name ?? "Page 1";
  if (params.background != null) page.background = params.background;
  return page;
}

/**
 * `makeFileData` from the common layer. The builder always creates files
 * without a page, so `pageId` stays null there.
 */
export function makeFileData(
  fileId: Uuid,
  pageId: Uuid | null = null,
): FileData {
  const data: FileData = {
    pages: [],
    pagesIndex: {},
    id: fileId,
    options: { componentsV2: true, baseFontSize: BASE_FONT_SIZE },
  };

  if (pageId != null) addPageToFile(data, makeEmptyPage({ id: pageId }));

  return data;
}

export function addPageToFile(data: FileData, page: Page): FileData {
  if (!data.pages.includes(page.id)) data.pages.push(page.id);
  data.pagesIndex[page.id] = page;
  return data;
}

export interface MakeFileOptions {
  createPage?: boolean;
  withData?: boolean;
  pageId?: Uuid | null;
}

export function makeFile(
  params: Record<string, unknown>,
  options: MakeFileOptions = {},
): PenpotFile {
  const { createPage = true, withData = true, pageId = null } = options;

  const id = (params.id as Uuid | undefined) ?? next();
  const createdAt = (params.createdAt as string | undefined) ?? now();
  const modifiedAt = (params.modifiedAt as string | undefined) ?? createdAt;

  const data = withData
    ? createPage
      ? makeFileData(id, pageId)
      : makeFileData(id, null)
    : undefined;

  const file = withoutNils({
    id,
    projectId: params.projectId,
    name: params.name,
    revn: params.revn ?? 0,
    vern: 0,
    isShared: params.isShared ?? false,
    version: params.version ?? VERSION,
    data,
    features: params.features ?? [],
    migrations: params.migrations,
    metadata: params.metadata,
    createdAt,
    modifiedAt,
    deletedAt: params.deletedAt,
  }) as unknown as PenpotFile;

  return checkFile(file);
}

export function checkFile(file: PenpotFile): PenpotFile {
  if (typeof file.id !== "string" || file.id.length === 0) {
    fail("assertion", "data-validation", "invalid file");
  }
  if (!isNil(file.data) && !Array.isArray(file.data.pages)) {
    fail("assertion", "data-validation", "invalid file");
  }
  if (typeof file.version !== "number") {
    fail("assertion", "data-validation", "invalid file");
  }
  return file;
}
