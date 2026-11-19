// app.renderer: params validation, the backend dispatch and the scope rules for
// headless exports.

import { afterEach, describe, expect, it, vi } from "vitest";

process.env.PENPOT_SECRET_KEY = "test-secret";

vi.mock("./renderer/bitmap.js", () => ({ render: vi.fn(async () => undefined) }));
vi.mock("./renderer/pdf.js", () => ({ render: vi.fn(async () => undefined) }));
vi.mock("./renderer/svg.js", () => ({ render: vi.fn(async () => undefined) }));

import { errorData } from "./errors.js";
import * as bitmap from "./renderer/bitmap.js";
import * as pdf from "./renderer/pdf.js";
import * as svg from "./renderer/svg.js";
import {
  checkParams,
  render,
  setHeadlessRenderer,
  withScope,
  type HeadlessRenderer,
  type RenderFn,
  type RenderParams,
} from "./renderer.js";

const FILE = "11111111-1111-1111-1111-111111111111";
const PAGE = "22222222-2222-2222-2222-222222222222";
const OBJECT = "33333333-3333-3333-3333-333333333333";

function params(overrides: Partial<RenderParams> = {}): RenderParams {
  return {
    "file-id": FILE,
    "page-id": PAGE,
    scale: 1,
    token: "token",
    type: "png",
    objects: [{ id: OBJECT, name: "board", suffix: "", filename: "board.png" }],
    ...overrides,
  };
}

const onObject = () => undefined;

function rejected(run: () => unknown) {
  try {
    run();
  } catch (cause) {
    return errorData(cause);
  }
  throw new Error("expected a rejection");
}

afterEach(() => {
  setHeadlessRenderer(undefined);
  vi.clearAllMocks();
});

describe("checkParams", () => {
  it("accepts the render params", () => {
    expect(() => checkParams(params())).not.toThrow();
  });

  it("wants file and page uuids", () => {
    expect(rejected(() => checkParams(params({ "file-id": "nope" })))).toMatchObject({
      type: "assertion",
      hint: "file-id should be a uuid",
    });
  });

  it("wants at least one object", () => {
    expect(rejected(() => checkParams(params({ objects: [] }))).hint).toContain(
      "objects should be a non-empty collection",
    );
  });

  it("wants a known type", () => {
    expect(rejected(() => checkParams(params({ type: "gif" as never }))).hint).toContain(
      "type should be one of",
    );
  });

  it("wants a boolean is-wasm", () => {
    expect(rejected(() => checkParams({ ...params(), "is-wasm": "yes" })).hint).toContain(
      "is-wasm should be a boolean",
    );
  });

  it("checks the fields of every object", () => {
    const broken = params({ objects: [{ id: OBJECT, name: "x" } as never] });

    const hint = String(rejected(() => checkParams(broken)).hint);
    expect(hint).toContain("objects[0].suffix should be a string");
    expect(hint).toContain("objects[0].filename should be a string");
  });
});

describe("render", () => {
  it("sends png, jpeg and webp to the bitmap renderer", async () => {
    await render(params({ type: "png" }), onObject);
    await render(params({ type: "jpeg" }), onObject);
    await render(params({ type: "webp" }), onObject);

    expect(vi.mocked(bitmap.render)).toHaveBeenCalledTimes(3);
  });

  it("sends pdf and svg to their renderers", async () => {
    await render(params({ type: "pdf" }), onObject);
    await render(params({ type: "svg" }), onObject);

    expect(vi.mocked(pdf.render)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(svg.render)).toHaveBeenCalledTimes(1);
  });

  it("sends a headless render to the registered backend", async () => {
    const backend: HeadlessRenderer = {
      render: vi.fn(async () => undefined),
      withScope: vi.fn(async () => undefined),
    };
    setHeadlessRenderer(backend);

    await render(params({ "is-wasm": true }), onObject);

    expect(backend.render).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bitmap.render)).not.toHaveBeenCalled();
  });

  it("refuses a headless render when no backend is registered", async () => {
    await expect(render(params({ "is-wasm": true }), onObject)).rejects.toMatchObject({
      data: { code: "headless-renderer-not-ready" },
    });
  });
});

describe("withScope", () => {
  it("hands the plain render when nothing is headless", async () => {
    let received: RenderFn | undefined;

    await withScope([params()], async (renderLeased) => {
      received = renderLeased;
      await renderLeased(params({ type: "svg" }), onObject);
    });

    expect(received).toBe(render);
    expect(vi.mocked(svg.render)).toHaveBeenCalledTimes(1);
  });

  it("leases one worker for a headless batch", async () => {
    const jobId = "44444444-4444-4444-4444-444444444444";
    const leased: RenderFn = vi.fn(async () => undefined);
    const backend: HeadlessRenderer = {
      render: vi.fn(async () => undefined),
      withScope: vi.fn(async (requested, f) => {
        expect(requested).toBe(jobId);
        await f(leased);
      }),
    };
    setHeadlessRenderer(backend);

    await withScope([params({ "is-wasm": true, "job-id": jobId })], async (renderLeased) => {
      await renderLeased(params({ "is-wasm": true }), onObject);
      await renderLeased(params({ type: "png" }), onObject);
    });

    expect(vi.mocked(leased)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bitmap.render)).toHaveBeenCalledTimes(1);
  });

  it("refuses a headless batch without a backend", async () => {
    await expect(
      withScope([params({ "is-wasm": true })], async () => undefined),
    ).rejects.toMatchObject({ data: { code: "headless-renderer-not-ready" } });
  });
});