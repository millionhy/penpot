// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// Public entry point of the TypeScript port. It mirrors the exports the
// shadow-cljs build produced for `@penpot/library`.

export { BuilderError, createBuildContext } from "./api.ts";
export type { BuildContext } from "./api.ts";

export { exportAsBlob, exportAsBytes, exportStream } from "./export.ts";
export type { ExportOptions, ExportProgress } from "./export.ts";

export { createState, toInternalState } from "./builder.ts";

export type {
  BuilderOptions,
  BuilderState,
  FileData,
  FileMedia,
  LibraryColor,
  LibraryTypography,
  Page,
  PathSegment,
  PenpotFile,
  Rect,
  Shape,
  ShapeType,
  Uuid,
} from "./model.ts";
