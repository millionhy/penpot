// app.renderer.svg: svg exports.
//
// The page draws each object twice: a DOM tree that carries the real text, and
// a per-colour raster that gets vectorised with potrace. This module stitches
// the two: every `foreignObject` is replaced by its traced raster, each traced
// layer is recoloured from the shape dataset (plain colour or gradient), and
// the result is written next to the other render products.
//
// xml-js and svgo are loaded lazily; the tests drive the tree helpers through
// an injected codec (see `setXmlCodec`).

import * as browser from "../browser.js";
import { get, getConfig, getInternalUri } from "../config.js";
import { load } from "../deps.js";
import { raise } from "../errors.js";
import { createLogger, setLevel } from "../logging.js";
import type { RenderObject, RenderParams } from "../renderer.js";
import { ensurePathSlash, join, mapToQueryString, withQuery } from "../uri.js";
import { getExtension } from "../util/mime.js";
import { readFile, runCmd, tempfile, writeFile } from "../util/shell.js";
import { dataToGradientDef, type XmlNode } from "./svg-gradient.js";

const log = createLogger("app.renderer.svg");
setLevel("app.renderer.svg", "trace");

export type { XmlNode };

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

interface ColorMapping {
  type: "transparent" | "gradient";
  hex?: string;
  opacity?: string;
  gradient?: { type: string; stops: Array<{ offset: string | number; color: string; opacity: string | number }> };
}

export interface TracedNode {
  id: string;
  x: string;
  y: string;
  width: string;
  height: string;
  colors: string[];
  mapping: Record<string, ColorMapping>;
  data?: Uint8Array;
  svgdata?: XmlNode;
}

export interface ColorLayer {
  color: string;
  svgdata: XmlNode;
}

// --- XML CODEC

export interface XmlCodec {
  xml2js(xml: string): XmlNode;
  js2xml(data: XmlNode): string;
}

let codec: XmlCodec | undefined;

// xml-js is a plain module: the tree helpers only need these two calls, so the
// tests can supply a small codec of their own.
export function setXmlCodec(next: XmlCodec | undefined): void {
  codec = next;
}

function xmlCodec(): XmlCodec {
  if (codec === undefined) codec = load<XmlCodec>("xml-js");
  return codec;
}

export function xmlToObject(data: string): XmlNode {
  return xmlCodec().xml2js(data);
}

export function objectToXml(data: XmlNode): string {
  return xmlCodec().js2xml(data);
}

// --- TREE HELPERS

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function element(item: unknown): item is XmlNode {
  return isMap(item) && item.type === "element";
}

export function groupElement(item: unknown): boolean {
  return element(item) && item.name === "g";
}

export function shapeElement(item: unknown): boolean {
  return element(item) && String(item.attributes?.id ?? "").startsWith("shape-");
}

export function foreignObjectElement(item: unknown): boolean {
  return element(item) && item.name === "foreignObject";
}

export function emptyDefsElement(item: unknown): boolean {
  return isMap(item) && item.name === "defs" && item.attributes == null && item.elements == null;
}

export function emptyPathElement(item: unknown): boolean {
  if (!isMap(item) || item.name !== "path") return false;
  const attributes = item.attributes as Record<string, string> | undefined;
  const d = attributes?.d;
  return d === undefined || d === null || d.trim() === "";
}

// Flattens XML data structure if two nested top-side SVG elements found.
export function flattenToplevelSvgElements(item: XmlNode): XmlNode {
  const first = item.elements?.[0];
  const inner = first?.elements?.[0];
  if (first?.name === "svg" && inner?.name === "svg") {
    return {
      ...item,
      elements: [{ ...first, elements: inner.elements }, ...(item.elements ?? []).slice(1)],
    };
  }
  return item;
}

function prewalk(item: XmlNode, f: (node: XmlNode) => XmlNode): XmlNode {
  const next = f(item);
  if (next.elements === undefined) return next;
  return { ...next, elements: next.elements.map((child) => prewalk(child, f)) };
}

// Replaces the foreignObject elements of the provided XML with the previously
// rasterised paths, and drops the empty defs/path nodes the page leaves behind.
export function replaceTextNodes(xmldata: string, nodes: Record<string, TracedNode>): string {
  const xform = (elements: XmlNode[]): XmlNode[] =>
    elements
      .filter((item) => !emptyDefsElement(item) && !emptyPathElement(item))
      .map((item) => {
        if (!foreignObjectElement(item)) return item;
        const node = nodes[String(item.attributes?.id ?? "")];
        return node?.svgdata ?? item;
      });

  const walk = (item: XmlNode): XmlNode => {
    if (!element(item)) return item;
    if (item.elements === undefined) return item;
    return { ...item, elements: xform(item.elements) };
  };

  const parsed = xmlToObject(xmldata);
  return objectToXml(prewalk(flattenToplevelSvgElements(parsed), walk));
}

export function parseViewBox(data: string): { width: number; height: number } {
  const values = data.split(/\s+/).slice(2).map((value) => Number.parseFloat(value));
  return { width: values[0], height: values[1] };
}

// Replaces internal-uri references with public-uri in SVG output, so font URLs
// and other resource references in the exported SVG point at a URI that end
// users can reach.
export function replaceInternalUris(svgContent: string): string {
  const internalUri = String(getInternalUri());
  const publicUri = String(get("public-uri"));

  if (internalUri !== publicUri && svgContent.includes(internalUri)) {
    return svgContent.split(internalUri).join(publicUri);
  }
  return svgContent;
}

export function setPathColor(
  id: string,
  color: string,
  mapping: Record<string, ColorMapping>,
  node: XmlNode,
): XmlNode {
  const colorMapping = mapping[color];
  const attributes = { ...(node.attributes ?? {}) };

  if (colorMapping !== undefined && colorMapping.type === "transparent") {
    attributes.fill = String(colorMapping.hex);
    attributes["fill-opacity"] = String(colorMapping.opacity);
  } else if (colorMapping !== undefined && colorMapping.type === "gradient") {
    attributes.fill = `url(#gradient-${id}-${color.slice(1)})`;
  } else {
    attributes.fill = color;
  }

  return { ...node, attributes };
}

export function getGradients(id: string, mapping: Record<string, ColorMapping>): XmlNode[] {
  return Object.entries(mapping)
    .filter(([, data]) => data.type === "gradient")
    .map(([color, data]) => dataToGradientDef(id, [color, data as never]));
}

export function joinColorLayers(
  node: TracedNode,
  layers: ColorLayer[],
): XmlNode {
  let result: XmlNode = { ...(layers[0].svgdata as XmlNode), elements: [] };

  for (const layer of layers) {
    const groups = (layer.svgdata.elements ?? [])
      .filter((item) => item.name === "g")
      .map((group) => setPathColor(node.id, layer.color, node.mapping, group));
    result = { ...result, elements: [...(result.elements ?? []), ...groups] };
  }

  const vbox = parseViewBox(String(result.attributes?.viewBox ?? ""));
  const transform = `translate(${node.x}, ${node.y}) scale(${Number(node.width) / vbox.width}, ${
    Number(node.height) / vbox.height
  })`;

  const gradientDefs = getGradients(node.id, node.mapping);

  const elements = (result.elements ?? []).map((group) => {
    const paths = group.elements ?? [];
    if (paths.length === 1) {
      const path = paths[0];
      return {
        ...path,
        attributes: {
          ...(path.attributes ?? {}),
          ...(group.attributes ?? {}),
          transform: `${transform} ${path.attributes?.transform ?? ""}`,
        },
      };
    }

    return {
      ...group,
      attributes: {
        ...(group.attributes ?? {}),
        transform: `${transform} ${group.attributes?.transform ?? ""}`,
      },
    };
  });

  const withDefs: XmlNode[] =
    gradientDefs.length > 0
      ? [{ type: "element", name: "defs", attributes: {}, elements: gradientDefs }, ...elements]
      : elements;

  return { ...result, name: "g", attributes: {}, elements: withDefs };
}

// --- RASTER PIPELINE

function convertToPpm(pngPath: string): Promise<string> {
  const ppmPath = `${pngPath}origin.ppm`;
  log.trace({ fn: "convert-to-ppm", path: ppmPath });
  return runCmd("convert", [pngPath, ppmPath]).then(() => ppmPath);
}

function traceColorMask(pbmPath: string): Promise<string> {
  log.trace({ fn: "trace-color-mask", "pbm-path": pbmPath });
  const svgPath = `${pbmPath}.svg`;
  return runCmd("potrace", ["--flat", "-b", "svg", pbmPath, "-o", svgPath]).then(() => svgPath);
}

async function generateColorLayer(ppmPath: string, color: string): Promise<ColorLayer> {
  if (!HEX_COLOR.test(color)) {
    raise({
      type: "validation",
      code: "invalid-color",
      hint: `invalid hex color: ${color}`,
    });
  }

  log.trace({ fn: "generate-color-layer", "ppm-path": ppmPath, color });
  const pbmPath = `${ppmPath}.mask-${color.slice(1)}.pbm`;
  const stdout = await runCmd("ppmcolormask", [color, ppmPath]);
  await writeFile(pbmPath, stdout);
  const svgPath = await traceColorMask(pbmPath);

  const data = await readFile(svgPath);
  const parsed = xmlToObject(data.toString());
  const svgdata = parsed.elements?.[1] as XmlNode;

  return { color, svgdata };
}

async function convertToSvg(ppmPath: string, node: TracedNode): Promise<XmlNode> {
  log.trace({ fn: "convert-to-svg", "ppm-path": ppmPath, colors: node.colors });
  const layers = await Promise.all(node.colors.map((color) => generateColorLayer(ppmPath, color)));
  return joinColorLayers(node, layers);
}

async function traceNode(node: TracedNode): Promise<TracedNode> {
  log.trace({ fn: "trace-node" });
  const pngPath = tempfile({ prefix: "penpot.tmp.render.svg.parse.", suffix: ".origin.png" });
  await writeFile(pngPath, node.data as Uint8Array);
  const ppmPath = await convertToPpm(pngPath);
  const svgdata = await convertToSvg(ppmPath, node);

  const { data: _data, ...rest } = node;
  return { ...rest, svgdata };
}

// --- PAGE EXTRACTION

// Runs in the page: only browser primitives, and the node as first argument.
const EXTRACT_ELEMENT_ATTRS = `(element) => {
  var attrs = element.attributes;
  return {
    id: attrs.id.value,
    x: attrs.x.value,
    y: attrs.y.value,
    width: attrs.width.value,
    height: attrs.height.value,
    colors: element.dataset.colors.split(","),
    mapping: JSON.parse(element.dataset.mapping)
  };
}`;

const EXTRACT_OUTER_HTML = "(element) => element.outerHTML";

interface ElementAttrs {
  id: string;
  x: string;
  y: string;
  width: string;
  height: string;
  colors: string[];
  mapping: Record<string, ColorMapping>;
}

function extractSingleNode([shot, attrs]: [Uint8Array, ElementAttrs]): TracedNode {
  log.trace({ fn: "extract-single-node" });
  return {
    id: attrs.id,
    x: attrs.x,
    y: attrs.y,
    width: attrs.width,
    height: attrs.height,
    colors: Array.from(attrs.colors),
    mapping: attrs.mapping,
    data: shot,
  };
}

async function resolveTextNode(
  page: browser.PageLike,
  node: browser.LocatorLike,
): Promise<[Uint8Array, ElementAttrs]> {
  const attrs = await browser.evaluate<ElementAttrs>(node, EXTRACT_ELEMENT_ATTRS);
  const textNode = browser.select(page, `#screenshot-text-${attrs.id} foreignObject`);
  const shot = await browser.screenshot(textNode, { omitBackground: true, type: "png" });
  return [shot, attrs];
}

async function extractTxtNode(page: browser.PageLike, item: browser.LocatorLike): Promise<TracedNode> {
  return traceNode(extractSingleNode(await resolveTextNode(page, item)));
}

async function extractTxtNodes(
  page: browser.PageLike,
  object: RenderObject,
): Promise<Record<string, TracedNode>> {
  log.trace({ fn: "process-text-nodes" });
  const nodes = await browser.selectAll(page, `#screenshot-${object.id} foreignObject`);
  const traced = await Promise.all(nodes.map((node) => extractTxtNode(page, node)));

  const indexed: Record<string, TracedNode> = {};
  for (const node of traced) indexed[node.id] = node;
  return indexed;
}

async function extractSvg(page: browser.PageLike, object: RenderObject): Promise<string> {
  const node = browser.select(page, `#screenshot-${object.id}`);
  await browser.waitFor(node);
  return browser.evaluate<string>(node, EXTRACT_OUTER_HTML);
}

// --- RENDER

export function prepareOptions(uri: URL, scale: number, token: string | undefined): unknown {
  return {
    screen: { width: browser.defaultViewportWidth, height: browser.defaultViewportHeight },
    viewport: { width: browser.defaultViewportWidth, height: browser.defaultViewportHeight },
    locale: "en-US",
    storageState: { cookies: browser.createCookies(uri, { token }) },
    deviceScaleFactor: scale,
    userAgent: browser.defaultUserAgent,
  };
}

export function renderUri(params: RenderParams): URL {
  const query = mapToQueryString({
    "file-id": params["file-id"],
    "page-id": params["page-id"],
    "share-id": params["share-id"],
    "render-embed": true,
    "object-id": params.objects.map((object) => object.id),
    route: "objects",
  });

  return withQuery(join(ensurePathSlash(getInternalUri()), "render.html"), query);
}

function optimizeSvg(svg: string): string {
  if (!getConfig().flags.has("exporter-svgo")) return svg;
  const svgo = load<{ optimize(input: string, config: unknown): string; defaultOptions: unknown }>(
    "@penpot/svgo",
  );
  return svgo.optimize(svg, svgo.defaultOptions);
}

async function renderObject(
  page: browser.PageLike,
  onObject: (object: RenderObject) => void,
  object: RenderObject,
): Promise<void> {
  const path = tempfile({ prefix: "penpot.tmp.render.svg.", suffix: getExtension("svg") });
  const node = browser.select(page, `#screenshot-${object.id}`);
  await browser.waitFor(node);

  const xmldata = await extractSvg(page, object);
  const txtdata = await extractTxtNodes(page, object);

  let result = replaceTextNodes(xmldata, txtdata);

  // The SVG standard does not allow the entity nbsp; &#160; is equivalent but
  // compatible with SVG.
  result = result.split("&nbsp;").join("&#160;");
  result = optimizeSvg(result);
  result = replaceInternalUris(result);

  await writeFile(path, result);
  onObject({ ...object, path });
}

export async function render(params: RenderParams, onObject: (object: RenderObject) => void): Promise<void> {
  const uri = renderUri(params);

  return browser.exec(prepareOptions(uri, params.scale, params.token), async (page) => {
    log.info({ uri: uri.toString() });

    await browser.navigate(page, uri);
    await browser.sleep(page, 1000); // the good old fix with sleep
    await browser.waitForFonts(page);

    for (const object of params.objects) {
      await renderObject(page, onObject, object);
    }
  });
}