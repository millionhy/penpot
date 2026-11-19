// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// Port of `app.common.files.builder`: the state machine that walks a file,
// its pages and its shape tree. The CLJS version keeps a namespaced map;
// this port keeps the same camelCase surface `getInternalState` produced.

import type {
  BuilderOptions,
  BuilderState,
  FileData,
  FileMedia,
  LibraryColor,
  LibraryTypography,
  MediaObject,
  Page,
  PenpotFile,
  Shape,
  Uuid,
} from "./model.ts";
import {
  AVAILABLE_MIGRATIONS,
  DEFAULT_FEATURES,
  ROOT_ID,
  makeEmptyPage,
  makeFile,
  now,
} from "./files.ts";
import {
  assignShapeName,
  checkShape,
  setupShape,
} from "./shapes.ts";
import { applyChange } from "./changes.ts";
import type { Change } from "./changes.ts";
import { updateGroupSelrect } from "./geometry.ts";
import { serializePath } from "./path.ts";
import { isValid, next, parse } from "./uuid.ts";
import { isNil, withoutNils } from "./data.ts";
import { fail } from "./errors.ts";

const EMPTY_NAMES: ReadonlySet<string> = new Set();

export function createState(options: BuilderOptions | null = null): BuilderState {
  return { options };
}

function currentFile(state: BuilderState): PenpotFile {
  const fileId = state.currentFileId;
  const file = fileId == null ? undefined : state.files?.[fileId];
  if (file == null) {
    fail("assertion", "data-validation", "expected current file");
  }
  return file;
}

export function getCurrentPage(state: BuilderState): Page {
  const file = currentFile(state);
  const pageId = state.currentPageId;
  const page = pageId == null ? undefined : file.data.pagesIndex[pageId];
  if (page == null) {
    fail("assertion", "data-validation", "expected current page");
  }
  return page;
}

export function getCurrentObjects(state: BuilderState): Record<Uuid, Shape> {
  return getCurrentPage(state).objects;
}

export function getShape(state: BuilderState, shapeId: Uuid): Shape | undefined {
  return getCurrentObjects(state)[shapeId];
}

function usedNames(state: BuilderState): ReadonlySet<string> {
  const pageId = state.currentPageId;
  if (pageId == null) return EMPTY_NAMES;
  return state.unames?.[pageId] ?? EMPTY_NAMES;
}

function trackUsedName(state: BuilderState, name: string): BuilderState {
  const pageId = state.currentPageId;
  if (pageId == null) return state;

  const unames = state.unames ?? {};
  const names = unames[pageId] ?? new Set<string>();

  return {
    ...state,
    unames: { ...unames, [pageId]: new Set([...names, name]) },
  };
}

function commitChange(
  state: BuilderState,
  change: Change,
  addContainer = false,
): BuilderState {
  const file = currentFile(state);

  const finalChange: Change = addContainer
    ? {
        ...change,
        pageId: state.currentPageId,
        frameId: state.currentFrameId,
      }
    : change;

  const data = applyChange(file.data, finalChange);

  return {
    ...state,
    files: { ...state.files, [file.id]: { ...file, data } },
  };
}

function commitShape(state: BuilderState, shape: Shape): BuilderState {
  const parentStack = state.parentStack ?? [];
  const change: Change = {
    type: "add-obj",
    id: shape.id,
    ignoreTouched: true,
    obj: shape,
    parentId: parentStack[parentStack.length - 1],
    frameId: state.currentFrameId,
    pageId: state.currentPageId,
  };

  return trackUsedName(commitChange(state, change), shape.name);
}

function nextId(value: unknown): Uuid {
  return typeof value === "string" && isValid(value) ? value : next();
}

export function addFile(
  state: BuilderState,
  params: Record<string, unknown>,
): BuilderState {
  const withDefaults = {
    ...params,
    features: [...DEFAULT_FEATURES],
    migrations: [...AVAILABLE_MIGRATIONS],
    id: nextId(params.id),
  };

  const file = makeFile(withDefaults, { createPage: false });

  return {
    ...state,
    files: { ...state.files, [file.id]: file },
    currentFileId: file.id,
  };
}

export function closeFile(state: BuilderState): BuilderState {
  const closed = closePage(state);
  const { currentFileId: _fileId, ...rest } = closed;
  return rest;
}

export function addPage(
  state: BuilderState,
  params: Record<string, unknown>,
): BuilderState {
  const page = makeEmptyPage({
    id: params.id as Uuid | undefined,
    name: params.name as string | undefined,
    background: params.background as string | undefined,
  });

  return {
    ...commitChange(state, { type: "add-page", page }),
    currentPageId: page.id,
    currentFrameId: ROOT_ID,
    parentStack: [ROOT_ID],
    lastId: null,
  };
}

export function closePage(state: BuilderState): BuilderState {
  const {
    currentPageId: _pageId,
    parentStack: _parentStack,
    lastId: _lastId,
    unames: _unames,
    ...rest
  } = state;
  return rest;
}

export function addBoard(
  state: BuilderState,
  params: Record<string, unknown>,
): BuilderState {
  const withId = { ...params, id: nextId(params.id), type: "frame" };
  const named = assignShapeName(
    withId as unknown as Shape,
    usedNames(state),
  );
  const shape = checkShape(setupShape(named as unknown as Record<string, unknown>));

  const stack = [...(state.parentStack ?? [])];
  stack.push(shape.id);

  return {
    ...commitShape(state, shape),
    parentStack: stack,
    currentFrameId: shape.id,
    lastId: shape.id,
  };
}

export function closeBoard(state: BuilderState): BuilderState {
  const stack = [...(state.parentStack ?? [])];
  const parentId = stack[stack.length - 1];
  const parent = parentId == null ? undefined : getShape(state, parentId);

  stack.pop();

  return {
    ...state,
    currentFrameId: parent?.frameId ?? ROOT_ID,
    parentStack: stack,
  };
}

export function addGroup(
  state: BuilderState,
  params: Record<string, unknown>,
): BuilderState {
  const withId = { ...params, id: nextId(params.id), type: "group" };
  const named = assignShapeName(
    withId as unknown as Shape,
    usedNames(state),
  );
  const shape = checkShape(setupShape(named as unknown as Record<string, unknown>));

  const stack = [...(state.parentStack ?? []), shape.id];

  return {
    ...commitShape(state, shape),
    lastId: shape.id,
    parentStack: stack,
  };
}

export function closeGroup(state: BuilderState): BuilderState {
  const stack = [...(state.parentStack ?? [])];
  const groupId = stack[stack.length - 1];
  const group = groupId == null ? undefined : getShape(state, groupId);

  if (group == null) {
    fail("assertion", "data-validation", "expected valid shape");
  }

  const children = (group.shapes ?? [])
    .map((id) => getShape(state, id))
    .filter((child): child is Shape => child != null);

  if (children.length === 0) {
    fail(
      "validation",
      "empty-children",
      "group expect to have at least 1 children",
    );
  }

  let nextState: BuilderState;

  if (group.maskedGroup === true) {
    const mask = children[0];
    const selrect = mask.selrect;
    nextState = commitChange(
      state,
      {
        type: "mod-obj",
        id: groupId as Uuid,
        operations: [
          { type: "set", attr: "x", val: selrect?.x, ignoreTouched: true },
          { type: "set", attr: "y", val: selrect?.y, ignoreTouched: true },
          { type: "set", attr: "width", val: selrect?.width, ignoreTouched: true },
          { type: "set", attr: "height", val: selrect?.height, ignoreTouched: true },
          { type: "set", attr: "flipX", val: mask.flipX, ignoreTouched: true },
          { type: "set", attr: "flipY", val: mask.flipY, ignoreTouched: true },
          { type: "set", attr: "selrect", val: selrect, ignoreTouched: true },
          { type: "set", attr: "points", val: mask.points, ignoreTouched: true },
        ],
      } as Change,
      true,
    );
  } else {
    const updated = updateGroupSelrect(group, children);
    const selrect = updated.selrect;

    nextState = commitChange(
      state,
      {
        type: "mod-obj",
        id: groupId as Uuid,
        operations: [
          { type: "set", attr: "selrect", val: selrect, ignoreTouched: true },
          { type: "set", attr: "points", val: updated.points, ignoreTouched: true },
          { type: "set", attr: "x", val: selrect?.x, ignoreTouched: true },
          { type: "set", attr: "y", val: selrect?.y, ignoreTouched: true },
          { type: "set", attr: "width", val: selrect?.width, ignoreTouched: true },
          { type: "set", attr: "height", val: selrect?.height, ignoreTouched: true },
        ],
      } as Change,
      true,
    );
  }

  stack.pop();
  return { ...nextState, parentStack: stack };
}

function svgAttrsToProps(attrs: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [rawKey, rawValue] of Object.entries(attrs)) {
    if (rawValue == null) continue;

    const key = rawKey.includes("-")
      ? rawKey.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
      : rawKey;

    result[key] =
      typeof rawValue === "string" ? rawValue.trim() : rawValue;
  }

  return result;
}

export function addShape(
  state: BuilderState,
  params: Record<string, unknown>,
): BuilderState {
  let props = params;
  if (!isNil(props.svgAttrs) && typeof props.svgAttrs === "object") {
    props = {
      ...props,
      svgAttrs: svgAttrsToProps(props.svgAttrs as Record<string, unknown>),
    };
  }

  const shape = checkShape(
    assignShapeName(setupShape(props), usedNames(state)),
  );

  return {
    ...commitShape(state, shape),
    lastId: shape.id,
  };
}

function checkLibraryColor(color: LibraryColor): LibraryColor {
  if (
    typeof color.id !== "string" ||
    typeof color.name !== "string" ||
    typeof color.color !== "string"
  ) {
    fail("assertion", "data-validation", "expected valid color");
  }
  return color;
}

export function addLibraryColor(
  state: BuilderState,
  params: Record<string, unknown>,
): BuilderState {
  const color = checkLibraryColor({
    ...params,
    opacity: params.opacity ?? 1,
    id: nextId(params.id),
  } as unknown as LibraryColor);

  return {
    ...commitChange(state, { type: "add-color", color }),
    lastId: color.id,
  };
}

export function addLibraryTypography(
  state: BuilderState,
  params: Record<string, unknown>,
): BuilderState {
  const typography = withoutNils({
    ...params,
    id: nextId(params.id),
  }) as unknown as LibraryTypography;

  if (typeof typography.name !== "string") {
    fail("assertion", "data-validation", "expected valid typography");
  }

  return {
    ...commitChange(state, { type: "add-typography", typography }),
    lastId: typography.id,
  };
}

export function addComponent(
  state: BuilderState,
  params: Record<string, unknown>,
): BuilderState {
  if (!isValid(params.componentId)) {
    fail(
      "assertion",
      "data-validation",
      "invalid arguments passed for add-component",
    );
  }

  const componentId = params.componentId as Uuid;
  const fileId = (params.fileId as Uuid | undefined) ?? state.currentFileId;
  const pageId = (params.pageId as Uuid | undefined) ?? state.currentPageId;
  const frameId = (params.frameId as Uuid | undefined) ?? state.currentFrameId;

  const change1 = withoutNils({
    type: "add-component",
    id: componentId,
    name: typeof params.name === "string" ? params.name : "anonmous",
    path: typeof params.path === "string" ? params.path : "",
    mainInstanceId: frameId,
    mainInstancePage: pageId,
    variantId: params.variantId,
    variantProperties: params.variantProperties,
  }) as Change;

  const change2: Change = {
    type: "mod-obj",
    id: frameId,
    pageId,
    operations: [
      { type: "set", attr: "componentRoot", val: true },
      { type: "set", attr: "mainInstance", val: true },
      { type: "set", attr: "componentId", val: componentId },
      { type: "set", attr: "componentFile", val: fileId },
    ],
  };

  return commitChange(commitChange(state, change1), change2);
}

export function addBool(
  _state: BuilderState,
  _params: Record<string, unknown>,
): BuilderState {
  fail(
    "validation",
    "not-implemented",
    "addBool is not implemented yet",
  );
}

export function addTokensLib(
  _state: BuilderState,
  _tokensLib: unknown,
): BuilderState {
  fail(
    "validation",
    "not-implemented",
    "addTokensLib is not implemented yet",
  );
}

export function deleteShape(state: BuilderState, id: Uuid): BuilderState {
  return commitChange(state, {
    type: "del-obj",
    pageId: state.currentPageId,
    ignoreTouched: true,
    id,
  });
}

export function updateShape(
  state: BuilderState,
  shapeId: Uuid,
  f: (shape: Shape) => Shape,
): BuilderState {
  const oldShape = getShape(state, shapeId);
  if (oldShape == null) {
    fail("assertion", "data-validation", "expected valid shape");
  }

  const newShape = f(oldShape);
  const attrs = new Set([
    ...Object.keys(oldShape),
    ...Object.keys(newShape),
  ]);

  const operations: Array<{
    type: "set";
    attr: string;
    val: unknown;
    ignoreTouched: boolean;
  }> = [];
  for (const attr of attrs) {
    const oldValue = (oldShape as Record<string, unknown>)[attr];
    const newValue = (newShape as Record<string, unknown>)[attr];
    if (oldValue !== newValue) {
      operations.push({ type: "set", attr, val: newValue, ignoreTouched: true });
    }
  }

  return {
    ...commitChange(state, {
      type: "mod-obj",
      pageId: state.currentPageId,
      id: shapeId,
      operations,
    }),
    lastId: shapeId,
  };
}

export interface AddFileMediaParams {
  id?: Uuid;
  name: string;
  width: number;
  height: number;
}

export function addFileMedia(
  state: BuilderState,
  rawParams: Record<string, unknown>,
  blob: { mtype: string; size: number; blob: Blob },
): BuilderState {
  const params = rawParams as unknown as AddFileMediaParams;
  const mediaId = next();
  const fileId = currentFile(state).id;
  const id = nextId(params.id);

  if (typeof params.name !== "string" || !Number.isInteger(params.width) || !Number.isInteger(params.height)) {
    fail("assertion", "data-validation", "invalid file media");
  }

  const media: MediaObject = {
    id: mediaId,
    bucket: "file-media-object",
    contentType: blob.mtype,
    size: blob.size,
  };

  const fileMedia: FileMedia = {
    id,
    createdAt: now(),
    name: params.name,
    width: params.width,
    height: params.height,
    fileId,
    mediaId,
    isLocal: true,
    mtype: blob.mtype,
  };

  return {
    ...state,
    blobs: { ...state.blobs, [mediaId]: blob },
    media: { ...state.media, [mediaId]: media },
    fileMedia: { ...state.fileMedia, [id]: fileMedia },
    lastId: id,
  };
}

export function getMediaAsImage(
  state: BuilderState,
  id: unknown,
): Record<string, unknown> | null {
  const parsed = parse(id);
  if (parsed == null) return null;

  const fileMedia = state.fileMedia?.[parsed];
  if (fileMedia == null) return null;

  return withoutNils({
    id: fileMedia.id,
    width: fileMedia.width,
    height: fileMedia.height,
    name: fileMedia.name,
    mtype: fileMedia.mtype,
  }) as Record<string, unknown>;
}

export function addRelation(
  state: BuilderState,
  fileId: unknown,
  libraryId: unknown,
): BuilderState | null {
  const file = parse(fileId);
  const library = parse(libraryId);
  if (file == null || library == null) return null;

  return {
    ...state,
    relations: { ...state.relations, [file]: library },
  };
}

function encodeShape(shape: Shape): Record<string, unknown> {
  if (
    (shape.type === "path" || shape.type === "bool") &&
    Array.isArray(shape.content)
  ) {
    return { ...shape, content: serializePath(shape.content) };
  }
  return { ...shape };
}

function encodePage(page: Page): Record<string, unknown> {
  const objects: Record<Uuid, Record<string, unknown>> = {};
  for (const [id, shape] of Object.entries(page.objects)) {
    objects[id] = encodeShape(shape);
  }
  return { ...page, objects };
}

function encodeFileData(data: FileData): Record<string, unknown> {
  const pagesIndex: Record<Uuid, Record<string, unknown>> = {};
  for (const [id, page] of Object.entries(data.pagesIndex)) {
    pagesIndex[id] = encodePage(page);
  }
  return { ...data, pagesIndex };
}

/**
 * The JS view of the builder state, the same shape the CLJS `json/->js`
 * produced. Sets become arrays and path data becomes its SVG string.
 */
export function toInternalState(state: BuilderState): Record<string, unknown> {
  const result: Record<string, unknown> = { options: state.options };

  if (state.files != null) {
    const files: Record<Uuid, Record<string, unknown>> = {};
    for (const [id, file] of Object.entries(state.files)) {
      files[id] = { ...file, data: encodeFileData(file.data) };
    }
    result.files = files;
  }

  if (state.fileMedia != null) result.fileMedia = { ...state.fileMedia };
  if (state.media != null) result.media = { ...state.media };
  if (state.blobs != null) result.blobs = { ...state.blobs };

  if (state.unames != null) {
    const unames: Record<Uuid, string[]> = {};
    for (const [pageId, names] of Object.entries(state.unames)) {
      unames[pageId] = [...names];
    }
    result.unames = unames;
  }

  if (state.relations != null) result.relations = { ...state.relations };
  if (state.currentFileId != null) result.currentFileId = state.currentFileId;
  if (state.currentPageId != null) result.currentPageId = state.currentPageId;
  if (state.currentFrameId != null) result.currentFrameId = state.currentFrameId;
  if (state.parentStack != null) result.parentStack = [...state.parentStack];
  if (state.lastId !== undefined) result.lastId = state.lastId;

  return result;
}
