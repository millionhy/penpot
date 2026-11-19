// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

import assert from "node:assert/strict";
import test from "node:test";

import { BuilderError, createBuildContext } from "../src-ts/index.ts";
import { ZERO } from "../src-ts/uuid.ts";

type Json = Record<string, any>;

function page0(state: Json, pageId: string): Json {
  return state.files[state.currentFileId].data.pagesIndex[pageId];
}

test("create empty context", () => {
  const context = createBuildContext();

  assert.ok(context);
  assert.equal(context.currentFileId, "");
  assert.equal(context.currentPageId, "");
  assert.equal(context.lastId, "");
  assert.deepEqual(context.getInternalState(), { options: null });
});

test("create context with a single file", () => {
  const context = createBuildContext();
  context.addFile({ name: "sample" });

  const state = context.getInternalState() as Json;
  const file = state.files[state.currentFileId];

  assert.equal(typeof state.files, "object");
  assert.equal(typeof state.currentFileId, "string");
  assert.ok(file);
  assert.equal(file.name, "sample");
  assert.equal(file.version, 67);
  assert.equal(file.revn, 0);
  assert.equal(file.vern, 0);
  assert.equal(file.isShared, false);
  assert.deepEqual(file.data.pages, []);
  assert.deepEqual(file.data.pagesIndex, {});
  assert.equal(file.data.options.componentsV2, true);
  assert.equal(file.data.options.baseFontSize, "16px");
  assert.equal(typeof file.createdAt, "string");
  assert.equal(file.createdAt, file.modifiedAt);
});

test("the file keeps the library features and migrations", () => {
  const context = createBuildContext();
  context.addFile({ name: "sample" });

  const state = context.getInternalState() as Json;
  const file = state.files[state.currentFileId];

  assert.deepEqual(file.features.sort(), [
    "components/v2",
    "design-tokens/v1",
    "fdata/shape-data-type",
    "layout/grid",
    "plugins/runtime",
    "styles/v2",
    "variants/v1",
  ]);

  assert.equal(file.migrations.length, 84);
  assert.ok(!file.migrations.includes("0002-clean-shape-interactions"));
  assert.ok(!file.migrations.includes("0003-fix-root-shape"));
  assert.ok(file.migrations.includes("0030-remove-stroke-per-side-attr"));
});

test("create context with two files", () => {
  const context = createBuildContext();

  const fileId1 = context.addFile({ name: "sample 1" });
  const fileId2 = context.addFile({ name: "sample 2" });

  const state = context.getInternalState() as Json;

  assert.ok(state.files[fileId1]);
  assert.ok(state.files[fileId2]);
  assert.equal(state.files[fileId1].name, "sample 1");
  assert.equal(state.files[fileId2].name, "sample 2");
  assert.equal(state.files[fileId2].data.pages.length, 0);
});

test("create context with two files and a relation", () => {
  const context = createBuildContext();

  const fileId1 = context.addFile({ name: "sample 1" });
  const fileId2 = context.addFile({ name: "sample 2" });

  assert.equal(context.addRelation(fileId1, fileId2), true);
  assert.equal(context.addRelation("nope", fileId2), false);

  const state = context.getInternalState() as Json;
  assert.equal(state.relations[fileId1], fileId2);
});

test("create context with a file and a page", () => {
  const context = createBuildContext();

  const fileId = context.addFile({ name: "file 1" });
  const pageId = context.addPage({ name: "page 1" });

  const state = context.getInternalState() as Json;
  const file = state.files[fileId];

  assert.equal(file.data.pages.length, 1);
  assert.deepEqual(file.data.pages, [pageId]);

  const page = file.data.pagesIndex[pageId];
  assert.equal(page.id, pageId);
  assert.equal(page.name, "page 1");

  const root = page.objects[ZERO];
  assert.ok(root);
  assert.equal(root.id, ZERO);
  assert.equal(root.name, "Root Frame");
  assert.equal(root.width, 0.01);
  assert.equal(root.height, 0.01);
});

test("the current frame follows the board stack", () => {
  const context = createBuildContext();
  context.addFile({ name: "file 1" });
  context.addPage({ name: "page 1" });

  assert.equal(context.currentFrameId, ZERO);

  const boardId = context.addBoard({
    name: "Board 1",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
  });

  assert.equal(context.currentFrameId, boardId);

  const rectId = context.addRect({
    name: "Rect 1",
    x: 10,
    y: 10,
    width: 20,
    height: 20,
  });

  const state = context.getInternalState() as Json;
  const page = page0(state, context.currentPageId);
  const board = page.objects[boardId];
  const rect = page.objects[rectId];

  assert.deepEqual(board.shapes, [rectId]);
  assert.equal(rect.parentId, boardId);
  assert.equal(rect.frameId, boardId);
  assert.equal(rect.selrect.x, 10);
  assert.equal(rect.selrect.width, 20);
  assert.equal(rect.proportion, 1);

  context.closeBoard();
  assert.equal(context.currentFrameId, ZERO);

  const closed = context.getInternalState() as Json;
  const root = closed.files[closed.currentFileId].data.pagesIndex[
    closed.currentPageId
  ].objects[ZERO];
  assert.deepEqual(root.shapes, [boardId]);

  context.closePage();

  const afterClose = context.getInternalState() as Json;
  assert.equal(afterClose.currentPageId, undefined);
  assert.equal(afterClose.unames, undefined);
});

test("closeGroup recomputes the group selrect from its children", () => {
  const context = createBuildContext();
  context.addFile({ name: "file 1" });
  const pageId = context.addPage({ name: "page 1" });

  const groupId = context.addGroup({
    name: "Group 1",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  });

  const childId = context.addRect({
    name: "Child",
    x: 5,
    y: 5,
    width: 10,
    height: 10,
  });

  context.closeGroup();

  const state = context.getInternalState() as Json;
  const group = page0(state, pageId).objects[groupId];
  const child = page0(state, pageId).objects[childId];

  assert.equal(child.parentId, groupId);
  assert.equal(child.frameId, ZERO);
  assert.deepEqual(group.shapes, [childId]);
  assert.deepEqual(
    { x: group.x, y: group.y, width: group.width, height: group.height },
    { x: 5, y: 5, width: 10, height: 10 },
  );
  assert.deepEqual(group.selrect, {
    x: 5,
    y: 5,
    width: 10,
    height: 10,
    x1: 5,
    y1: 5,
    x2: 15,
    y2: 15,
  });
  assert.equal(group.flipX, null);
  assert.equal(group.flipY, null);
});

test("names are deduped per page", () => {
  const context = createBuildContext();
  context.addFile({ name: "file 1" });
  const pageId = context.addPage({ name: "page 1" });

  const first = context.addRect({ x: 0, y: 0, width: 1, height: 1 });
  const second = context.addRect({ x: 0, y: 0, width: 1, height: 1 });

  const state = context.getInternalState() as Json;
  const page = page0(state, pageId);

  assert.equal(page.objects[first].name, "Rectangle");
  assert.equal(page.objects[second].name, "Rectangle-1");
  assert.deepEqual(state.unames[pageId].sort(), [
    "Rectangle",
    "Rectangle-1",
  ]);

  context.closePage();
  assert.equal((context.getInternalState() as Json).unames, undefined);
});

test("path content is serialized in the internal state", () => {
  const context = createBuildContext();
  context.addFile({ name: "file 1" });
  const pageId = context.addPage({ name: "page 1" });

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

  const state = context.getInternalState() as Json;
  const path = page0(state, pageId).objects[pathId];

  assert.equal(path.content, "M480,839L439,802C368,737,310,681,264,634Z");
  assert.equal(path.x, null);
  assert.equal(path.selrect.width, 216);
  assert.deepEqual(path.strokes, [
    {
      strokeStyle: "solid",
      strokeAlignment: "center",
      strokeWidth: 1,
      strokeColor: "#000000",
      strokeOpacity: 1,
    },
  ]);
});

test("create context with a color", () => {
  const context = createBuildContext();
  const fileId = context.addFile({ name: "file 1" });
  context.addPage({ name: "page 1" });

  const colorId = context.genId();
  const params = {
    color: "#000000",
    gradient: undefined,
    id: colorId,
    image: undefined,
    name: "Black-8",
    opacity: 0.800000011920929,
    path: "Remote",
  };

  assert.equal(context.addLibraryColor(params), colorId);

  const state = context.getInternalState() as Json;
  const color = state.files[fileId].data.colors[colorId];

  assert.equal(color.color, params.color);
  assert.equal(color.id, colorId);
  assert.equal(color.path, params.path);
  assert.equal(color.opacity, params.opacity);
  assert.equal(color.name, params.name);
  assert.equal(typeof color.modifiedAt, "string");
});

test("a color defaults to a full opacity", () => {
  const context = createBuildContext();
  const fileId = context.addFile({ name: "file 1" });
  context.addPage({ name: "page 1" });

  const colorId = context.addLibraryColor({ name: "Red", color: "#ff0000" });

  const state = context.getInternalState() as Json;
  assert.equal(state.files[fileId].data.colors[colorId].opacity, 1);
});

test("create context with a typography", () => {
  const context = createBuildContext();
  const fileId = context.addFile({ name: "file 1" });
  context.addPage({ name: "page 1" });

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

  const state = context.getInternalState() as Json;
  const typography = state.files[fileId].data.typographies[typographyId];

  assert.equal(typography.name, "Title");
  assert.equal(typography.fontId, "sourcesanspro");
  assert.equal(typography.lineHeight, "1.2");
  assert.equal(typeof typography.modifiedAt, "string");
});

test("addComponent links the frame to the new component", () => {
  const context = createBuildContext();
  const fileId = context.addFile({ name: "file 1" });
  context.addPage({ name: "page 1" });

  const boardId = context.addBoard({
    name: "Board 1",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });

  const componentId = context.genId();
  context.addComponent({ componentId });

  const state = context.getInternalState() as Json;
  const data = state.files[fileId].data;
  const component = data.components[componentId];
  const board = data.pagesIndex[state.currentPageId].objects[boardId];

  assert.equal(component.name, "anonmous");
  assert.equal(component.path, "");
  assert.equal(component.mainInstanceId, boardId);
  assert.equal(component.mainInstancePage, state.currentPageId);

  assert.equal(board.componentRoot, true);
  assert.equal(board.mainInstance, true);
  assert.equal(board.componentId, componentId);
  assert.equal(board.componentFile, fileId);
});

test("addFileMedia stores the blob, the media and the file media", () => {
  const context = createBuildContext();
  context.addFile({ name: "file 1" });
  context.addPage({ name: "page 1" });

  const blob = new Blob(["hello"], { type: "image/png" });
  const fileMediaId = context.addFileMedia(
    { name: "hello.png", width: 10, height: 20 },
    blob,
  );

  const state = context.getInternalState() as Json;
  const fileMedia = state.fileMedia[fileMediaId];
  const media = state.media[fileMedia.mediaId];

  assert.equal(fileMedia.name, "hello.png");
  assert.equal(fileMedia.width, 10);
  assert.equal(fileMedia.height, 20);
  assert.equal(fileMedia.mtype, "image/png");
  assert.equal(fileMedia.isLocal, true);
  assert.equal(media.bucket, "file-media-object");
  assert.equal(media.contentType, "image/png");
  assert.ok(state.blobs[fileMedia.mediaId]);

  assert.deepEqual(context.getMediaAsImage(fileMediaId), {
    id: fileMediaId,
    width: 10,
    height: 20,
    name: "hello.png",
    mtype: "image/png",
  });

  assert.equal(context.getMediaAsImage("00000000-0000-0000-0000-000000000001"), null);
});

test("deleteShape removes the shape from the parent", () => {
  const context = createBuildContext();
  context.addFile({ name: "file 1" });
  const pageId = context.addPage({ name: "page 1" });

  const rectId = context.addRect({ x: 0, y: 0, width: 1, height: 1 });
  context.deleteShape(rectId);

  const state = context.getInternalState() as Json;
  const page = page0(state, pageId);

  assert.equal(page.objects[rectId], undefined);
  assert.deepEqual(page.objects[ZERO].shapes, []);
});

test("updateShape applies the changed attributes", () => {
  const context = createBuildContext();
  context.addFile({ name: "file 1" });
  const pageId = context.addPage({ name: "page 1" });

  const rectId = context.addRect({ x: 0, y: 0, width: 1, height: 1 });
  context.updateShape(rectId, (shape) => ({ ...shape, name: "Renamed" }));

  const state = context.getInternalState() as Json;
  assert.equal(page0(state, pageId).objects[rectId].name, "Renamed");
});

test("surfaces builder failures as a BuilderError", () => {
  const context = createBuildContext();
  context.addFile({ name: "file 1" });
  context.addPage({ name: "page 1" });

  assert.throws(
    () => context.addBool({ groupId: context.genId(), type: "union" }),
    (error: unknown) =>
      error instanceof BuilderError &&
      error.code === "not-implemented" &&
      error.type === "validation",
  );

  assert.throws(
    () => context.addTokensLib("{}"),
    (error: unknown) =>
      error instanceof BuilderError &&
      error.code === "unknown" &&
      error.hint === "the file doesn't contain any tokens",
  );
});
