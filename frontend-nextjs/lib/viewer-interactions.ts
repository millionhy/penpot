// Viewer interactions (F6.5): the hotspot logic of the WASM viewer. Headless
// port of the viewer half of app.main.ui.viewer.shapes (activate-interaction,
// deactivate-interaction, the hotspot filter), of calc-overlay-position in
// app.common.types.shape.interactions and of the calculate-delta /
// calculate-wrapper helpers of app.main.ui.viewer.
//
// Kept free of JSX so it runs in vitest's node environment, like lib/viewer.ts.
// The views live in app/view/page.tsx and components/viewer-*.tsx.
//
// The math works on the prepared (vbox-space) shapes: the compiled
// prepare-objects shifts every shape by -(size + delta), and the overlay CSS
// positions are relative to the padded frame container, so the caller passes
// the same prepared values the hotspots render from (the CLJS passes its
// prepared objects too). Shapes arrive as plain decoded values (kebab-case
// keys); the reader abstracts the objects map.
//
// Deviations from the CLJS original, documented:
// - activate/deactivate answer a plain action descriptor; the CLJS emits the
//   events into the store. The caller (app/view/page.tsx) applies them to its
//   React state.
// - Missing destinations answer null instead of tripping the store assertions
//   (close-overlay without a destination would assert on a nil uuid).
// - calc-overlay-position falls back to [[0, 0], [:top :left]] when a selrect
//   is missing (the CLJS would throw), and tolerates a missing
//   overlay-position on non-frame relative-to shapes, where the CLJS
//   (- nil n) would throw; the fallback is (0, 0).
// - The fixed-scroll viewport layers (the pinned-layer render pass) are not
//   ported yet: isFixed only feeds the overlay fixed-source flag. See the
//   F6.5 notes in rewrite.md.

import { ZERO_UUID, type ViewerShape } from "./viewer";
import type { ViewerSize } from "./render-wasm/sizes";

export interface Point {
  x: number;
  y: number;
}

export type SnapV = "top" | "center" | "bottom";
export type SnapH = "left" | "center" | "right";
export type SnapTo = [SnapV, SnapH];

// ctsi/schema:animation: the animation descriptor carried by navigation and
// overlay interactions.
export interface InteractionAnimation {
  "animation-type": "dissolve" | "slide" | "push";
  duration?: number;
  easing?: string;
  way?: "in" | "out";
  direction?: "right" | "left" | "up" | "down";
  "offset-effect"?: boolean;
}

// ctsi/schema:interaction: the interaction fields the viewer reads. The full
// schema is wider (F9); unknown keys stay accessible through the index
// signature.
export interface ViewerInteraction {
  "action-type"?: string;
  "event-type"?: string;
  destination?: string | null;
  url?: string | null;
  "preserve-scroll"?: boolean;
  "overlay-pos-type"?: string;
  "position-relative-to"?: string | null;
  "close-click-outside"?: boolean;
  "background-overlay"?: boolean;
  "overlay-position"?: Point | null;
  animation?: InteractionAnimation | null;
  delay?: number;
  [key: string]: unknown;
}

// The prepared shape slice the interaction math reads, built by reading the
// CLJS shape with get(). The full shape is wider (F9); unknown keys stay
// accessible through the index signature.
export interface InteractionShape {
  id: string;
  type?: string;
  name?: string;
  x?: number;
  y?: number;
  shapes?: string[];
  selrect?: ViewerShape["selrect"];
  "frame-id"?: string | null;
  "parent-id"?: string | null;
  "fixed-scroll"?: boolean;
  interactions?: ViewerInteraction[];
  hidden?: boolean;
  [key: string]: unknown;
}

export type ShapeReader = (id: string) => InteractionShape | undefined;

// The open/toggle overlay payload: what data/viewer.cljs stores per overlay.
export interface OverlaySpec {
  frameId: string;
  position: Point;
  snapTo: SnapTo;
  closeClickOutside?: boolean;
  backgroundOverlay?: boolean;
  animation?: InteractionAnimation;
  // fixed-base? / fixed-source?: the overlay pins to the viewport instead of
  // following the base frame.
  fixedSource?: boolean;
}

// What an interaction asks the viewer to do. app/view/page.tsx applies these
// to its state (navigation, overlays, scroll restore, new windows).
export type ViewerAction =
  | {
      kind: "navigate";
      frameId: string;
      animation?: InteractionAnimation;
      preserveScroll: boolean;
    }
  | { kind: "open-overlay"; overlay: OverlaySpec }
  | { kind: "toggle-overlay"; overlay: OverlaySpec }
  | { kind: "close-overlay"; frameId: string; animation?: InteractionAnimation }
  | { kind: "prev-screen" }
  | { kind: "open-url"; url: string };

// --- Shape helpers (app.common.files.helpers) -------------------------------

// ctsi/actionable?: is any interaction a click target (drives the hotspot
// pointer cursor).
export function actionable(
  interactions: readonly ViewerInteraction[] | null | undefined,
): boolean {
  return (interactions ?? []).some((interaction) => interaction["event-type"] === "click");
}

// The `->> filter` of the shapes.cljs pointer handlers: the interactions of
// one hotspot that listen to any of the given event kinds, in order.
export function interactionsByEvent(
  shape: InteractionShape,
  eventTypes: readonly string[],
): ViewerInteraction[] {
  return (shape.interactions ?? []).filter((interaction) =>
    eventTypes.includes(interaction["event-type"] ?? ""),
  );
}

// cfh/root?: the root frame of the objects map.
export function isRoot(shape: InteractionShape | null | undefined): boolean {
  return shape !== null && shape !== undefined && shape.type === "frame" && shape.id === ZERO_UUID;
}

// cfh/root-frame?: a frame directly under the root (its frame-id is zero).
export function isRootFrame(objects: ShapeReader, id: string): boolean {
  if (id === ZERO_UUID) return false;
  const shape = objects(id);
  return (
    shape !== undefined &&
    shape.id !== ZERO_UUID &&
    shape.type === "frame" &&
    (shape["frame-id"] ?? null) === ZERO_UUID
  );
}

// cfh/is-direct-child-of-root?: the shape hangs off the root frame: a
// top-level frame, or a shape drawn straight on the root.
export function isDirectChildOfRoot(shape: InteractionShape): boolean {
  return (shape["frame-id"] ?? null) === ZERO_UUID;
}

// cfh/get-frame: the frame that contains the shape; a frame answers itself,
// and a frame's own :frame-id points at its parent frame (zero at the top).
export function getShapeFrame(
  objects: ShapeReader,
  shape: InteractionShape,
): InteractionShape | undefined {
  if (shape.type === "frame") return shape;
  const frameId = shape["frame-id"];
  return frameId !== null && frameId !== undefined ? objects(frameId) : undefined;
}

// cfh/get-parent.
export function getParent(
  objects: ShapeReader,
  shape: InteractionShape,
): InteractionShape | undefined {
  const parentId = shape["parent-id"];
  return parentId !== null && parentId !== undefined ? objects(parentId) : undefined;
}

// cfh/get-children-ids: every descendant id. The CLJS collects the direct
// children first, then each child's own subtree (into shapes + mapcat), not
// a plain depth-first walk; keep that order for parity.
export function getChildrenIds(objects: ShapeReader, shapeId: string): string[] {
  const visit = (id: string, processed: ReadonlySet<string>): string[] => {
    if (processed.has(id)) return [];
    const children = objects(id)?.shapes;
    if (children === undefined || children.length === 0) return [];
    const out = [...children];
    const next = new Set(processed);
    next.add(id);
    for (const child of children) {
      out.push(...visit(child, next));
    }
    return out;
  };
  return visit(shapeId, new Set());
}

// frame-hotspots* (app.main.ui.viewer.shapes): the hotspot shapes of a
// frame subtree, in the (cons frame-id children) order. The frame itself
// takes part; an optional filter (the fixed-scroll layer split) drops ids
// before the lookup, hidden shapes and shapes without interactions stay
// out, and dangling ids answer undefined and are skipped (keep).
export function hotspotShapes(
  reader: ShapeReader,
  frameId: string,
  filter?: (id: string) => boolean,
): InteractionShape[] {
  const out: InteractionShape[] = [];
  for (const id of [frameId, ...getChildrenIds(reader, frameId)]) {
    if (filter !== undefined && !filter(id)) continue;
    const shape = reader(id);
    if (
      shape !== undefined &&
      shape.hidden !== true &&
      (shape.interactions?.length ?? 0) > 0
    ) {
      out.push(shape);
    }
  }
  return out;
}

// cfh/fixed-scroll?: a shape pinned to its frame's viewport: direct child of
// a non-root frame, flagged fixed-scroll.
export function fixedScroll(shape: InteractionShape | null | undefined): boolean {
  return (
    shape !== null &&
    shape !== undefined &&
    shape["fixed-scroll"] === true &&
    (shape["parent-id"] ?? null) === (shape["frame-id"] ?? null) &&
    (shape["frame-id"] ?? null) !== ZERO_UUID
  );
}

// cfh/fixed?: the shape, its subtree or its ancestors (up to the first
// top-level frame) carry the fixed-scroll flag.
export function isFixed(
  objects: ShapeReader,
  shapeId: string | null | undefined,
): boolean {
  if (shapeId === null || shapeId === undefined) return false;
  const ids = [
    shapeId,
    ...getChildrenIds(objects, shapeId),
    ...parentIdsUntilRoot(objects, shapeId),
  ];
  return ids.some((id) => fixedScroll(objects(id)));
}

// cfh/get-parent-ids cut at the first top-level frame (the take-while of
// cfh/fixed?): the ancestors up to, but excluding, the root frame and the
// frames hanging directly off it.
function parentIdsUntilRoot(objects: ShapeReader, shapeId: string): string[] {
  const out: string[] = [];
  let current = shapeId;
  for (;;) {
    const parentId = objects(current)?.["parent-id"];
    if (parentId === null || parentId === undefined || parentId === current) break;
    if (parentId === ZERO_UUID || isRootFrame(objects, parentId)) break;
    out.push(parentId);
    current = parentId;
  }
  return out;
}

// --- Overlay positioning ----------------------------------------------------

// find-relative-to-base-frame (app.main.ui.viewer.shapes): the shape the
// overlay positions against, walked up the parent chain while inside
// overlays. The frame branch comes first, and the root is a frame, so the
// root answers itself; the root? check below never fires in the CLJS either.
export function findRelativeToBaseFrame(
  shape: InteractionShape | undefined,
  objects: ShapeReader,
  overlaysIds: ReadonlySet<string>,
  baseFrame: InteractionShape,
): InteractionShape {
  if (shape !== undefined && shape.type === "frame") return shape;
  if (overlaysIds.size === 0 || shape === undefined || isRoot(shape)) return baseFrame;
  return findRelativeToBaseFrame(getParent(objects, shape), objects, overlaysIds, baseFrame);
}

// ignore-frame-shape: a shape with a frame origin stops being a frame when
// the interaction is not manual, so the frame itself drops out of the
// relative-to walks. The caller puts the copy back into the objects view.
export function ignoreFrameShape(
  shape: InteractionShape,
  manual: boolean,
): InteractionShape {
  const frameId = shape["frame-id"];
  if (frameId !== null && frameId !== undefined && !manual) {
    return { ...shape, type: "rect" };
  }
  return shape;
}

// (assoc objects (:id shape) shape) of the CLJS: the reader sees the ignored
// copy under the same id.
function withShapeOverride(objects: ShapeReader, shape: InteractionShape): ShapeReader {
  return (id) => (id === shape.id ? shape : objects(id));
}

// ctsi/calc-overlay-position: the overlay top-left and the snap sides that
// decide how calculate-delta aligns the padded bounds against the frame
// selrect.
export function calcOverlayPosition(
  interaction: ViewerInteraction,
  shape: InteractionShape,
  objects: ShapeReader,
  relativeToShape: InteractionShape,
  baseFrame: InteractionShape,
  destFrame: InteractionShape | undefined,
  frameOffset: Point,
): [Point, SnapTo] {
  const shapeFrame = getShapeFrame(objects, shape);

  // When the interactive item is inside a nested frame we add the position
  // of that frame, otherwise the manual overlay lands offset.
  let offset = frameOffset;
  if (
    interaction["overlay-pos-type"] === "manual" &&
    shapeFrame !== undefined &&
    !isDirectChildOfRoot(shapeFrame) &&
    !isRoot(shapeFrame)
  ) {
    offset = { x: offset.x + (shapeFrame.x ?? 0), y: offset.y + (shapeFrame.y ?? 0) };
  }

  if (destFrame === undefined) {
    return [{ x: 0, y: 0 }, ["top", "left"]];
  }

  // The destination frame selrect (the visible frame box), not its full
  // bounds: bounds include padding for shadows, blur, strokes and
  // overflowing children, which would shift centered/right/bottom positions
  // by half that padding. calculate-delta re-aligns the padded size
  // separately.
  const overlaySize = destFrame.selrect;
  const baseFrameSize = baseFrame.selrect;
  const relativeToSize = relativeToShape.selrect;
  if (overlaySize === undefined || baseFrameSize === undefined || relativeToSize === undefined) {
    return [{ x: 0, y: 0 }, ["top", "left"]];
  }

  const adjusted = {
    x: relativeToSize.x - baseFrameSize.x,
    y: relativeToSize.y - baseFrameSize.y,
  };
  const positionRelativeTo = interaction["position-relative-to"];
  const relativeToIsAuto =
    (positionRelativeTo === null || positionRelativeTo === undefined) &&
    interaction["overlay-pos-type"] !== "manual";
  const basePosition = relativeToIsAuto
    ? { x: 0, y: 0 }
    : { x: offset.x + adjusted.x, y: offset.y + adjusted.y };

  const rawOverlay = interaction["overlay-position"] ?? { x: 0, y: 0 };
  const overlayPosition =
    relativeToShape.type === "frame"
      ? rawOverlay
      : { x: rawOverlay.x - adjusted.x, y: rawOverlay.y - adjusted.y };

  const gapX = relativeToSize.width - overlaySize.width;
  const gapY = relativeToSize.height - overlaySize.height;

  switch (interaction["overlay-pos-type"]) {
    case "center":
      return [
        { x: basePosition.x + gapX / 2, y: basePosition.y + gapY / 2 },
        ["center", "center"],
      ];
    case "top-left":
      return [{ x: basePosition.x, y: basePosition.y }, ["top", "left"]];
    case "top-right":
      return [
        { x: basePosition.x + gapX, y: basePosition.y },
        ["top", "right"],
      ];
    case "top-center":
      return [
        { x: basePosition.x + gapX / 2, y: basePosition.y },
        ["top", "center"],
      ];
    case "bottom-left":
      return [
        { x: basePosition.x, y: basePosition.y + gapY },
        ["bottom", "left"],
      ];
    case "bottom-right":
      return [
        { x: basePosition.x + gapX, y: basePosition.y + gapY },
        ["bottom", "right"],
      ];
    case "bottom-center":
      return [
        { x: basePosition.x + gapX / 2, y: basePosition.y + gapY },
        ["bottom", "center"],
      ];
    default:
      // :manual (the schema guarantees one of the eight kinds).
      return [
        {
          x: basePosition.x + overlayPosition.x,
          y: basePosition.y + overlayPosition.y,
        },
        ["top", "left"],
      ];
  }
}

// --- Activate / deactivate --------------------------------------------------

// The shared math of the open/toggle overlay branches. fixedBasedOn picks the
// fixed? probe: "relative" reads the resolved relative-to id (open-overlay),
// "base-frame" the base frame id (toggle-overlay).
function overlaySpecFor(
  interaction: ViewerInteraction,
  shape: InteractionShape,
  baseFrame: InteractionShape,
  frameOffset: Point,
  objects: ShapeReader,
  overlaysIds: ReadonlySet<string>,
  fixedBasedOn: "relative" | "base-frame",
): OverlaySpec | null {
  const manual = interaction["overlay-pos-type"] === "manual";
  const ignored = ignoreFrameShape(shape, manual);
  const scoped = withShapeOverride(objects, ignored);

  const destFrameId = interaction.destination ?? null;
  if (destFrameId === null) return null;
  const destFrame = scoped(destFrameId);

  // Manual interactions are always from "self": the shape itself, or its
  // parent frame when the origin is a frame.
  const relativeToId = manual
    ? ignored.type === "frame"
      ? (ignored["frame-id"] ?? null)
      : ignored.id
    : (interaction["position-relative-to"] ?? null);
  const relativeToShape = (relativeToId !== null ? scoped(relativeToId) : undefined) ?? baseFrame;
  const relativeToBaseFrame = findRelativeToBaseFrame(relativeToShape, scoped, overlaysIds, baseFrame);

  const [position, snapTo] = calcOverlayPosition(
    interaction,
    ignored,
    scoped,
    relativeToShape,
    relativeToBaseFrame,
    destFrame,
    frameOffset,
  );

  const fixedSource =
    fixedBasedOn === "relative"
      ? isFixed(scoped, relativeToId)
      : isFixed(scoped, baseFrame.id);

  return {
    frameId: destFrameId,
    position,
    snapTo,
    closeClickOutside: interaction["close-click-outside"],
    backgroundOverlay: interaction["background-overlay"],
    animation: interaction.animation ?? undefined,
    fixedSource,
  };
}

// activate-interaction: the action of the pointer interactions of a hotspot.
export function activateInteraction(
  interaction: ViewerInteraction,
  shape: InteractionShape,
  baseFrame: InteractionShape,
  frameOffset: Point,
  objects: ShapeReader,
  overlaysIds: readonly string[],
): ViewerAction | null {
  const overlaysSet = new Set(overlaysIds);

  switch (interaction["action-type"]) {
    case "navigate": {
      const frameId = interaction.destination ?? null;
      if (frameId === null) return null;
      return {
        kind: "navigate",
        frameId,
        animation: interaction.animation ?? undefined,
        preserveScroll: interaction["preserve-scroll"] === true,
      };
    }

    case "open-overlay": {
      const overlay = overlaySpecFor(
        interaction,
        shape,
        baseFrame,
        frameOffset,
        objects,
        overlaysSet,
        "relative",
      );
      return overlay === null ? null : { kind: "open-overlay", overlay };
    }

    case "toggle-overlay": {
      const overlay = overlaySpecFor(
        interaction,
        shape,
        baseFrame,
        frameOffset,
        objects,
        overlaysSet,
        "base-frame",
      );
      return overlay === null ? null : { kind: "toggle-overlay", overlay };
    }

    case "close-overlay": {
      const destFrameId =
        interaction.destination ??
        (shape.type === "frame" && overlaysIds.includes(shape.id)
          ? shape.id
          : (shape["frame-id"] ?? null));
      if (destFrameId === null) return null;
      return {
        kind: "close-overlay",
        frameId: destFrameId,
        animation: interaction.animation ?? undefined,
      };
    }

    case "prev-screen":
      return { kind: "prev-screen" };

    case "open-url": {
      const url = interaction.url;
      return url !== null && url !== undefined ? { kind: "open-url", url } : null;
    }

    default:
      return null;
  }
}

// deactivate-interaction: the opposite action, performed on pointer-up of a
// mouse-press interaction. open-overlay closes without animation; the other
// two reuse their activate math (data/viewer.cljs inverts the animation of
// the toggle close itself).
export function deactivateInteraction(
  interaction: ViewerInteraction,
  shape: InteractionShape,
  baseFrame: InteractionShape,
  frameOffset: Point,
  objects: ShapeReader,
  overlaysIds: readonly string[],
): ViewerAction | null {
  const overlaysSet = new Set(overlaysIds);

  switch (interaction["action-type"]) {
    case "open-overlay": {
      const frameId =
        interaction.destination ??
        (shape.type === "frame" ? shape.id : (shape["frame-id"] ?? null));
      return frameId === null ? null : { kind: "close-overlay", frameId };
    }

    case "toggle-overlay": {
      const overlay = overlaySpecFor(
        interaction,
        shape,
        baseFrame,
        frameOffset,
        objects,
        overlaysSet,
        "base-frame",
      );
      return overlay === null ? null : { kind: "toggle-overlay", overlay };
    }

    case "close-overlay": {
      const overlay = overlaySpecFor(
        interaction,
        shape,
        baseFrame,
        frameOffset,
        objects,
        overlaysSet,
        "relative",
      );
      return overlay === null ? null : { kind: "open-overlay", overlay };
    }

    default:
      return null;
  }
}

// ctsi/invert-direction: the reverse sliding direction (the toggle close and
// the close-click-outside rewind use it).
export function invertDirection(
  animation: InteractionAnimation | null | undefined,
): InteractionAnimation | undefined {
  if (animation === null || animation === undefined) return undefined;
  switch (animation.direction) {
    case "right":
      return { ...animation, direction: "left" };
    case "left":
      return { ...animation, direction: "right" };
    case "up":
      return { ...animation, direction: "down" };
    case "down":
      return { ...animation, direction: "up" };
    default:
      return animation;
  }
}

// --- Viewport alignment -----------------------------------------------------

// calculate-delta (app.main.ui.viewer): the displacement that puts the frame
// selrect flush against the overlay snap side, ignoring the padding of the
// reserved bounds. Multiplied by the zoom, like the CLJS.
export function calculateDelta(
  size: ViewerSize,
  selrect: ViewerShape["selrect"],
  snapTo: SnapTo,
  zoom: number,
): Point {
  const rect = selrect ?? { x: size.x, y: size.y, width: 0, height: 0 };
  const x1 = rect.x1 ?? rect.x;
  const y1 = rect.y1 ?? rect.y;
  const x2 = rect.x2 ?? rect.x + rect.width;
  const y2 = rect.y2 ?? rect.y + rect.height;
  const [snapV, snapH] = snapTo;

  const deltaX =
    snapH === "left"
      ? x1 - size.x
      : snapH === "right"
        ? x2 - (size.x + size.width / zoom)
        : (rect.width - size.width / zoom) / 2 - (size.x - x1);
  const deltaY =
    snapV === "top"
      ? y1 - size.y
      : snapV === "bottom"
        ? y2 - (size.y + size.height / zoom)
        : (rect.height - size.height / zoom) / 2 - (size.y - y1);

  return { x: deltaX * zoom, y: deltaY * zoom };
}

export interface WrapperSize {
  width: number;
  height: number;
  vbox: string;
}

// calculate-wrapper (app.main.ui.viewer): the wrapper reserves the largest
// base size of the two viewports (the base frame and the navigation origin).
export function calculateWrapper(
  size1: ViewerSize | null,
  size2: ViewerSize | null,
  zoom: number,
): WrapperSize | null {
  if (size1 === null) return size2 === null ? null : sizeWrapper(size2);
  if (size2 === null) return sizeWrapper(size1);
  const width = Math.max(size1.baseWidth, size2.baseWidth);
  const height = Math.max(size1.baseHeight, size2.baseHeight);
  return { width: width * zoom, height: height * zoom, vbox: "0 0 " + width + " " + height };
}

function sizeWrapper(size: ViewerSize): WrapperSize {
  return {
    width: size.width,
    height: size.height,
    vbox: "0 0 " + size.baseWidth + " " + size.baseHeight,
  };
}
