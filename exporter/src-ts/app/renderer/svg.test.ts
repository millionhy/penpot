// app.renderer.svg: the tree helpers driven through an injected codec, and one
// render over a fake page that checks what lands on disk.

import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.PENPOT_SECRET_KEY = "test-secret";
process.env.PENPOT_INTERNAL_URI = "http://internal:6060";
process.env.PENPOT_PUBLIC_URI = "https://public.example";
process.env.PENPOT_TEMPDIR = path.join(os.tmpdir(), "penpot-exporter-svg");

const fake = vi.hoisted(() => ({
  page: { kind: "page" },
  configs: [] as unknown[],
  evaluate: (_locator: { selector: string }, _fn: unknown): unknown => undefined,
}));

vi.mock("../browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../browser.js")>();
  return {
    ...actual,
    exec: vi.fn(async (config: unknown, handle: (page: unknown) => Promise<unknown>) => {
      fake.configs.push(config);
      return handle(fake.page);
    }),
    navigate: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    waitForFonts: vi.fn(async () => undefined),
    waitFor: vi.fn(async () => undefined),
    select: vi.fn((_page: unknown, selector: string) => ({ selector })),
    selectAll: vi.fn(async (_page: unknown, selector: string) => [{ selector }]),
    evaluate: vi.fn(async (locator: { selector: string }, fn: unknown) => fake.evaluate(locator, fn)),
    screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
});

vi.mock("../util/shell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/shell.js")>();
  return {
    ...actual,
    tempfile: vi.fn(() => "penpot.tmp.render.svg.test.svg"),
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => Buffer.from("<svg/>")),
    runCmd: vi.fn(async () => Buffer.from("P1\n1 1\n0")),
  };
});

import { navigate, sleep } from "../browser.js";
import type { RenderObject, RenderParams } from "../renderer.js";
import { writeFile } from "../util/shell.js";
import {
  emptyDefsElement,
  emptyPathElement,
  element,
  flattenToplevelSvgElements,
  foreignObjectElement,
  getGradients,
  groupElement,
  joinColorLayers,
  parseViewBox,
  replaceInternalUris,
  replaceTextNodes,
  render,
  renderUri,
  setPathColor,
  setXmlCodec,
  shapeElement,
  type ColorLayer,
  type TracedNode,
  type XmlNode,
} from "./svg.js";

const FILE = "11111111-1111-1111-1111-111111111111";
const PAGE = "22222222-2222-2222-2222-222222222222";
const OBJECT = "33333333-3333-3333-3333-333333333333";
const TEXT = "text-1";

function leaf(name: string, attributes: Record<string, string> = {}, elements?: XmlNode[]): XmlNode {
  return { type: "element", name, attributes, ...(elements === undefined ? {} : { elements }) };
}

const TRACED_SVG: XmlNode = leaf("svg", { viewBox: "0 0 100 100", width: "100", height: "100" }, [
  leaf("g", {}, [leaf("path", { d: "M9 9L90 90" })]),
]);

const TRACED: XmlNode = {
  type: "document",
  name: "root",
  elements: [{ type: "declaration", name: "xml" }, TRACED_SVG],
};

const PAGE_TREE: XmlNode = leaf("svg", {}, [
  leaf("svg", { viewBox: "0 0 100 100" }, [
    leaf("foreignObject", { id: TEXT }),
    { type: "element", name: "defs" },
    leaf("path", { d: "" }),
    leaf("text", {}, [{ type: "text", text: "hello&nbsp;world" } as unknown as XmlNode]),
    leaf("use", { href: "http://internal:6060/font.woff" }),
  ]),
]);

const ATTRS = {
  id: TEXT,
  x: "0",
  y: "0",
  width: "100",
  height: "100",
  colors: ["#ff0000"],
  mapping: {},
};

type Serializer = (node: XmlNode) => string;

const serialize: Serializer = (node) => {
  if (node.type === "text") return String((node as unknown as { text: string }).text);
  const attributes = Object.entries(node.attributes ?? {})
    .map(([key, value]) => ` ${key}="${value}"`)
    .join("");
  const children = (node.elements ?? []).map(serialize).join("");
  return `<${node.name}${attributes}>${children}</${node.name}>`;
};

let trees: XmlNode[] = [];

beforeEach(() => {
  trees = [];
  fake.configs = [];
  fake.evaluate = (locator) => {
    if (locator.selector === `#screenshot-${OBJECT}`) return "page";
    if (locator.selector === `#screenshot-${OBJECT} foreignObject`) return ATTRS;
    throw new Error(`unexpected evaluate on ${locator.selector}`);
  };
  setXmlCodec({
    xml2js: () => trees.shift() as XmlNode,
    js2xml: serialize,
  });
  vi.clearAllMocks();
});

afterEach(() => {
  setXmlCodec(undefined);
});

function tracedNode(attributes: Partial<TracedNode> = {}): TracedNode {
  return {
    id: "board",
    x: "0",
    y: "0",
    width: "100",
    height: "100",
    colors: [],
    mapping: {},
    ...attributes,
  };
}

function params(overrides: Partial<RenderParams> = {}): RenderParams {
  return {
    "file-id": FILE,
    "page-id": PAGE,
    scale: 1,
    token: "token",
    type: "svg",
    objects: [{ id: OBJECT, name: "board", suffix: "", filename: "board.svg" }],
    ...overrides,
  };
}

describe("predicates", () => {
  it("recognises elements, groups and shapes", () => {
    expect(element(leaf("g"))).toBe(true);
    expect(element({ type: "text", text: "x" })).toBe(false);
    expect(element(null)).toBe(false);

    expect(groupElement(leaf("g"))).toBe(true);
    expect(groupElement(leaf("svg"))).toBe(false);

    expect(shapeElement(leaf("path", { id: "shape-1" }))).toBe(true);
    expect(shapeElement(leaf("path", { id: "board" }))).toBe(false);

    expect(foreignObjectElement(leaf("foreignObject"))).toBe(true);
    expect(foreignObjectElement(leaf("g"))).toBe(false);
  });

  it("drops only the empty defs and paths", () => {
    expect(emptyDefsElement({ type: "element", name: "defs" })).toBe(true);
    expect(emptyDefsElement(leaf("defs", {}, []))).toBe(false);

    expect(emptyPathElement(leaf("path"))).toBe(true);
    expect(emptyPathElement(leaf("path", { d: "  " }))).toBe(true);
    expect(emptyPathElement(leaf("path", { d: "M0 0" }))).toBe(false);
    expect(emptyPathElement(leaf("g", { d: "" }))).toBe(false);
  });
});

describe("flattenToplevelSvgElements", () => {
  it("merges the nested svg into its parent and keeps the siblings", () => {
    const inner = leaf("svg", { viewBox: "0 0 10 10" }, [leaf("path", { d: "M0 0" })]);
    const defs = leaf("defs");
    const tree = leaf("svg", {}, [inner, defs]);

    const flat = flattenToplevelSvgElements(tree);

    expect(flat.elements).toHaveLength(2);
    expect(flat.elements?.[0]).toMatchObject({ name: "svg", elements: [{ name: "path" }] });
    expect(flat.elements?.[1]).toBe(defs);
  });

  it("leaves a single svg untouched", () => {
    const tree = leaf("svg", {}, [leaf("path", { d: "M0 0" })]);

    expect(flattenToplevelSvgElements(tree)).toBe(tree);
  });
});

describe("parseViewBox", () => {
  it("reads width and height out of the four numbers", () => {
    expect(parseViewBox("10 20 300 150")).toEqual({ width: 300, height: 150 });
  });
});

describe("replaceInternalUris", () => {
  it("rewrites the internal uri to the public one", () => {
    expect(replaceInternalUris('<use href="http://internal:6060/font.woff"/>')).toBe(
      '<use href="https://public.example/font.woff"/>',
    );
  });

  it("keeps content without the internal uri", () => {
    expect(replaceInternalUris("<svg></svg>")).toBe("<svg></svg>");
  });
});

describe("setPathColor", () => {
  const path_ = leaf("path", { d: "M0 0" });

  it("uses the layer colour when the mapping has no entry", () => {
    const node = setPathColor("board", "#ff0000", {}, path_);

    expect(node.attributes).toEqual({ d: "M0 0", fill: "#ff0000" });
    expect(path_.attributes).toEqual({ d: "M0 0" });
  });

  it("uses the mapped colour and opacity for a transparent layer", () => {
    const node = setPathColor("board", "#ff0000", {
      "#ff0000": { type: "transparent", hex: "#00ff00", opacity: "0.4" },
    }, path_);

    expect(node.attributes).toMatchObject({ fill: "#00ff00", "fill-opacity": "0.4" });
  });

  it("points a gradient layer at its generated definition", () => {
    const node = setPathColor("board", "#00ff00", {
      "#00ff00": { type: "gradient", gradient: { type: "linear", stops: [] } },
    }, path_);

    expect(node.attributes?.fill).toBe("url(#gradient-board-00ff00)");
  });
});

describe("getGradients", () => {
  it("only materialises the gradient entries", () => {
    const defs = getGradients("board", {
      "#ff0000": { type: "gradient", gradient: { type: "linear", stops: [] } },
      "#00ff00": { type: "transparent", hex: "#00ff00", opacity: "1" },
    });

    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({
      name: "linearGradient",
      attributes: { id: "gradient-board-ff0000" },
    });
  });
});

describe("joinColorLayers", () => {
  const layer = (color: string, elements: XmlNode[]): ColorLayer => ({
    color,
    svgdata: leaf("svg", { viewBox: "0 0 100 100", width: "100", height: "100" }, elements),
  });

  it("merges the single path groups and keeps the multi path ones", () => {
    const merged = joinColorLayers(tracedNode({ x: "10", y: "20", width: "200", height: "100" }), [
      layer("#ff0000", [leaf("g", { id: "one" }, [leaf("path", { d: "M0 0" })])]),
      layer("#00ff00", [leaf("g", {}, [leaf("path", { d: "M1 1" }), leaf("path", { d: "M2 2" })])]),
    ]);

    expect(merged).toMatchObject({ name: "g", attributes: {} });
    expect(merged.elements).toHaveLength(2);

    expect(merged.elements?.[0]).toMatchObject({
      name: "path",
      attributes: {
        d: "M0 0",
        id: "one",
        fill: "#ff0000",
        transform: "translate(10, 20) scale(2, 1) ",
      },
    });
    expect(merged.elements?.[1]).toMatchObject({
      name: "g",
      attributes: { fill: "#00ff00", transform: "translate(10, 20) scale(2, 1) " },
    });
    expect(merged.elements?.[1].elements).toHaveLength(2);
  });

  it("puts the gradient definitions in front of the layers", () => {
    const merged = joinColorLayers(
      tracedNode({
        mapping: {
          "#ff0000": { type: "gradient", gradient: { type: "linear", stops: [] } },
        },
      }),
      [layer("#ff0000", [leaf("g", {}, [leaf("path", { d: "M0 0" })])])],
    );

    expect(merged.elements?.[0]).toMatchObject({ name: "defs" });
    expect(merged.elements?.[0].elements?.[0]).toMatchObject({ name: "linearGradient" });
    expect(merged.elements?.[1].attributes?.fill).toBe("url(#gradient-board-ff0000)");
  });
});

describe("replaceTextNodes", () => {
  it("swaps the foreignObject for the traced paths and drops the leftovers", () => {
    trees = [PAGE_TREE];

    const result = replaceTextNodes("page", {
      [TEXT]: tracedNode({ id: TEXT, svgdata: leaf("path", { d: "M9 9" }) }),
    });

    expect(result).not.toContain("foreignObject");
    expect(result).toContain('d="M9 9"');
    expect(result).not.toContain("<defs");
    expect(result).not.toContain('d=""');
    expect(result).toContain("hello&nbsp;world");
  });

  it("keeps a foreignObject without a traced node", () => {
    trees = [PAGE_TREE];

    const result = replaceTextNodes("page", {});

    expect(result).toContain("<foreignObject");
  });
});

describe("renderUri", () => {
  it("asks the page for the embed of every object", () => {
    const uri = renderUri(params());

    expect(`${uri.origin}${uri.pathname}`).toBe("http://internal:6060/render.html");
    expect(uri.searchParams.get("render-embed")).toBe("true");
    expect(uri.searchParams.get("route")).toBe("objects");
    expect(uri.searchParams.getAll("object-id")).toEqual([OBJECT]);
  });
});

describe("render", () => {
  it("traces the text, recolours the paths and writes the svg", async () => {
    trees = [TRACED, PAGE_TREE];
    const rendered: RenderObject[] = [];

    await render(params(), (object) => {
      rendered.push(object);
    });

    expect(fake.configs[0]).toMatchObject({
      deviceScaleFactor: 1,
      locale: "en-US",
      storageState: {
        cookies: [{ domain: "internal:6060", name: "auth-token", value: "token" }],
      },
    });
    expect(vi.mocked(navigate)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sleep)).toHaveBeenCalledWith(fake.page, 1000);

    const [, content] = vi.mocked(writeFile).mock.calls.at(-1) as [string, string];
    expect(content).not.toContain("foreignObject");
    expect(content).not.toContain("&nbsp;");
    expect(content).toContain("&#160;");
    expect(content).toContain("https://public.example/font.woff");
    expect(content).toContain('d="M9 9L90 90"');

    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({
      id: OBJECT,
      filename: "board.svg",
      path: "penpot.tmp.render.svg.test.svg",
    });
  });
});
