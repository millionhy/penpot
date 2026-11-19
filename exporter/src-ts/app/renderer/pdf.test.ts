// app.renderer.pdf: one page load per object, the page size sync before the
// print and the pdf request itself.

import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

process.env.PENPOT_SECRET_KEY = "test-secret";
process.env.PENPOT_INTERNAL_URI = "http://backend:6060";
process.env.PENPOT_TEMPDIR = path.join(os.tmpdir(), "penpot-exporter-pdf");

import { setExecutor } from "../browser.js";
import { callsNamed, createFakeExecutor, createFakePage, names } from "../../test/fake-browser.js";
import type { RenderObject, RenderParams } from "../renderer.js";
import { render, renderUri } from "./pdf.js";

const FILE = "11111111-1111-1111-1111-111111111111";
const PAGE = "22222222-2222-2222-2222-222222222222";
const FIRST = "33333333-3333-3333-3333-333333333333";
const SECOND = "44444444-4444-4444-4444-444444444444";

function object(id: string): RenderObject {
  return { id, name: "board", suffix: "", filename: "board.pdf" };
}

function params(overrides: Partial<RenderParams> = {}): RenderParams {
  return {
    "file-id": FILE,
    "page-id": PAGE,
    scale: 1,
    token: "token",
    type: "pdf",
    objects: [object(FIRST)],
    ...overrides,
  };
}

afterEach(() => {
  setExecutor(undefined);
});

describe("renderUri", () => {
  it("asks for a single object", () => {
    const uri = renderUri(params(), "http://backend:6060/", SECOND);

    expect(`${uri.origin}${uri.pathname}`).toBe("http://backend:6060/render.html");
    expect(uri.searchParams.getAll("object-id")).toEqual([SECOND]);
    expect(uri.searchParams.get("route")).toBe("objects");
    expect(uri.searchParams.get("file-id")).toBe(FILE);
  });
});

describe("render", () => {
  it("reloads the page and prints one pdf per object", async () => {
    const page = createFakePage();
    setExecutor(createFakeExecutor(page));
    const rendered: RenderObject[] = [];

    await render(params({ objects: [object(FIRST), object(SECOND)] }), (object) => {
      rendered.push(object);
    });

    expect(callsNamed(page, "goto")).toHaveLength(2);
    expect(callsNamed(page, "pdf")).toHaveLength(2);
    expect(rendered.map((item) => item.id)).toEqual([FIRST, SECOND]);

    expect(names(page).slice(0, 8)).toEqual([
      "goto",
      "locator",
      "locator.waitFor",
      "locator.evaluate",
      "locator.screenshot",
      "waitForTimeout",
      "waitForFunction",
      "pdf",
    ]);

    expect(callsNamed(page, "waitForTimeout")[0].args).toEqual([2000]);

    const [print] = callsNamed(page, "pdf");
    const options = print.args[0] as Record<string, unknown>;
    expect(options).toMatchObject({ printBackground: true, preferCSSPageSize: true, scale: 1 });
    expect(String(options.path)).toMatch(/penpot\.tmp\.pdf\..*\.pdf$/);
  });

  it("pins the page size to the exported node", async () => {
    const page = createFakePage();
    setExecutor(createFakeExecutor(page));

    await render(params(), () => undefined);

    const [sync] = callsNamed(page, "locator.evaluate");
    expect(String(sync.args[1])).toContain("@page { size:");
    expect(String(sync.args[1])).toContain("width");
  });

  it("screenshots the node full page before printing", async () => {
    const page = createFakePage();
    setExecutor(createFakeExecutor(page));

    await render(params(), () => undefined);

    const [shot] = callsNamed(page, "locator.screenshot");
    expect(shot.args[1]).toMatchObject({ fullPage: true });
  });
});