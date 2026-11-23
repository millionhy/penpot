// Unit tests for the workspace runtime handle (G4.6b).
//
// The engine owns the buffers; this module owns the application policy:
// which host attrs a cold batch skips, how font fetches are deduplicated and
// how a landed face relayouts the shapes that waited on it. The engine barrel
// is replaced with recorders so the assertions read the protocol, not bytes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => {
  const state = {
    live: true,
    uploaded: new Set<string>(),
    writeCalls: [] as Array<{ shape: unknown; options: Record<string, unknown> }>,
    storeUrlCalls: [] as string[],
    forcedLayouts: [] as string[],
    loops: [] as FakeLoop[],
  };

  class FakeLoop {
    readonly options: {
      isGestureActive?: () => boolean;
      onError?: (cause: unknown) => void;
    };
    readonly renders: string[] = [];

    constructor(options: FakeLoop["options"]) {
      this.options = options;
      state.loops.push(this);
    }

    requestRender(reason: string): boolean {
      this.renders.push(reason);
      return true;
    }

    dispose(): void {}
  }

  return {
    state,
    FakeLoop,
    writeHostAttrs: vi.fn(
      (
        _module: unknown,
        shape: unknown,
        options: {
          text?: { prepareFonts?: (content: unknown) => void };
        },
      ) => {
        state.writeCalls.push({ shape, options: options as unknown as Record<string, unknown> });
        const content = (shape as { content?: unknown }).content;
        options.text?.prepareFonts?.(content);
      },
    ),
    storeFont: vi.fn(
      (module: unknown, face: { id: string; weight: number; style: number }) => {
        void module;
        state.uploaded.add(`${face.id}|${face.weight}|${face.style}|0`);
        return true;
      },
    ),
    storeFontUrl: vi.fn((module: unknown, face: { id: string }, url: string) => {
      void module;
      void face;
      state.storeUrlCalls.push(url);
      return true;
    }),
    isFontUploaded: vi.fn((module: unknown, face: { id: string; weight: number; style: number }, emoji: boolean) => {
      void module;
      return state.uploaded.has(`${face.id}|${face.weight}|${face.style}|${emoji ? 1 : 0}`);
    }),
    forceUpdateTextLayout: vi.fn((module: unknown, id: string) => {
      void module;
      state.forcedLayouts.push(id);
      return true;
    }),
    live: vi.fn(() => state.live),
    ready: vi.fn(() => state.live),
    fontIdToUuid: vi.fn(() => "00000000-0000-0000-0000-000000000000"),
  };
});

vi.mock("@/lib/render-wasm/engine", () => ({
  RenderLoop: engine.FakeLoop,
  writeHostAttrs: engine.writeHostAttrs,
  storeFont: engine.storeFont,
  storeFontUrl: engine.storeFontUrl,
  isFontUploaded: engine.isFontUploaded,
  forceUpdateTextLayout: engine.forceUpdateTextLayout,
  live: engine.live,
  ready: engine.ready,
  fontIdToUuid: engine.fontIdToUuid,
}));

import {
  createWorkspaceApp,
  createWorkspaceHost,
  type WorkspaceHostOptions,
} from "@/lib/render-wasm/workspace-app";

const PUBLIC_URI = "https://cdn.test";
const SHAPE_A = "11111111-1111-1111-1111-111111111111";
const SHAPE_B = "22222222-2222-2222-2222-222222222222";
const CUSTOM_FONT = "custom-33333333-3333-3333-3333-333333333333";

let moduleSeq = 0;

function freshModule(): { name: string } {
  moduleSeq += 1;
  return { name: `fake-module-${moduleSeq}` };
}

function textContent(fontId = "sourcesanspro"): Record<string, unknown> {
  return {
    children: [
      {
        children: [
          {
            children: [
              {
                text: "hello",
                "font-id": fontId,
                "font-variant-id": "regular",
                "font-weight": "400",
                "font-style": "normal",
              },
            ],
          },
        ],
      },
    ],
  };
}

function textShape(id: string, fontId = "sourcesanspro"): never {
  return {
    id,
    type: "text",
    content: textContent(fontId),
  } as never;
}

function makeHost(
  options: Partial<WorkspaceHostOptions> = {},
): ReturnType<typeof createWorkspaceHost> {
  return createWorkspaceHost({
    module: freshModule() as never,
    publicUri: PUBLIC_URI,
    fetchBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    ...options,
  });
}

beforeEach(() => {
  engine.state.live = true;
  engine.state.uploaded.clear();
  engine.state.writeCalls.length = 0;
  engine.state.storeUrlCalls.length = 0;
  engine.state.forcedLayouts.length = 0;
  engine.state.loops.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  engine.state.live = true;
});

describe("createWorkspaceHost", () => {
  it("marks only a cold load with the batch skip flags", () => {
    const host = makeHost();
    const shape = textShape(SHAPE_A);

    host.hostAttrs(shape);
    expect(engine.state.writeCalls).toHaveLength(1);
    expect(engine.state.writeCalls[0].options).toMatchObject({
      skipLayout: false,
      skipFillsStrokes: false,
    });

    host.hostAttrs(shape, { coldLoad: true });
    expect(engine.state.writeCalls[1].options).toMatchObject({
      skipLayout: true,
      skipFillsStrokes: true,
    });
  });

  it("fetches one face once and relayouts every waiting shape", async () => {
    const fetchBytes = vi.fn(async () => new Uint8Array([1]));
    const onFontsReady = vi.fn();
    const host = makeHost({ fetchBytes, onFontsReady });

    host.hostAttrs(textShape(SHAPE_A));
    host.hostAttrs(textShape(SHAPE_B));

    await vi.waitFor(() => {
      expect(engine.state.forcedLayouts).toHaveLength(2);
    });
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(fetchBytes).toHaveBeenCalledWith(`${PUBLIC_URI}/fonts/sourcesanspro-regular.ttf`);
    expect(engine.state.forcedLayouts.sort()).toEqual([SHAPE_A, SHAPE_B].sort());
    expect(onFontsReady).toHaveBeenCalledTimes(1);
    expect(engine.state.storeUrlCalls).toEqual([
      `${PUBLIC_URI}/fonts/sourcesanspro-regular.ttf`,
    ]);
  });

  it("keeps a failed face failed for the module", async () => {
    const fetchBytes = vi.fn(async () => {
      throw new Error("offline");
    });
    const onError = vi.fn();
    const host = makeHost({ fetchBytes, onError });

    host.hostAttrs(textShape(SHAPE_A));
    host.hostAttrs(textShape(SHAPE_B));

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toBe(
      `${PUBLIC_URI}/fonts/sourcesanspro-regular.ttf`,
    );
    expect(engine.state.forcedLayouts).toHaveLength(0);
  });

  it("refreshes the source URL without fetching when the face is already stored", () => {
    engine.state.uploaded.add(
      "00000000-0000-0000-0000-000000000000|400|0|0",
    );
    const fetchBytes = vi.fn(async () => new Uint8Array([1]));
    const host = makeHost({ fetchBytes });

    host.hostAttrs(textShape(SHAPE_A));

    expect(fetchBytes).not.toHaveBeenCalled();
    expect(engine.state.storeUrlCalls).toEqual([
      `${PUBLIC_URI}/fonts/sourcesanspro-regular.ttf`,
    ]);
    expect(engine.state.forcedLayouts).toHaveLength(0);
  });

  it("resolves a custom face through the injected registry row", async () => {
    const fetchBytes = vi.fn(async () => new Uint8Array([1]));
    const host = makeHost({
      fetchBytes,
      getCustomVariant: () => ({ weight: "400", style: "normal", ttfFileId: "asset-1" }),
    });

    host.hostAttrs(textShape(SHAPE_A, CUSTOM_FONT));

    await vi.waitFor(() => {
      expect(engine.state.forcedLayouts).toEqual([SHAPE_A]);
    });
    expect(fetchBytes).toHaveBeenCalledWith(`${PUBLIC_URI}/assets/by-id/asset-1`);
  });

  it("writes nothing when the renderer is not live", () => {
    engine.state.live = false;
    const host = makeHost();

    host.hostAttrs(textShape(SHAPE_A));

    expect(engine.state.writeCalls).toHaveLength(0);
  });
});

describe("createWorkspaceApp", () => {
  it("passes the gesture probe and renders after fonts land", async () => {
    const fetchBytes = vi.fn(async () => new Uint8Array([1]));
    let gesture = false;
    const app = createWorkspaceApp(freshModule() as never, {
      publicUri: PUBLIC_URI,
      fetchBytes,
      isGestureActive: () => gesture,
    });

    const loop = engine.state.loops[0];
    expect(loop.options.isGestureActive?.()).toBe(false);
    gesture = true;
    expect(loop.options.isGestureActive?.()).toBe(true);

    app.host.hostAttrs(textShape(SHAPE_A));
    await vi.waitFor(() => {
      expect(loop.renders).toContain("fonts-loaded");
    });
  });
});
