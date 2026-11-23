// Unit tests for the shared image-fill hydration (F8.2), now over the
// workspace engine handle. The fetch is injected, so the cache, the data-uri
// branch and the failure handling run without a browser. One test drives the
// default store path through a mocked engine `storeImage`.

import { beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  storeImage: vi.fn(),
}));

vi.mock("@/lib/render-wasm/engine", () => ({
  storeImage: engine.storeImage,
}));

import { hydrateImageReferences } from "@/lib/render-wasm/image-hydrate";
import type { WorkspaceApp } from "@/lib/render-wasm/workspace-app";
import type { ImageFillReference } from "@/lib/workspace-image";

const SHAPE_A = "00000000-0000-0000-0000-0000000000a1";
const SHAPE_B = "00000000-0000-0000-0000-0000000000a2";
const IMAGE_1 = "00000000-0000-0000-0000-0000000000b1";
const IMAGE_2 = "00000000-0000-0000-0000-0000000000b2";

interface Harness {
  app: WorkspaceApp;
  renders: string[];
}

function makeApp(): Harness {
  const renders: string[] = [];
  const app = {
    module: { name: "fake-module" },
    loop: {
      requestRender: (reason: string): boolean => {
        renders.push(reason);
        return true;
      },
    },
    host: { hostAttrs: (): void => {} },
  };
  return { app: app as unknown as WorkspaceApp, renders };
}

interface StoreCall {
  shapeId: string;
  imageId: string;
  bytes: Uint8Array;
}

function makeHarness(bytes: Record<string, Uint8Array> = {}) {
  const { app } = makeApp();
  const fetches: string[] = [];
  const stored: StoreCall[] = [];
  const errors: unknown[] = [];
  return {
    app,
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

beforeEach(() => {
  engine.storeImage.mockReset();
});

describe("hydrateImageReferences", () => {
  it("fetches one media id once and stores it for every pair", async () => {
    const harness = makeHarness({ [IMAGE_1]: new Uint8Array([1, 2, 3]) });
    await hydrateImageReferences(
      harness.app,
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
      harness.app,
      [reference(SHAPE_A, IMAGE_2, "data:image/png;base64,AQID")],
      harness.options,
    );
    expect(harness.fetches).toEqual([]);
    expect([...harness.stored[0].bytes]).toEqual([1, 2, 3]);
  });

  it("skips a malformed data-uri without reporting an error", async () => {
    const harness = makeHarness();
    await hydrateImageReferences(
      harness.app,
      [reference(SHAPE_A, IMAGE_2, "not-a-data-uri")],
      harness.options,
    );
    expect(harness.stored).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  it("reports a failing fetch and keeps going", async () => {
    const harness = makeHarness({ [IMAGE_2]: new Uint8Array([9]) });
    await hydrateImageReferences(
      harness.app,
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
      harness.app,
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
    await hydrateImageReferences(harness.app, [], harness.options);
    expect(harness.fetches).toEqual([]);
    expect(harness.stored).toEqual([]);
  });

  it("writes through storeImageBytes when no store is injected", async () => {
    const { app, renders } = makeApp();

    await hydrateImageReferences(app, [reference(SHAPE_A, IMAGE_1)], {
      publicUri: "http://localhost:6060",
      fetchBytes: async (): Promise<Uint8Array> => new Uint8Array([7]),
      onError: (cause: unknown) => {
        throw cause;
      },
    });

    expect(engine.storeImage).toHaveBeenCalledWith(
      app.module,
      SHAPE_A,
      IMAGE_1,
      new Uint8Array([7]),
      false,
    );
    expect(renders).toEqual(["store-image"]);
  });
});
