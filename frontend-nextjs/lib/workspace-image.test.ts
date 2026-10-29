// Unit tests for the image model (lib/workspace-image): the media upload of
// process-blobs, the image fill of types.fills/create and the centered rect
// of image-uploaded. The RPC and upload layers are mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the imports, so the factories must reach the
// spies through vi.hoisted instead of top-level consts.
const mocks = vi.hoisted(() => ({
  cmd: vi.fn(),
  cmdUpload: vi.fn(),
  uploadBlobChunked: vi.fn(),
}));

vi.mock("@/lib/rpc", () => ({ cmd: mocks.cmd, cmdUpload: mocks.cmdUpload }));
vi.mock("@/lib/uploads", () => ({
  DEFAULT_UPLOAD_CHUNK_SIZE: 25,
  uploadBlobChunked: mocks.uploadBlobChunked,
}));

import {
  IMAGE_ACCEPT,
  createImageShape,
  dataUriBytes,
  imageFill,
  imageFillReferences,
  imageMediaUrl,
  isBitmapImage,
  newImageFillReferences,
  stripImageExtension,
  uploadImage,
  type UploadedImage,
} from "@/lib/workspace-image";
import type { WorkspaceShape } from "@/lib/workspace";

const { cmd, cmdUpload, uploadBlobChunked } = mocks;

const IMAGE: UploadedImage = {
  id: "media-1",
  name: "photo",
  width: 200,
  height: 100,
  mtype: "image/png",
};

// The File surface uploadImage reads: the name, the type and the size.
function file(name: string, type: string, size = 10): File {
  return { name, type, size } as unknown as File;
}

beforeEach(() => {
  cmd.mockReset();
  cmdUpload.mockReset();
  uploadBlobChunked.mockReset();
});

describe("stripImageExtension", () => {
  it("drops the last extension of the name", () => {
    expect(stripImageExtension("photo.png")).toBe("photo");
    expect(stripImageExtension("a.b.jpg")).toBe("a.b");
  });

  it("keeps a name without an extension or with a bare dot", () => {
    expect(stripImageExtension("photo")).toBe("photo");
    expect(stripImageExtension("photo.")).toBe("photo.");
  });
});

describe("isBitmapImage", () => {
  it("accepts the bitmap types the wasm image store decodes", () => {
    expect(isBitmapImage(file("a.png", "image/png"))).toBe(true);
    expect(isBitmapImage(file("a.jpeg", "image/jpeg"))).toBe(true);
    expect(isBitmapImage(file("a.webp", "image/webp"))).toBe(true);
    expect(isBitmapImage(file("a.gif", "image/gif"))).toBe(true);
  });

  it("rejects SVG and unknown types", () => {
    expect(isBitmapImage(file("a.svg", "image/svg+xml"))).toBe(false);
    expect(isBitmapImage(file("a.bin", "application/octet-stream"))).toBe(false);
  });

  it("lists the media types of the picker", () => {
    expect(IMAGE_ACCEPT).toBe("image/jpeg,image/png,image/webp,image/gif,image/svg+xml");
  });
});

describe("uploadImage", () => {
  it("uploads a small file in one multipart call", async () => {
    const picked = file("my.photo.png", "image/png");
    cmdUpload.mockResolvedValue(IMAGE);
    await expect(uploadImage(picked, "file-1")).resolves.toBe(IMAGE);
    expect(uploadBlobChunked).not.toHaveBeenCalled();
    expect(cmdUpload).toHaveBeenCalledWith("upload-file-media-object", {
      "file-id": "file-1",
      "is-local": false,
      name: "my.photo",
      content: picked,
    });
    expect(cmd).not.toHaveBeenCalled();
  });

  it("runs the chunked session and assembles the media object at the threshold", async () => {
    const picked = file("big.png", "image/png", 25);
    uploadBlobChunked.mockResolvedValue({ sessionId: "session-1" });
    cmd.mockResolvedValue(IMAGE);
    await expect(uploadImage(picked, "file-1")).resolves.toBe(IMAGE);
    expect(uploadBlobChunked).toHaveBeenCalledWith(picked);
    expect(cmd).toHaveBeenCalledWith("assemble-file-media-object", {
      "session-id": "session-1",
      "file-id": "file-1",
      "is-local": false,
      name: "big",
      mtype: "image/png",
    });
    expect(cmdUpload).not.toHaveBeenCalled();
  });

  it("falls back to a generic name when the file name has no stem", async () => {
    cmdUpload.mockResolvedValue(IMAGE);
    await uploadImage(file(".png", "image/png"), "file-1");
    expect(cmdUpload).toHaveBeenCalledWith(
      "upload-file-media-object",
      expect.objectContaining({ name: "image" }),
    );
  });
});

describe("imageFill", () => {
  it("builds the fill types.fills/create returns for an image", () => {
    expect(imageFill(IMAGE)).toEqual({
      "fill-opacity": 1,
      "fill-image": {
        width: 200,
        height: 100,
        mtype: "image/png",
        id: "media-1",
        "keep-aspect-ratio": true,
      },
    });
  });
});

describe("imageMediaUrl", () => {
  it("builds the by-file-media-id URL of cf/resolve-file-media", () => {
    expect(imageMediaUrl("media-1", "http://host/")).toBe(
      "http://host/assets/by-file-media-id/media-1",
    );
    expect(imageMediaUrl("media-1", "http://host")).toBe(
      "http://host/assets/by-file-media-id/media-1",
    );
    expect(imageMediaUrl("media-1", "")).toBe("/assets/by-file-media-id/media-1");
  });
});

describe("imageFillReferences", () => {
  const shape = (id: string, extra: Record<string, unknown> = {}): WorkspaceShape => ({
    id,
    type: "rect",
    ...extra,
  });

  it("collects one reference per shape and image", () => {
    const objects = {
      a: shape("a", { fills: [imageFill(IMAGE)] }),
      b: shape("b", { fills: [imageFill(IMAGE)] }),
    };
    expect(imageFillReferences(objects)).toEqual([
      { shapeId: "a", imageId: "media-1" },
      { shapeId: "b", imageId: "media-1" },
    ]);
  });

  it("dedupes a repeated fill and keeps the data-uri", () => {
    const fill = {
      "fill-opacity": 1,
      "fill-image": { id: "media-1", "data-uri": "data:image/png;base64,AA==" },
    };
    expect(imageFillReferences({ a: shape("a", { fills: [fill, fill] }) })).toEqual([
      { shapeId: "a", imageId: "media-1", dataUri: "data:image/png;base64,AA==" },
    ]);
  });

  it("skips solid fills, malformed fills and fills without an id", () => {
    const objects = {
      a: shape("a", { fills: [{ "fill-color": "#000000", "fill-opacity": 1 }] }),
      b: shape("b", { fills: [null, 3, { "fill-image": null }, { "fill-image": {} }] }),
      c: shape("c", { fills: [{ "fill-image": { id: 7 } }] }),
      d: shape("d", { fills: [{ "fill-image": { id: "" } }] }),
      e: shape("e"),
      f: shape("f", { fills: "nope" }),
    };
    expect(imageFillReferences(objects)).toEqual([]);
  });
});

describe("newImageFillReferences", () => {
  const shape = (id: string, extra: Record<string, unknown> = {}): WorkspaceShape => ({
    id,
    type: "rect",
    ...extra,
  });
  const imageFillWith = (id: string): Record<string, unknown> => ({
    "fill-opacity": 1,
    "fill-image": { id, width: 10, height: 10, mtype: "image/png" },
  });

  it("answers the pairs the second model adds", () => {
    const before = {
      a: shape("a", { fills: [imageFillWith("media-1")] }),
    };
    const after = {
      a: shape("a", { fills: [imageFillWith("media-1")] }),
      b: shape("b", { fills: [imageFillWith("media-2")] }),
    };
    expect(newImageFillReferences(before, after)).toEqual([
      { shapeId: "b", imageId: "media-2" },
    ]);
  });

  it("answers a fill that replaced the image of an existing shape", () => {
    const before = { a: shape("a", { fills: [imageFillWith("media-1")] }) };
    const after = { a: shape("a", { fills: [imageFillWith("media-2")] }) };
    expect(newImageFillReferences(before, after)).toEqual([
      { shapeId: "a", imageId: "media-2" },
    ]);
  });

  it("answers nothing when the pairs do not change", () => {
    const objects = { a: shape("a", { fills: [imageFillWith("media-1")] }) };
    expect(newImageFillReferences(objects, objects)).toEqual([]);
    // A pure removal adds no pair either.
    expect(newImageFillReferences(objects, {})).toEqual([]);
  });
});

describe("dataUriBytes", () => {
  it("decodes a base64 data-uri", () => {
    expect(dataUriBytes("data:image/png;base64,AAEC")).toEqual(new Uint8Array([0, 1, 2]));
  });

  it("answers null for anything that is not base64", () => {
    expect(dataUriBytes("data:image/png,\u0000\u0001")).toBeNull();
    expect(dataUriBytes("nope")).toBeNull();
    expect(dataUriBytes("data:image/png;base64,***")).toBeNull();
  });
});

describe("createImageShape", () => {
  it("centers the natural image size on the drop point and locks the proportion", () => {
    const shape = createImageShape(IMAGE, { x: 300, y: 200 }, "frame-1", "shape-1");
    expect(shape).toMatchObject({
      id: "shape-1",
      type: "rect",
      name: "photo",
      "parent-id": "frame-1",
      "frame-id": "frame-1",
      x: 200,
      y: 150,
      width: 200,
      height: 100,
      selrect: { x: 200, y: 150, width: 200, height: 100, x1: 200, y1: 150, x2: 400, y2: 250 },
      points: [
        { x: 200, y: 150 },
        { x: 400, y: 150 },
        { x: 400, y: 250 },
        { x: 200, y: 250 },
      ],
      proportion: 2,
      "proportion-lock": true,
      fills: [imageFill(IMAGE)],
      strokes: [],
      r1: 0,
      r2: 0,
      r3: 0,
      r4: 0,
    });
  });

  it("rounds the centered position like mth/round", () => {
    const shape = createImageShape(
      { ...IMAGE, width: 5, height: 5 },
      { x: 10.4, y: 10.6 },
      "frame-1",
      "shape-1",
    );
    expect(shape.x).toBe(8);
    expect(shape.y).toBe(8);
  });

  it("keeps the minimal 0.01 side of grc/make-rect for an empty image", () => {
    const shape = createImageShape(
      { ...IMAGE, width: 0, height: 0 },
      { x: 100, y: 100 },
      "frame-1",
      "shape-1",
    );
    expect(shape.width).toBe(0.01);
    expect(shape.height).toBe(0.01);
    expect(shape.proportion).toBe(1);
  });

  it("names the shape Image when the media carries no name", () => {
    const shape = createImageShape(
      { ...IMAGE, name: undefined },
      { x: 0, y: 0 },
      "frame-1",
      "shape-1",
    );
    expect(shape.name).toBe("Image");
  });
});
