// Inspect panel model (D23). Headless port of the data side of
// app.main.ui.inspect.{left-sidebar,right-sidebar,attributes,attributes.*}:
// the layer tree rows, the selection helpers and the computed-panel sections
// (geometry / visibility / fill / stroke / shadow / blur / layout /
// layout-element / svg / text / variant).
//
// Kept free of JSX so it runs in vitest's node environment. The components in
// components/viewer-inspect.tsx render this model.
//
// Deviations from the CLJS original, documented:
// - The stroke and fill copy rows pass the stroke / fill map to the CSS
//   engine; the CLJS passes the parent shape, whose stroke-* keys are empty,
//   so the copied rule came out blank.
// - typography-ref rows are folded into the font rows: the shell has no
//   typography catalog to resolve the ref name against (the file bundle
//   carries no typographies list). The font id resolves through the bundle
//   fonts callback.
// - The variant container reads the variant-properties of the components of
//   its children (cfv/extract-properties-values); a component reads its own
//   variant-properties, blank values shown as "--".
// - The layer tree hides the toggle of the frame row (hide-toggle), like the
//   CLJS left-sidebar, and starts the frame at depth 0 (the CLJS starts at
//   -1 through layer-item-inner).

import { tr } from "@/lib/i18n";
import {
  colorSwatch,
  cssProperty,
  cssValue,
  formatBlur,
  formatColorValue,
  formatNumber,
  formatPixels,
  getCssValue,
  humanizeCssRule,
  shadowRule,
  shapePropertiesCss,
  strokeColor,
  strokePerSideWidths,
  fillColor,
  type CssShape,
  type InspectColor,
  type InspectColorFormat,
} from "@/lib/inspect-css";
import { ZERO_UUID, type ViewerObjects, type ViewerShape } from "@/lib/viewer";
import { joinRects, makeRect } from "@/lib/common/geom/rect";

// --- Shapes -----------------------------------------------------------------

export function shapeName(shape: ViewerShape | null | undefined): string {
  return shape?.name ?? "";
}

function parentOf(objects: ViewerObjects, shape: ViewerShape): ViewerShape | null {
  const parentId = shape["parent-id"];
  return typeof parentId === "string" ? objects[parentId] ?? null : null;
}

export function isRootFrame(shape: ViewerShape): boolean {
  return shape.type === "frame" && shape["frame-id"] === ZERO_UUID && shape.id !== ZERO_UUID;
}

export function isAnyLayout(shape: ViewerShape | null | undefined): boolean {
  return (
    shape !== null &&
    shape !== undefined &&
    shape.type === "frame" &&
    (shape.layout === "flex" || shape.layout === "grid")
  );
}

export function isLayoutChild(objects: ViewerObjects, shape: ViewerShape): boolean {
  return isAnyLayout(parentOf(objects, shape));
}

export function isFlexChild(objects: ViewerObjects, shape: ViewerShape): boolean {
  const parent = parentOf(objects, shape);
  return parent !== null && parent.layout === "flex" && parent.type === "frame";
}

export function isGridChild(objects: ViewerObjects, shape: ViewerShape): boolean {
  const parent = parentOf(objects, shape);
  return parent !== null && parent.layout === "grid" && parent.type === "frame";
}

export function isTextShape(shape: ViewerShape): boolean {
  return shape.type === "text";
}

// ctc/is-variant-container?.
export function isVariantContainer(shape: ViewerShape | null | undefined): boolean {
  return shape !== null && shape !== undefined && shape["is-variant-container"] === true;
}

// ctc/is-variant?: a component variant carries the variant id.
export function isVariant(shape: ViewerShape | null | undefined): boolean {
  return shape !== null && shape !== undefined && typeof shape["variant-id"] === "string";
}

// ctc/main-instance?.
export function isMainInstance(shape: ViewerShape | null | undefined): boolean {
  return shape !== null && shape !== undefined && shape["main-instance"] === true;
}

// ctc/instance-head?: an instance of a component.
export function isInstanceHead(shape: ViewerShape | null | undefined): boolean {
  return shape !== null && shape !== undefined && typeof shape["component-id"] === "string";
}

// ctk/instance-root?: the root shape of a component main instance.
export function isInstanceRoot(shape: ViewerShape | null | undefined): boolean {
  return shape !== null && shape !== undefined && shape["component-root"] === true;
}

function hasImages(shape: ViewerShape): boolean {
  return Array.isArray(shape.fills) && shape.fills.some((fill) => {
    return fill !== null && typeof fill === "object" && (fill as Record<string, unknown>)["fill-image"] !== undefined;
  });
}

// app.util.shape-icon/get-shape-icon, reduced to the icon set of the shell.
export type InspectShapeIcon =
  | "board"
  | "group"
  | "mask"
  | "rect"
  | "ellipse"
  | "line"
  | "text"
  | "image"
  | "path"
  | "curve"
  | "component"
  | "component-copy"
  | "variant";

export function inspectShapeIcon(shape: ViewerShape, component?: unknown): InspectShapeIcon {
  if (isInstanceHead(shape)) {
    if (isMainInstance(shape)) return isVariant(shape) ? "variant" : "component";
    return "component-copy";
  }
  if (isVariantContainer(shape) || (component !== undefined && isVariant(component as ViewerShape))) {
    return "component";
  }
  switch (shape.type) {
    case "frame": {
      if (shape["is-variant-container"] === true) return "component";
      if (shape.layout === "flex") {
        return shape["layout-flex-dir"] === "column" ? "board" : "board";
      }
      return "board";
    }
    case "image":
    case "svg-raw":
      return "image";
    case "line":
      return hasImages(shape) ? "image" : "rect";
    case "circle":
      return "ellipse";
    case "path":
    case "bool":
      return "path";
    case "rect":
      return "rect";
    case "text":
      return "text";
    case "group":
      return shape["masked-group"] === true ? "mask" : "group";
    default:
      return "path";
  }
}

// right-sidebar subtitle: main / variant / copy.
export function inspectSubtitle(shape: ViewerShape | null | undefined): string | null {
  if (shape === null || shape === undefined) return null;
  const main = isMainInstance(shape);
  if (isVariantContainer(shape) || (main && !isVariant(shape))) return tr("inspect.subtitle.main");
  if (isVariant(shape) && main) return tr("labels.variant");
  if (isInstanceHead(shape)) return tr("inspect.subtitle.copy");
  return null;
}

// --- Layer tree -------------------------------------------------------------

export interface InspectTreeRow {
  shape: ViewerShape;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

// The frame subtree in the order the left sidebar paints it: the children
// reversed (the last shape of the objects list paints first).
export function inspectTreeRows(
  frame: ViewerShape,
  objects: ViewerObjects,
  collapsed: ReadonlySet<string>,
): InspectTreeRow[] {
  const rows: InspectTreeRow[] = [];

  const visit = (shape: ViewerShape, depth: number): void => {
    const children = (shape.shapes ?? [])
      .map((id) => objects[id])
      .filter((child): child is ViewerShape => child !== undefined && child !== null)
      .reverse();
    const expanded = !collapsed.has(shape.id);
    rows.push({ shape, depth, hasChildren: children.length > 0, expanded });
    if (!expanded) return;
    for (const child of children) visit(child, depth + 1);
  };

  visit(frame, 0);
  return rows;
}

// The ids of the rows the tree shows, in paint order: the shift range of the
// layer list walks this list.
export function inspectTreeIds(
  frame: ViewerShape,
  objects: ViewerObjects,
  collapsed: ReadonlySet<string>,
): string[] {
  return inspectTreeRows(frame, objects, collapsed).map((row) => row.shape.id);
}

// dv/select-all: the frame and every shape of the page that belongs to it
// (the `:frame-id` of a shape names its top-level frame, so the scan covers
// every descendant).
export function allShapeIds(frame: ViewerShape, objects: ViewerObjects): string[] {
  const ids: string[] = [frame.id];
  for (const shape of Object.values(objects)) {
    if (shape !== null && shape !== undefined && shape["frame-id"] === frame.id) {
      ids.push(shape.id);
    }
  }
  return ids;
}

// dv/shift-select-to (expand-region-selection): from the last selected shape
// of the tree order to the picked one.
export function expandRegionSelection(
  order: readonly string[],
  selected: ReadonlySet<string>,
  targetId: string,
): string[] {
  const target = order.indexOf(targetId);
  if (target === -1) return [targetId];
  let anchor = -1;
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const id = order[index];
    if (selected.has(id)) {
      anchor = index;
      break;
    }
  }
  if (anchor === -1) return [targetId];
  const start = Math.min(anchor, target);
  const end = Math.max(anchor, target);
  return order.slice(start, end + 1);
}

// --- Selection --------------------------------------------------------------

export function resolveShapes(
  objects: ViewerObjects,
  selected: ReadonlySet<string>,
): ViewerShape[] {
  const shapes: ViewerShape[] = [];
  for (const id of selected) {
    const shape = objects[id];
    if (shape !== undefined && shape !== null) shapes.push(shape);
  }
  return shapes;
}

export interface InspectRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The axis-aligned box around the selection (selection-feedback).
export function unionSelrect(shapes: readonly ViewerShape[]): InspectRect | null {
  const rects = shapes.flatMap((shape) => (shape.selrect === undefined ? [] : [makeRect(shape.selrect)]));
  const joined = joinRects(rects);
  if (joined === undefined) return null;
  return { x: joined.x, y: joined.y, width: joined.width, height: joined.height };
}

// --- Text -------------------------------------------------------------------

export interface TextBlock {
  style: Record<string, unknown>;
  text: string;
}

const TEXT_ALL_ATTRS = [
  "grow-type",
  "vertical-align",
  "text-align",
  "text-direction",
  "typography-ref-id",
  "typography-ref-file",
  "font-id",
  "font-family",
  "font-variant-id",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-decoration",
  "text-transform",
  "fills",
] as const;

const DEFAULT_TEXT_ATTRS: Record<string, unknown> = {
  "typography-ref-file": null,
  "typography-ref-id": null,
  "font-id": "sourcesanspro",
  "font-family": "sourcesanspro",
  "font-variant-id": "regular",
  "font-size": "14",
  "font-weight": "400",
  "font-style": "normal",
  "line-height": "1.2",
  "letter-spacing": "0",
  "text-transform": "none",
  "text-align": "left",
  "text-decoration": "none",
  "text-direction": "ltr",
  fills: [{ "fill-color": "#000000", "fill-opacity": 1 }],
};

function isTextNode(node: Record<string, unknown>): boolean {
  return typeof node.text === "string";
}

function pickTextAttrs(node: Record<string, unknown>): Record<string, unknown> {
  const style: Record<string, unknown> = {};
  for (const key of TEXT_ALL_ATTRS) {
    if (node[key] !== undefined) style[key] = node[key];
  }
  return style;
}

// txt/content->text+styles: one entry per run of equal styles, paragraph
// breaks appended as newlines.
export function contentToTextBlocks(content: unknown): TextBlock[] {
  if (content === null || content === undefined || typeof content !== "object") return [];
  const root = content as Record<string, unknown>;

  type Entry = [Record<string, unknown>, string];
  let acc: Entry[] = [];

  const rec = (node: Record<string, unknown>, style: Record<string, unknown>): void => {
    const nodeStyle = { ...style, ...pickTextAttrs(node) };
    const head = acc[0] ?? [{}, ""];
    const [headStyle, headText] = head;

    if (!isTextNode(node)) {
      const children = Array.isArray(node.children) ? node.children : [];
      for (const child of children) {
        if (child !== null && typeof child === "object") {
          rec(child as Record<string, unknown>, nodeStyle);
        }
      }
    } else if (headStyle !== nodeStyle) {
      acc = [[nodeStyle, typeof node.text === "string" ? node.text : ""], ...acc];
    } else {
      acc = [[nodeStyle, headText + (typeof node.text === "string" ? node.text : "")], ...acc.slice(1)];
    }

    if (node.type === "paragraph" && acc.length > 0) {
      const [style2, text2] = acc[0];
      acc = [[style2, text2 + "\n"], ...acc.slice(1)];
    }
  };

  rec(root, {});
  return acc
    .reverse()
    .map(([style, text]) => ({ style: { ...DEFAULT_TEXT_ATTRS, ...style }, text }))
    .filter((block) => block.text.trim() !== "");
}

function textStyleValue(style: Record<string, unknown>, key: string): string | null {
  const value = style[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

// copy-style-data: "property: value;" lines.
function copyStyleData(style: Record<string, unknown>, properties: readonly string[]): string {
  return properties
    .map((property) => {
      const value = style[property];
      if (value === null || value === undefined) return null;
      return property + ": " + String(value) + ";";
    })
    .filter((line): line is string => line !== null)
    .join("\n");
}

// --- Variants ---------------------------------------------------------------

interface VariantProperty {
  name: string;
  value: unknown;
}

function readVariantProperties(component: unknown): VariantProperty[] {
  if (component === null || component === undefined || typeof component !== "object") return [];
  const value = (component as Record<string, unknown>)["variant-properties"];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
    .map((entry) => ({
      name: typeof entry.name === "string" ? entry.name : "",
      value: entry.value,
    }));
}

// cfv/extract-properties-values: the values of the components of the
// container's children, distinct and joined with ", ".
function extractVariantProperties(
  container: ViewerShape,
  objects: ViewerObjects,
  components: Record<string, unknown>,
): { name: string; value: string }[] {
  const childIds = container.shapes ?? [];
  const properties: VariantProperty[] = [];
  for (const childId of childIds) {
    const child = objects[childId];
    const componentId = child?.["component-id"];
    if (typeof componentId !== "string") continue;
    const component = components[componentId];
    properties.push(...readVariantProperties(component));
  }
  const grouped = new Map<string, unknown[]>();
  for (const property of properties) {
    const values = grouped.get(property.name) ?? [];
    if (!values.includes(property.value)) values.push(property.value);
    grouped.set(property.name, values);
  }
  return [...grouped.entries()].map(([name, values]) => ({
    name,
    value: values.map((value) => String(value ?? "")).join(", "),
  }));
}

// --- Sections ---------------------------------------------------------------

export type InspectSectionId =
  | "geometry"
  | "visibility"
  | "fill"
  | "stroke"
  | "shadow"
  | "blur"
  | "layout"
  | "layout-element"
  | "svg"
  | "text"
  | "variant";

export type InspectRowKind =
  | "property"
  | "color"
  | "shadow"
  | "blur"
  | "variant"
  | "text"
  | "subtitle";

export interface InspectRow {
  key: string;
  kind: InspectRowKind;
  label: string;
  value?: string | null;
  copy?: string | null;
  swatch?: string | null;
  hint?: string | null;
  // The text row renders the run with its own font style.
  textStyle?: { fontFamily?: string; fontWeight?: string; fontStyle?: string };
}

export interface InspectSection {
  id: InspectSectionId;
  title: string;
  copy?: string | null;
  rows: InspectRow[];
}

export interface InspectBuildContext {
  objects: ViewerObjects;
  components?: Record<string, unknown>;
  colorFormat: InspectColorFormat;
  publicUri: string;
  shareId: string | null;
  fontName?: (fontId: string) => string | undefined;
  rootShapes?: ReadonlySet<string>;
}

const GEOMETRY_PROPERTIES = [
  "width",
  "height",
  "left",
  "top",
  "border-radius",
  "border-block-start-width",
  "border-inline-end-width",
  "border-block-end-width",
  "border-inline-start-width",
  "transform",
] as const;

const VISIBILITY_PROPERTIES = ["opacity", "blend-mode", "visibility"] as const;

const LAYOUT_PROPERTIES = [
  "display",
  "flex-direction",
  "flex-wrap",
  "grid-template-rows",
  "grid-template-columns",
  "align-items",
  "align-content",
  "justify-items",
  "justify-content",
  "row-gap",
  "column-gap",
  "gap",
  "padding-inline-start",
  "padding-inline-end",
  "padding-block-start",
  "padding-block-end",
] as const;

const LAYOUT_ELEMENT_PROPERTIES = [
  "margin",
  "max-height",
  "min-height",
  "max-width",
  "min-width",
  "align-self",
  "justify-self",
  "flex-shrink",
  "flex",
  "grid-column",
  "grid-row",
] as const;

const FILL_PROPERTIES = ["background", "background-color", "background-image"] as const;

const STROKE_PROPERTIES = ["border-style", "border-width"] as const;
const STROKE_PER_SIDE_PROPERTIES = [
  "border-style",
  "border-block-start-width",
  "border-inline-end-width",
  "border-block-end-width",
  "border-inline-start-width",
] as const;

function cssOptions(context: InspectBuildContext) {
  return {
    format: context.colorFormat,
    publicUri: context.publicUri,
    shareId: context.shareId,
    rootShapes: context.rootShapes,
  };
}

// The inspect type of the selection (type->options in attributes.cljs).
export function inspectSelectionType(
  shapes: readonly ViewerShape[],
  components: Record<string, unknown> = {},
): string {
  if (shapes.length !== 1) return "multiple";
  const shape = shapes[0];
  const component =
    typeof shape["component-id"] === "string" ? components[shape["component-id"]] : undefined;
  if (isVariantContainer(shape) || (component !== undefined && isVariant(component as ViewerShape))) {
    return "variant";
  }
  return shape.type;
}

function propertyRows(
  shapes: readonly ViewerShape[],
  objects: ViewerObjects,
  properties: readonly string[],
  options: ReturnType<typeof cssOptions>,
  keyPrefix: string,
): InspectRow[] {
  const rows: InspectRow[] = [];
  for (const [shapeIndex, shape] of shapes.entries()) {
    for (const property of properties) {
      const value = cssValue(property, shape, objects, options);
      if (value === null) continue;
      rows.push({
        key: keyPrefix + "-" + shapeIndex + "-" + property,
        kind: "property",
        label: humanizeCssRule(property),
        value,
        copy: cssProperty(property, shape, objects, options),
      });
    }
  }
  return rows;
}

function colorRow(
  color: InspectColor,
  options: ReturnType<typeof cssOptions>,
  copy: string,
  keyPrefix: string,
  label: string,
): InspectRow {
  const format = options.format ?? "hex";
  const opacity = color.opacity ?? 1;
  const value =
    format === "hex"
      ? (color.color ?? "").toUpperCase()
      : formatColorValue(color, { format });
  return {
    key: keyPrefix,
    kind: "color",
    label,
    value,
    hint: format === "hex" ? formatNumber(opacity * 100) + "%" : null,
    swatch: colorSwatch(color, format),
    copy,
  };
}

function hasFill(shape: ViewerShape): boolean {
  if (shape.type === "text" || shape.type === "group") return false;
  if (typeof shape["fill-color"] === "string") return true;
  if (shape["fill-color-gradient"] !== undefined) return true;
  return Array.isArray(shape.fills) && shape.fills.length > 0;
}

function fillSection(
  shapes: readonly ViewerShape[],
  objects: ViewerObjects,
  context: InspectBuildContext,
): InspectSection | null {
  const candidates = shapes.filter(hasFill);
  if (candidates.length === 0) return null;
  const options = cssOptions(context);
  const rows: InspectRow[] = [];
  for (const [shapeIndex, shape] of candidates.entries()) {
    const fills = Array.isArray(shape.fills) && shape.fills.length > 0 ? shape.fills : [shape];
    for (const [fillIndex, fill] of fills.entries()) {
      const fillShape = fill as CssShape;
      const color = fillColor(fillShape);
      const copy = shapePropertiesCss(
        { fills: [fill] },
        objects,
        FILL_PROPERTIES,
        options,
      );
      rows.push(
        colorRow(
          color,
          options,
          copy,
          "fill-" + shapeIndex + "-" + fillIndex,
          "Background",
        ),
      );
    }
  }
  return { id: "fill", title: tr("inspect.attributes.fill"), rows };
}

function strokeSection(
  shapes: readonly ViewerShape[],
  objects: ViewerObjects,
  context: InspectBuildContext,
): InspectSection | null {
  const options = cssOptions(context);
  const rows: InspectRow[] = [];
  for (const [shapeIndex, shape] of shapes.entries()) {
    const strokes = Array.isArray(shape.strokes) ? shape.strokes : [];
    for (const [strokeIndex, stroke] of strokes.entries()) {
      if (stroke === null || typeof stroke !== "object") continue;
      const strokeMap = stroke as Record<string, unknown>;
      const properties =
        strokePerSideWidths(strokeMap) !== null ? STROKE_PER_SIDE_PROPERTIES : STROKE_PROPERTIES;
      for (const property of properties) {
        const value = cssValue(property, strokeMap, objects, options);
        if (value === null) continue;
        rows.push({
          key: "stroke-" + shapeIndex + "-" + strokeIndex + "-" + property,
          kind: "property",
          label: humanizeCssRule(property),
          value,
          copy: cssProperty(property, strokeMap, objects, options),
        });
      }
      const color = strokeColor(strokeMap);
      rows.push(
        colorRow(
          color,
          options,
          shapePropertiesCss({ strokes: [strokeMap] }, objects, properties, options),
          "stroke-color-" + shapeIndex + "-" + strokeIndex,
          "Border color",
        ),
      );
    }
  }
  if (rows.length === 0) return null;
  return { id: "stroke", title: tr("inspect.attributes.stroke"), rows };
}

function shadowSection(
  shapes: readonly ViewerShape[],
  context: InspectBuildContext,
): InspectSection | null {
  const options = cssOptions(context);
  const rows: InspectRow[] = [];
  for (const [shapeIndex, shape] of shapes.entries()) {
    const shadows = Array.isArray(shape.shadow) ? shape.shadow : [];
    for (const [shadowIndex, shadow] of shadows.entries()) {
      if (shadow === null || typeof shadow !== "object") continue;
      const data = shadow as Record<string, unknown>;
      const style = typeof data.style === "string" ? data.style : "drop-shadow";
      const offsets = [
        String(data["offset-x"] ?? 0) + "px",
        String(data["offset-y"] ?? 0) + "px",
        String(data.blur ?? 0) + "px",
        String(data.spread ?? 0) + "px",
      ].join(" ");
      rows.push({
        key: "shadow-" + shapeIndex + "-" + shadowIndex,
        kind: "shadow",
        label: humanizeCssRule(style),
        value: offsets,
        copy: shadowRule(shadow, options),
      });
      const color = data.color as InspectColor | undefined;
      if (color !== undefined && color !== null) {
        rows.push(
          colorRow(
            color,
            options,
            formatColorValue(color, options),
            "shadow-color-" + shapeIndex + "-" + shadowIndex,
            "",
          ),
        );
      }
    }
  }
  if (rows.length === 0) return null;
  return { id: "shadow", title: tr("inspect.attributes.shadow"), rows };
}

// The blur panel reads the first shape for every row, like the CLJS.
function blurSection(shapes: readonly ViewerShape[]): InspectSection | null {
  const first = shapes[0];
  if (first === undefined) return null;
  const background = first["background-blur"] as { value?: number } | undefined;
  const layer = first.blur as { value?: number } | undefined;
  if (background === undefined && layer === undefined) return null;

  const rows: InspectRow[] = [];
  const copies: string[] = [];
  if (background !== undefined) {
    const copy = "backdrop-filter: " + formatBlur(background.value ?? 0) + ";";
    copies.push(copy);
    rows.push({
      key: "blur-background",
      kind: "blur",
      label: "Backdrop Filter",
      value: formatBlur(background.value ?? 0),
      copy,
    });
  }
  if (layer !== undefined) {
    const copy = "filter: " + formatBlur(layer.value ?? 0) + ";";
    copies.push(copy);
    rows.push({
      key: "blur-layer",
      kind: "blur",
      label: "Filter",
      value: formatBlur(layer.value ?? 0),
      copy,
    });
  }
  return {
    id: "blur",
    title: tr("labels.blur-effects"),
    copy: shapes.length === 1 ? copies.join("\n") : null,
    rows,
  };
}

function layoutSection(
  shapes: readonly ViewerShape[],
  objects: ViewerObjects,
  context: InspectBuildContext,
): InspectSection | null {
  const candidates = shapes.filter(isAnyLayout);
  if (candidates.length === 0) return null;
  const options = cssOptions(context);
  return {
    id: "layout",
    title: "Layout",
    copy:
      candidates.length === 1
        ? shapePropertiesCss(candidates[0], objects, LAYOUT_PROPERTIES, options)
        : null,
    rows: propertyRows(candidates, objects, LAYOUT_PROPERTIES, options, "layout"),
  };
}

function layoutElementSection(
  shapes: readonly ViewerShape[],
  objects: ViewerObjects,
  context: InspectBuildContext,
): InspectSection | null {
  const candidates = shapes.filter((shape) => isLayoutChild(objects, shape));
  if (candidates.length === 0) return null;
  const options = cssOptions(context);
  const rows = propertyRows(
    candidates,
    objects,
    LAYOUT_ELEMENT_PROPERTIES,
    options,
    "layout-element",
  );
  if (rows.length === 0) return null;
  const onlyFlex = candidates.every((shape) => isFlexChild(objects, shape));
  const onlyGrid = candidates.every((shape) => isGridChild(objects, shape));
  const title = onlyFlex ? "Flex element" : onlyGrid ? "Grid element" : "Layout element";
  return {
    id: "layout-element",
    title,
    copy:
      candidates.length === 1
        ? shapePropertiesCss(candidates[0], objects, LAYOUT_ELEMENT_PROPERTIES, options)
        : null,
    rows,
  };
}

function svgSection(shape: ViewerShape): InspectSection | null {
  const attrs = shape["svg-attrs"];
  if (attrs === null || attrs === undefined || typeof attrs !== "object") return null;
  const rows: InspectRow[] = [];
  const visit = (name: string, value: unknown, prefix: string): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      const copy = entries.map(([key, entry]) => key + ":" + String(entry)).join("; ");
      rows.push({ key: prefix, kind: "subtitle", label: name, copy });
      for (const [key, entry] of entries) visit(key, entry, prefix + "-" + key);
      return;
    }
    rows.push({
      key: prefix,
      kind: "property",
      label: humanizeCssRule(name),
      value: String(value ?? ""),
      copy: typeof value === "string" ? value : String(value ?? ""),
    });
  };
  for (const [name, value] of Object.entries(attrs as Record<string, unknown>)) {
    visit(name, value, "svg-" + name);
  }
  if (rows.length === 0) return null;
  return {
    id: "svg",
    title: tr("workspace.sidebar.options.svg-attrs.title"),
    rows,
  };
}

function textRowsForBlock(
  block: TextBlock,
  blockIndex: number,
  context: InspectBuildContext,
): InspectRow[] {
  const rows: InspectRow[] = [];
  const style = block.style;
  const options = cssOptions(context);

  const fills = Array.isArray(style.fills) ? style.fills : [];
  for (const [fillIndex, fill] of fills.entries()) {
    const fillShape = fill as CssShape;
    const color = fillColor(fillShape);
    const copy = copyStyleData(fill as Record<string, unknown>, [
      "fill-color",
      "fill-color-gradient",
    ]);
    rows.push({
      ...colorRow(
        color,
        options,
        copy,
        "text-" + blockIndex + "-fill-" + fillIndex,
        "",
      ),
      key: "text-" + blockIndex + "-fill-" + fillIndex,
    });
  }

  const fontId = textStyleValue(style, "font-id");
  if (fontId !== null) {
    const family =
      context.fontName?.(fontId) ?? textStyleValue(style, "font-family") ?? fontId;
    rows.push({
      key: "text-" + blockIndex + "-font-family",
      kind: "property",
      label: "Font Family",
      value: family,
      copy: copyStyleData(style, ["font-family"]),
    });
  }

  const fontStyle = textStyleValue(style, "font-style");
  if (fontStyle !== null) {
    rows.push({
      key: "text-" + blockIndex + "-font-style",
      kind: "property",
      label: "Font Style",
      value: fontStyle,
      copy: copyStyleData(style, ["font-style"]),
    });
  }

  const fontSize = textStyleValue(style, "font-size");
  if (fontSize !== null) {
    rows.push({
      key: "text-" + blockIndex + "-font-size",
      kind: "property",
      label: "Font Size",
      value: formatPixels(fontSize),
      copy: "font-size: " + formatPixels(fontSize) + ";",
    });
  }

  const fontWeight = textStyleValue(style, "font-weight");
  if (fontWeight !== null) {
    rows.push({
      key: "text-" + blockIndex + "-font-weight",
      kind: "property",
      label: "Font Weight",
      value: fontWeight,
      copy: copyStyleData(style, ["font-weight"]),
    });
  }

  const lineHeight = textStyleValue(style, "line-height");
  if (lineHeight !== null) {
    rows.push({
      key: "text-" + blockIndex + "-line-height",
      kind: "property",
      label: "Line Height",
      value: formatNumber(lineHeight),
      copy: copyStyleData(style, ["line-height"]),
    });
  }

  const letterSpacing = textStyleValue(style, "letter-spacing");
  if (letterSpacing !== null) {
    rows.push({
      key: "text-" + blockIndex + "-letter-spacing",
      kind: "property",
      label: "Letter Spacing",
      value: formatPixels(letterSpacing),
      copy: copyStyleData(style, ["letter-spacing"]),
    });
  }

  const decoration = textStyleValue(style, "text-decoration");
  if (decoration !== null) {
    const label =
      decoration === "none"
        ? tr("inspect.attributes.typography.text-decoration.none")
        : decoration === "underline"
          ? tr("inspect.attributes.typography.text-decoration.underline")
          : decoration === "line-through"
            ? tr("inspect.attributes.typography.text-decoration.strikethrough")
            : decoration;
    rows.push({
      key: "text-" + blockIndex + "-text-decoration",
      kind: "property",
      label: "Text Decoration",
      value: label,
      copy: copyStyleData(style, ["text-decoration"]),
    });
  }

  const transform = textStyleValue(style, "text-transform");
  if (transform !== null) {
    const label =
      transform === "lowercase"
        ? tr("inspect.attributes.typography.text-transform.lowercase")
        : transform === "none"
          ? tr("inspect.attributes.typography.text-transform.none")
          : transform === "capitalize"
            ? tr("inspect.attributes.typography.text-transform.capitalize")
            : transform === "uppercase"
              ? tr("inspect.attributes.typography.text-transform.uppercase")
              : transform === "unset"
                ? tr("inspect.attributes.typography.text-transform.unset")
                : transform;
    rows.push({
      key: "text-" + blockIndex + "-text-transform",
      kind: "property",
      label: "Text Transform",
      value: label,
      copy: copyStyleData(style, ["text-transform"]),
    });
  }

  const text = block.text.trim();
  rows.push({
    key: "text-" + blockIndex + "-content",
    kind: "text",
    label: "",
    value: text,
    copy: text,
    textStyle: {
      fontFamily: textStyleValue(style, "font-family") ?? undefined,
      fontWeight: textStyleValue(style, "font-weight") ?? undefined,
      fontStyle: textStyleValue(style, "font-style") ?? undefined,
    },
  });

  return rows;
}

function textSection(
  shapes: readonly ViewerShape[],
  context: InspectBuildContext,
): InspectSection | null {
  const candidates = shapes.filter((shape) => shape.content !== undefined && shape.content !== null);
  if (candidates.length === 0) return null;
  const rows: InspectRow[] = [];
  for (const [shapeIndex, shape] of candidates.entries()) {
    const blocks = contentToTextBlocks(shape.content);
    for (const [blockIndex, block] of blocks.entries()) {
      rows.push(...textRowsForBlock(block, shapeIndex * 1000 + blockIndex, context));
    }
  }
  if (rows.length === 0) return null;
  return { id: "text", title: tr("inspect.attributes.typography"), rows };
}

function variantSection(
  shape: ViewerShape,
  objects: ViewerObjects,
  context: InspectBuildContext,
): InspectSection | null {
  const components = context.components ?? {};
  const container = isVariantContainer(shape);
  let properties: { name: string; value: string }[];
  if (container) {
    properties = extractVariantProperties(shape, objects, components);
  } else {
    const componentId = shape["component-id"];
    const component =
      typeof componentId === "string" ? components[componentId] : undefined;
    properties = readVariantProperties(component).map((property) => ({
      name: property.name,
      value:
        typeof property.value === "string" && property.value.trim() !== ""
          ? property.value
          : "--",
    }));
  }
  if (properties.length === 0) return null;
  return {
    id: "variant",
    title: container
      ? tr("inspect.attributes.variants")
      : tr("inspect.attributes.variant"),
    rows: properties.map((property, index) => ({
      key: "variant-" + index,
      kind: "variant",
      label: property.name,
      value: property.value,
      copy: property.value,
    })),
  };
}

const TYPE_OPTIONS: Record<string, readonly InspectSectionId[]> = {
  multiple: ["fill", "stroke", "text", "shadow", "blur", "layout-element"],
  frame: ["visibility", "geometry", "fill", "stroke", "shadow", "blur", "layout", "layout-element"],
  group: ["visibility", "geometry", "svg", "layout-element"],
  rect: ["visibility", "geometry", "fill", "stroke", "shadow", "blur", "svg", "layout-element"],
  circle: ["visibility", "geometry", "fill", "stroke", "shadow", "blur", "svg", "layout-element"],
  path: ["visibility", "geometry", "fill", "stroke", "shadow", "blur", "svg", "layout-element"],
  text: ["visibility", "geometry", "text", "shadow", "blur", "stroke", "layout-element"],
  variant: ["variant", "geometry", "fill", "stroke", "shadow", "blur", "layout", "layout-element"],
};

// attributes.cljs: the panels of a selection, in the CLJS order.
export function buildInspectSections(
  shapes: readonly ViewerShape[],
  context: InspectBuildContext,
): InspectSection[] {
  if (shapes.length === 0) return [];
  const objects = context.objects;
  const options = cssOptions(context);
  const type = inspectSelectionType(shapes, context.components);
  const order = TYPE_OPTIONS[type] ?? TYPE_OPTIONS.rect;
  const sections: InspectSection[] = [];

  for (const id of order) {
    switch (id) {
      case "geometry": {
        sections.push({
          id,
          title: tr("inspect.attributes.size"),
          copy:
            shapes.length === 1
              ? shapePropertiesCss(shapes[0], objects, GEOMETRY_PROPERTIES, options)
              : null,
          rows: propertyRows(shapes, objects, GEOMETRY_PROPERTIES, options, "geometry"),
        });
        break;
      }
      case "visibility": {
        const candidates = shapes.filter(
          (shape) =>
            shape.type !== "text" &&
            shape.type !== "group" &&
            (getCssValue("opacity", shape, objects) !== null ||
              getCssValue("blend-mode", shape, objects) !== null ||
              getCssValue("visibility", shape, objects) !== null),
        );
        if (candidates.length === 0) break;
        sections.push({
          id,
          title: "Visibility",
          copy:
            candidates.length === 1
              ? shapePropertiesCss(candidates[0], objects, VISIBILITY_PROPERTIES, options)
              : null,
          rows: propertyRows(candidates, objects, VISIBILITY_PROPERTIES, options, "visibility"),
        });
        break;
      }
      case "fill": {
        const section = fillSection(shapes, objects, context);
        if (section !== null) sections.push(section);
        break;
      }
      case "stroke": {
        const section = strokeSection(shapes, objects, context);
        if (section !== null) sections.push(section);
        break;
      }
      case "shadow": {
        const section = shadowSection(shapes, context);
        if (section !== null) sections.push(section);
        break;
      }
      case "blur": {
        const section = blurSection(shapes);
        if (section !== null) sections.push(section);
        break;
      }
      case "layout": {
        const section = layoutSection(shapes, objects, context);
        if (section !== null) sections.push(section);
        break;
      }
      case "layout-element": {
        const section = layoutElementSection(shapes, objects, context);
        if (section !== null) sections.push(section);
        break;
      }
      case "svg": {
        const shape = shapes[0];
        const section = svgSection(shape);
        if (section !== null) sections.push(section);
        break;
      }
      case "text": {
        const section = textSection(shapes, context);
        if (section !== null) sections.push(section);
        break;
      }
      case "variant": {
        const shape = shapes[0];
        const section = variantSection(shape, objects, context);
        if (section !== null) sections.push(section);
        break;
      }
      default:
        break;
    }
  }

  return sections;
}
