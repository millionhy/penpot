// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// The shapes of this module mirror the JSON surface the CLJS builder
// exposed through `getInternalState`: camelCase plain objects.

export type Uuid = string;

export type ShapeType =
  | "frame"
  | "group"
  | "rect"
  | "circle"
  | "path"
  | "text"
  | "image"
  | "bool"
  | "svg-raw";

export interface Point {
  x: number;
  y: number;
}

export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type PathCommand = "move-to" | "line-to" | "curve-to" | "close-path";

export interface PathSegment {
  command: PathCommand;
  params: Record<string, number>;
}

export interface Fill {
  fillColor?: string;
  fillOpacity?: number;
  fillImage?: Record<string, unknown>;
}

export interface Stroke {
  strokeStyle?: string;
  strokeAlignment?: string;
  strokeWidth?: number;
  strokeColor?: string;
  strokeOpacity?: number;
}

export interface Shape {
  id: Uuid;
  name: string;
  type: ShapeType;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  rotation: number;
  // The CLJS record always carries these fields, but they hold nil until
  // `setupShape` fills them; `createShape` mirrors that.
  selrect: Rect | null;
  points: Point[] | null;
  transform: Matrix | null;
  transformInverse: Matrix | null;
  parentId: Uuid;
  frameId: Uuid;
  flipX: boolean | null;
  flipY: boolean | null;
  // Type specific attributes assigned by `setupShape`.
  fills?: Fill[];
  strokes?: Stroke[];
  shapes?: Uuid[];
  r1?: number;
  r2?: number;
  r3?: number;
  r4?: number;
  hideFillOnExport?: boolean;
  content?: PathSegment[] | string;
  proportion?: number;
  proportionLock?: boolean;
  boolType?: string;
  [attr: string]: unknown;
}

export interface Page {
  id: Uuid;
  name: string;
  objects: Record<Uuid, Shape>;
  background?: string;
}

export interface FileOptions {
  componentsV2: boolean;
  baseFontSize: string;
}

export interface LibraryColor {
  id: Uuid;
  name: string;
  color: string;
  opacity: number;
  path?: string;
  modifiedAt?: string;
  [attr: string]: unknown;
}

export interface LibraryTypography {
  id: Uuid;
  name: string;
  modifiedAt?: string;
  [attr: string]: unknown;
}

export interface FileData {
  id: Uuid;
  pages: Uuid[];
  pagesIndex: Record<Uuid, Page>;
  options: FileOptions;
  colors?: Record<Uuid, LibraryColor>;
  typographies?: Record<Uuid, LibraryTypography>;
  components?: Record<Uuid, Record<string, unknown>>;
  tokensLib?: unknown;
  pluginData?: unknown;
  [attr: string]: unknown;
}

export interface PenpotFile {
  id: Uuid;
  name: string;
  revn: number;
  vern: number;
  isShared: boolean;
  version: number;
  data: FileData;
  features: string[];
  migrations: string[];
  createdAt: string;
  modifiedAt: string;
  projectId?: Uuid;
  [attr: string]: unknown;
}

export interface MediaObject {
  id: Uuid;
  bucket: string;
  contentType: string;
  size: number;
  [attr: string]: unknown;
}

export interface FileMedia {
  id: Uuid;
  createdAt: string;
  name: string;
  width: number;
  height: number;
  fileId: Uuid;
  mediaId: Uuid;
  isLocal: boolean;
  mtype: string;
  [attr: string]: unknown;
}

export interface BlobWrapper {
  mtype: string;
  size: number;
  blob: Blob;
}

export interface BuilderOptions {
  referer?: string;
}

export interface BuilderState {
  options: BuilderOptions | null;
  files?: Record<Uuid, PenpotFile>;
  fileMedia?: Record<Uuid, FileMedia>;
  media?: Record<Uuid, MediaObject>;
  blobs?: Record<Uuid, BlobWrapper>;
  unames?: Record<Uuid, Set<string>>;
  relations?: Record<Uuid, Uuid>;
  currentFileId?: Uuid;
  currentPageId?: Uuid;
  currentFrameId?: Uuid;
  parentStack?: Uuid[];
  lastId?: Uuid | null;
}
