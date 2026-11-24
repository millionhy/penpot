// The host attrs of app.render-wasm.api/set-object-host-attrs: what reaches
// the renderer after the structural record, per shape.
//
// The batch record carries base props, children, blur, shadows, masked,
// bool/grow, fills and strokes (and flex plus layout-item on the cold load).
// Everything below stays out of it because it needs a host data source:
//   - svg-raw markup (the host renders the shape to static SVG),
//   - grid tracks and cells (their own buffers),
//   - text content and the fonts behind it,
//   - image bytes for fill and stroke image fills.
//
// The shape must be current before any of these setters runs: a batch leaves
// the last record current, not this one. `selectShape` therefore runs first for
// every shape that needs any of the work below, except a batch shape that is
// only a plain container.
//
// The compiled original also writes the layout-item data and the flex layout
// on the incremental path; the cold load already carried them in the record,
// which is what `skipLayout` marks.

import { selectShape } from "./select";
import type { Shape } from "./upload";
import type { Stroke } from "./fills";
import {
  isGridLayout,
  setGridLayout,
  setLayoutData,
  setShapeLayout,
} from "./layouts";
import {
  loadShapeImages,
  loadTextImages,
  type ImageHost,
} from "./image";
import type { RenderWasmModule } from "./module";
import {
  setShapeSvgRawContent,
  writeShapeFills,
  writeShapeStrokes,
} from "./props";
import {
  setShapeTextContent,
  type TextContent,
  type TextContentHost,
} from "./text";

export interface HostAttrsOptions {
  // The svg-raw markup of a shape (the classic renderer renders the shape to
  // static SVG). Without it an svg-raw shape keeps no markup.
  getStaticMarkup?: (shape: Shape) => string | undefined;
  // Font preparation and post-write work of the text path.
  text?: TextContentHost;
  // Media URL resolution and fetch for fill/stroke/text image fills.
  images?: ImageHost;
  // The cold-load batch already wrote flex and layout-item; only the grid
  // tracks remain. The incremental path leaves this false.
  skipLayout?: boolean;
  // The batch already wrote the fill and stroke records; only the image bytes
  // remain. The incremental path leaves this false.
  skipFillsStrokes?: boolean;
  // A fresh text shape may carry no content; the host supplies the default
  // tree (typography) the renderer expects.
  ensureTextContent?: (content: unknown) => TextContent;
}

// The image work the caller has to schedule: thumbnails first, then the full
// variants, like the compiled `process-pending`. Every promise resolves even
// when a fetch fails, so ignoring them is safe.
export interface HostAttrsResult {
  thumbnails: Promise<void>[];
  full: Promise<void>[];
  // Whatever `prepareFonts` answered (the pending face stream in the app).
  fonts?: unknown;
}

function defaultEnsureTextContent(content: unknown): TextContent {
  return (content ?? {}) as TextContent;
}

// set-object-host-attrs: the host half of one shape upload.
export function writeHostAttrs(
  module: RenderWasmModule,
  shape: Shape,
  options: HostAttrsOptions = {},
): HostAttrsResult {
  const id = shape.id;
  const type = shape.type;
  const isText = type === "text";
  const isSvgRaw = type === "svg-raw";
  const content = isText
    ? (options.ensureTextContent ?? defaultEnsureTextContent)(shape.content)
    : shape.content;
  const writePaint = options.skipFillsStrokes !== true;

  const needsCurrent =
    writePaint ||
    isText ||
    (content !== null && content !== undefined && isSvgRaw) ||
    (options.skipLayout === true ? isGridLayout(shape) : true);

  if (needsCurrent) selectShape(module, id);

  if (isSvgRaw && content !== null && content !== undefined) {
    const markup = options.getStaticMarkup?.(shape);
    if (markup !== undefined) setShapeSvgRawContent(module, markup);
  }

  if (options.skipLayout === true) {
    if (isGridLayout(shape)) setGridLayout(module, shape);
  } else {
    setShapeLayout(module, shape);
    setLayoutData(module, shape);
  }

  let fonts: unknown;
  if (isText) {
    fonts = setShapeTextContent(module, content as TextContent, options.text);
  }

  const thumbnails = [
    ...(isText ? loadTextImages(module, id, content, true, options.images) : []),
    ...loadShapeImages(module, shape, true, options.images),
  ];
  const full = [
    ...(isText ? loadTextImages(module, id, content, false, options.images) : []),
    ...loadShapeImages(module, shape, false, options.images),
  ];

  if (writePaint) {
    // The compiled order: the fill records, then the strokes of every
    // non-group shape. A group draws no strokes of its own.
    writeShapeFills(module, shape.fills ?? []);
    const strokes: readonly Stroke[] = shape.type === "group" ? [] : (shape.strokes ?? []);
    writeShapeStrokes(module, strokes);
  }

  return { thumbnails, full, fonts };
}
