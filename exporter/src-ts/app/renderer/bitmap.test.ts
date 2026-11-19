// app.renderer.bitmap: the render.html url, the order of the playwright calls
// and the screenshot options of each bitmap type.

import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.PENPOT_SECRET_KEY = "test-secret";
process.env.PENPOT_INTERNAL_URI = "http://backend:6060";
process.env.PENPOT_TEMPDIR = path.join(os.tmpdir(), "penpot-exporter-bitmap");

vi.mock("../util/shell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/shell.js")>();
  return { ...actual, runCmd: vi.fn(async () => Buffer.alloc(0)) };
});

import { setExecutor } from "../browser.js";
import { callsNamed, createFakeExecutor, createFakePage, names } from "../../test/fake-browser.js";
import { render, renderUri } from "./bitmap.js";
import type { RenderObject, RenderParams } from "../renderer.js";
import { runCmd } from "../util/shell.js";

const FILE = "11111111-1111-1111-1111-111111111111";
const PAGE = "22222222-2222-2222-2222-222222222222";
const FIRST = "33333333-3333-3333-3333-333333333333";
const SECOND = "44444444-4444-4444-4444-444444444444";

function object(id: string, filename: string): RenderObject {
  return { id, name: filename.replace(/\.\w+$/, ""), suffix: "", filename };
}

function params(overrides: Partial<RenderParams> = {}): RenderParams {
  return {
    "file-id": FILE,
    "page-id": PAGE,
    scale: 2,
    token: "token",
    type: "png",
    objects: [object(FIRST, "board.png")],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(runCmd).mockClear();
});

afterEach(() => {
  setExecutor(undefined);
});

describe("renderUri", () => {
  it("builds render.html with one object-id per object", () => {
    const uri = renderUri(
      params({
        objects: [object(FIRST, "a.png"), object(SECOND, "b.png")],
        "skip-children": true,
        "share-id": "share",
      }),
    );

    expect(`${uri.origin}${uri.pathname}`).toBe("http://backend:6060/render.html");
    expect(uri.searchParams.getAll("object-id")).toEqual([FIRST, SECOND]);
    expect(uri.searchParams.get("route")).toBe("objects");
    expect(uri.searchParams.get("file-id")).toBe(FILE);
    expect(uri.searchParams.get("page-id")).toBe(PAGE);
    expect(uri.searchParams.get("share-id")).toBe("share");
    expect(uri.searchParams.get("skip-children")).toBe("true");
  });

  it("drops the keys the export did not set", () => {
    const uri = renderUri(params());

    expect(uri.searchParams.has("share-id")).toBe(false);
    expect(uri.searchParams.has("skip-children")).toBe(false);
  });
});

describe("render", () => {
  it("loads the page, waits and captures each object", async () => {
    const page = createFakePage();
    const executor = createFakeExecutor(page);
    const objects: RenderObject[] = [];
    setExecutor(executor);

    await render(params(), (object) => {
      objects.push(object);
    });

    expect(names(page)).toEqual([
      "goto",
      "waitForTimeout",
      "waitForFunction",
      "evaluate",
      "locator",
      "locator.waitFor",
      "locator.screenshot",
    ]);

    expect(callsNamed(page, "waitForTimeout")[0].args).toEqual([1000]);
    expect(callsNamed(page, "locator")[0].args).toEqual([`#screenshot-${FIRST}`]);

    const [shot] = callsNamed(page, "locator.screenshot");
    const options = shot.args[1] as Record<string, unknown>;
    expect(options).toMatchObject({ type: "png", omitBackground: true });
    expect(String(options.path)).toContain("penpot.tmp.bitmap.");

    expect(objects).toHaveLength(1);
    expect(objects[0].path).toBe(options.path);
  });

  it("passes the scale, the viewport and the auth cookie to the context", async () => {
    const page = createFakePage();
    const executor = createFakeExecutor(page);
    setExecutor(executor);

    await render(params({ scale: 3 }), () => undefined);

    expect(executor.configs[0]).toMatchObject({
      deviceScaleFactor: 3,
      locale: "en-US",
      screen: { width: 1920, height: 1080 },
      viewport: { width: 1920, height: 1080 },
      storageState: {
        cookies: [{ domain: "backend:6060", path: "/", name: "auth-token", value: "token" }],
      },
    });
  });

  it("keeps the background for jpeg", async () => {
    const page = createFakePage();
    setExecutor(createFakeExecutor(page));

    await render(params({ type: "jpeg" }), () => undefined);

    const [shot] = callsNamed(page, "locator.screenshot");
    expect(shot.args[1]).toMatchObject({ type: "jpeg", omitBackground: false });
  });

  it("converts a png to webp with ImageMagick", async () => {
    const page = createFakePage();
    setExecutor(createFakeExecutor(page));

    await render(params({ type: "webp" }), () => undefined);

    const [shot] = callsNamed(page, "locator.screenshot");
    expect(shot.args[1]).toMatchObject({ type: "png", omitBackground: true });

    const [cmd, args] = vi.mocked(runCmd).mock.calls[0];
    expect(cmd).toBe("convert");
    expect(args.slice(0, 3)).toEqual([String((shot.args[1] as Record<string, unknown>).path), "-quality", "100"]);
    expect(String(args[3])).toMatch(/^WEBP:.*\.webp$/);
  });
});