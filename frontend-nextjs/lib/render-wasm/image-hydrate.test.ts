// Unit tests for the shared image-fill hydration (F8.2). The fetch and the
// store are injected, so the cache, the data-uri branch and the failure
// handling run without a browser. One test drives the real storeImageBytes
// through a fake $APP to pin the default path.

import { describe, expect, it } from "vitest";

import { KEY, type RendererApp } from "@/lib/render-wasm/interop";
import { hydrateImageReferences } from "@/lib/render-wasm/image-hydrate";
import type { ImageFillReference } from "@/lib/workspace-image";

const SHAPE_A = "00000000-0000-0000-0000-0000000000a1";
const SHAPE_B = "00000000-0000-0000-0000-0000000000a2";
const IMAGE_1 = "00000000-0000-0000-0000-0000000000b1";
const IMAGE_2 = "00000000-0000-0000-0000-0000000000b2";

const APP = {} as RendererApp;

interface StoreCall {
  shapeId: string;
  imageId: string;
  bytes: Uint8Array;
}

function makeHarness(bytes: Record<string, Uint8Array> = {}) {
  const fetches: string[] = [];
  const stored: StoreCall[] = [];
  const errors: unknown[] = [];
  return {
    fetches,
    stored,
    errors,
    options: {
      publicUri: "http://localhost:6060",
      fetchBytes: async (url: string): Promise<Uint8Array> => {
        fetches.push(url);
        const imageId = url.slice(url.lastIndexOf("/") + 1);
        const found = bytes[imageId];
        if (found === undefined) throw new Error(`no bytes for ${imageId}`);
        return found;
      },
      store: (shapeId: string, imageId: string, data: Uint8Array): void => {
        stored.push({ shapeId, imageId, bytes: data });
      },
      onError: (cause: unknown) => errors.push(cause),
    },
  };
}

function reference(shapeId: string, imageId: string, dataUri?: string): ImageFillReference {
  return { shapeId, imageId, ...(dataUri !== undefined ? { dataUri } : {}) };
}

describe("hydrateImageReferences", () => {
  it("fetches one media id once and stores it for every pair", async () => {
    const harness = makeHarness({ [IMAGE_1]: new Uint8Array([1, 2, 3]) });
    await hydrateImageReferences(
      APP,
      [reference(SHAPE_A, IMAGE_1), reference(SHAPE_B, IMAGE_1)],
      harness.options,
    );
    expect(harness.fetches).toEqual([
      `http://localhost:6060/assets/by-file-media-id/${IMAGE_1}`,
    ]);
    expect(harness.stored.map((call) => [call.shapeId, call.imageId])).toEqual([
      [SHAPE_A, IMAGE_1],
      [SHAPE_B, IMAGE_1],
    ]);
    expect([...harness.stored[1].bytes]).toEqual([1, 2, 3]);
  });

  it("reads a data-uri without fetching", async () => {
    const harness = makeHarness();
    await hydrateImageReferences(
      APP,
      [reference(SHAPE_A, IMAGE_2, "data:image/png;base64,AQID")],
      harness.options,
    );
    expect(harness.fetches).toEqual([]);
    expect([...harness.stored[0].bytes]).toEqual([1, 2, 3]);
  });

  it("skips a malformed data-uri without reporting an error", async () => {
    const harness = makeHarness();
    await hydrateImageReferences(
      APP,
      [reference(SHAPE_A, IMAGE_2, "not-a-data-uri")],
      harness.options,
    );
    expect(harness.stored).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  it("reports a failing fetch and keeps going", async () => {
    const harness = makeHarness({ [IMAGE_2]: new Uint8Array([9]) });
    await hydrateImageReferences(
      APP,
      [reference(SHAPE_A, IMAGE_1), reference(SHAPE_B, IMAGE_2)],
      harness.options,
    );
    expect(harness.errors).toHaveLength(1);
    expect(String(harness.errors[0])).toContain(`no bytes for ${IMAGE_1}`);
    expect(harness.stored.map((call) => call.imageId)).toEqual([IMAGE_2]);
  });

  it("stops between references once the canvas is gone", async () => {
    const harness = makeHarness({
      [IMAGE_1]: new Uint8Array([1]),
      [IMAGE_2]: new Uint8Array([2]),
    });
    let alive = true;
    await hydrateImageReferences(
      APP,
      [reference(SHAPE_A, IMAGE_1), reference(SHAPE_B, IMAGE_2)],
      {
        ...harness.options,
        fetchBytes: async (url: string): Promise<Uint8Array> => {
          const bytes = await harness.options.fetchBytes(url);
          alive = false;
          return bytes;
        },
        isAlive: () => alive,
      },
    );
    expect(harness.stored).toEqual([]);
  });

  it("does nothing for an empty list", async () => {
    const harness = makeHarness();
    await hydrateImageReferences(APP, [], harness.options);
    expect(harness.fetches).toEqual([]);
    expect(harness.stored).toEqual([]);
  });

  it("writes through storeImageBytes when no store is injected", async () => {
    const heapU8 = new Uint8Array(64);
    const heapU32 = new Uint32Array(heapU8.buffer);
    let stored = 0;
    let renders = 0;
    const app = {
      [KEY.internalModule]: {
        // The fake heap starts at 0; the real allocator hands out an offset.
        _alloc_bytes: (): number => 0,
        _store_image: (): void => {
          stored += 1;
        },
        HEAPU8: heapU8,
        HEAPU32: heapU32,
      },
      [KEY.requestRender]: (): void => {
        renders += 1;
      },
    } as unknown as RendererApp;

    await hydrateImageReferences(app, [reference(SHAPE_A, IMAGE_1)], {
      publicUri: "http://localhost:6060",
      fetchBytes: async (): Promise<Uint8Array> => new Uint8Array([7]),
      onError: (cause: unknown) => {
        throw cause;
      },
    });
    expect(stored).toBe(1);
    expect(renders).toBe(1);
  });
});
