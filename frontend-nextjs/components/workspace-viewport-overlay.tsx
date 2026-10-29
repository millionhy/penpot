"use client";

// The workspace viewport overlay (F9.2): the SVG layer over the canvas
// that draws what the wasm renderer leaves out — the selection outlines,
// the hover outline and the area-selection marquee — the role of the
// svg.viewport-controls of viewport_wasm.cljs in the CLJS workspace.
//
// The svg carries the store's vbox as its viewBox, so every element draws
// in world coordinates and the zoom scale comes from the viewport itself;
// the layer never takes pointer events (every gesture stays on the canvas
// below). The component re-renders from the store slice (selection /
// hoverShapeId / areaSelect / zoom / vbox / dragDelta / objects); the
// shape geometry comes from the JS-side page objects — the store's current
// model when loaded, the file prop as the pre-load fallback — the same
// model that answers the hit-testing.
//
// Ported pieces:
// - the shape outlines (viewport/outline.cljs outline*): the polygon of the
//   stored points (rotated or not); stroke 1 / zoom, fill none;
// - the selection frame plus the 8 resize handles and the 4 rotation zones
//   (viewport/selection.cljs calculate-handlers / rotation-handler), now
//   interactive: a press calls the canvas gesture through onResizeStart /
//   onRotateStart and the canvas keeps the pointer capture from there;
// - the hover outline of the single hover shape (the CLJS :id @hover);
// - the marquee of the running area selection (widgets selection-rect*).
// - the live drag offset (F9.3): while a move drag runs the selection
//   outlines, the bounds box and the handles shift by the store's
//   dragDelta — the wasm modifier preview moves the shapes themselves, so
//   the overlay keeps their outlines in step; the hover outline stays put.
// - the draw preview (F9.5): a dashed rect of the live box of the
//   frame/rect/ellipse gesture, in world coordinates like the marquee.
// - the transform preview (F9.6): the store matrix of a running
//   resize/rotate gesture maps the outlines and the frame; the handles and
//   the rotation zones hide while it runs.
//
// Deviations from the compiled original, documented:
// - Selection and hover outlines share the accent-tertiary color: the CLJS
//   recolors shapes inside components with the assets-component highlight,
//   which has no token port yet.
// - The outlines are geometric approximations: polygon from the stored
//   points instead of the per-type rendering of outline.cljs (circle ->
//   ellipse, path -> path data); exact path outlines are a later slice.
// - The handles are 8 / zoom squares (the CLJS draws circles and bars) and
//   the rotation zones are 20 / zoom parallelograms outside the corners;
//   their cursors do not follow a flipped shape.
// - The marquee draws dashed (the CLJS draws it solid) and fills with the
//   existing --color-accent-select token, the port of the CLJS
//   accent-tertiary-muted fill.
// - No snap guides, measurements or pixel overlays: this layer visualizes
//   the selection, the hover and the running previews only.

import { useMemo, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";

import { WorkspaceFrameTitles } from "@/components/workspace-frame-titles";
import {
  canEditFile,
  pageObjects,
  type WorkspaceFile,
  type WorkspaceShape,
} from "@/lib/workspace";
import {
  getInitialWorkspaceState,
  getWorkspaceState,
  subscribeWorkspace,
  type TransformPreview,
} from "@/lib/workspace-store";
import type { ViewportRect } from "@/lib/workspace-viewport";
import {
  frameCorners,
  resizeHandlePoints,
  rotationZonePoints,
  selectionGeometry,
  transformPoint,
  translationMatrix,
  type Matrix6,
  type Point,
  type ResizeHandler,
  type RotationCorner,
} from "@/lib/workspace-transform";

// The handle square size of viewport/selection.cljs (resize-point-rect-size),
// in screen pixels.
const HANDLE_SIZE = 8;

// rotation-handler-size of viewport/selection.cljs, in screen pixels.
const ROTATION_ZONE_SIZE = 20;

// The marquee dash length, in world units.
const DASH_SIZE = 4;

// The selrect of a shape as the rect the outline draws, or null when the
// shape has no numeric geometry (the objects hold every file shape).
function selrectOf(shape: WorkspaceShape): ViewportRect | null {
  const selrect = shape.selrect;
  if (selrect === null || typeof selrect !== "object") return null;
  const { x, y, width, height } = selrect as Record<string, unknown>;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return null;
  }
  return { x, y, width, height };
}

// The shape points as an SVG polygon, or null when the shape has no usable
// geometry. The matrix is the live move translation or transform preview;
// the hover outline passes none.
function outlinePolygon(shape: WorkspaceShape, matrix: Matrix6 | null): string | null {
  const points = shapeWorldPoints(shape);
  if (points === null) return null;
  const world = matrix === null ? points : points.map((point) => transformPoint(point, matrix));
  return pointsToString(world);
}

// The four world points of a shape: the stored points, or the selrect
// corners for a shape that carries none.
function shapeWorldPoints(shape: WorkspaceShape): Point[] | null {
  const points = shape.points;
  if (Array.isArray(points) && points.length >= 4) {
    const out: Point[] = [];
    for (const point of points as unknown[]) {
      if (point === null || typeof point !== "object") break;
      const { x, y } = point as Record<string, unknown>;
      if (typeof x !== "number" || typeof y !== "number") break;
      out.push({ x, y });
    }
    if (out.length >= 4) return out.slice(0, 4);
  }
  const rect = selrectOf(shape);
  if (rect === null) return null;
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

function pointsToString(points: readonly Point[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

// outline*: the polygon of the shape points, stroke 1 / zoom (the viewBox
// scale is the zoom, so the stroke stays one screen pixel).
function ShapeOutline({
  shape,
  zoom,
  className,
  testId,
  matrix = null,
}: {
  shape: WorkspaceShape;
  zoom: number;
  className: string;
  testId?: string;
  matrix?: Matrix6 | null;
}) {
  const polygon = outlinePolygon(shape, matrix);
  if (polygon === null) return null;
  return (
    <polygon
      className={className}
      data-testid={testId}
      points={polygon}
      strokeWidth={1 / zoom}
    />
  );
}

// The store preview in the matrix tuple the transform module uses.
function matrixOf(preview: TransformPreview | null): Matrix6 | null {
  if (preview === null) return null;
  return [preview.a, preview.b, preview.c, preview.d, preview.e, preview.f];
}

export interface WorkspaceViewportOverlayProps {
  // The resolved file of lib/workspace (the store's file): the overlay
  // reads the page objects for the outline geometry and the permissions
  // that decide whether the handles render.
  file: WorkspaceFile;
  pageId: string;
  // The artboard-name toggle of the shell (View menu), passed down as a
  // prop so UI state stays out of the store.
  showFrameTitles: boolean;
  // A press on a resize handle: the canvas starts the gesture and keeps the
  // pointer capture from there.
  onResizeStart?: (handler: ResizeHandler, event: ReactPointerEvent<SVGElement>) => void;
  // A press on a rotation zone.
  onRotateStart?: (corner: RotationCorner, event: ReactPointerEvent<SVGElement>) => void;
}

export function WorkspaceViewportOverlay({
  file,
  pageId,
  showFrameTitles,
  onResizeStart,
  onRotateStart,
}: WorkspaceViewportOverlayProps) {
  const state = useSyncExternalStore(
    subscribeWorkspace,
    getWorkspaceState,
    getInitialWorkspaceState,
  );

  const {
    selection,
    hoverShapeId,
    areaSelect,
    zoom,
    vbox,
    dragDelta,
    drawPreview,
    curvePreview,
    transformPreview,
  } = state;
  const storeObjects = state.objects;
  const objects = useMemo(
    () => storeObjects ?? pageObjects(file, pageId),
    [storeObjects, file, pageId],
  );
  const geometry = useMemo(() => selectionGeometry(objects, selection), [objects, selection]);
  const previewMatrix = useMemo(() => matrixOf(transformPreview), [transformPreview]);

  if (zoom === null || vbox === null) return null;

  const selectedShapes: WorkspaceShape[] = [];
  for (const id of selection) {
    const shape = objects[id];
    if (shape !== undefined && shape !== null) selectedShapes.push(shape);
  }
  const hoverShape = hoverShapeId === null ? null : (objects[hoverShapeId] ?? null);
  // The live preview wins over the move translation: only one gesture runs.
  const displayMatrix =
    previewMatrix ??
    (dragDelta === null ? null : translationMatrix(dragDelta.dx, dragDelta.dy));
  const boundsPoints =
    geometry === null ? null : pointsToString(frameCorners(geometry, displayMatrix));
  const handles =
    geometry === null ? [] : resizeHandlePoints(geometry, displayMatrix);
  const rotationZones =
    geometry === null
      ? []
      : rotationZonePoints(geometry, ROTATION_ZONE_SIZE / zoom, displayMatrix);
  // The handles and the rotation zones only exist for an editable selection
  // of supported types, and they hide while a transform gesture runs.
  const handlesVisible =
    canEditFile(file) && geometry !== null && previewMatrix === null;
  const handleSize = HANDLE_SIZE / zoom;

  return (
    <svg
      className="pp-workspace-overlay"
      data-testid="viewport-overlay"
      viewBox={`${vbox.x} ${vbox.y} ${vbox.width} ${vbox.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <WorkspaceFrameTitles
        objects={objects}
        selection={selection}
        zoom={zoom}
        showFrameTitles={showFrameTitles}
      />

      <g className="pp-overlay-outlines">
        {selectedShapes.map((shape) => (
          <ShapeOutline
            key={shape.id}
            shape={shape}
            zoom={zoom}
            className="pp-overlay-outline"
            testId="selection-outline"
            matrix={displayMatrix}
          />
        ))}
      </g>
      {boundsPoints !== null ? (
        <g className="pp-overlay-bounds">
          <polygon
            className="pp-overlay-bounds-box"
            points={boundsPoints}
            strokeWidth={1 / zoom}
          />
          {handlesVisible
            ? rotationZones.map((zone) => (
                <polygon
                  key={zone.corner}
                  className="pp-overlay-rotate"
                  data-testid="rotate-zone"
                  data-corner={zone.corner}
                  points={pointsToString(zone.points)}
                  onPointerDown={(event) => onRotateStart?.(zone.corner, event)}
                />
              ))
            : null}
          {handlesVisible
            ? handles.map((handle) => (
                <rect
                  key={handle.handler}
                  className={`pp-overlay-handle pp-overlay-handle-${handle.handler}`}
                  data-testid="resize-handle"
                  data-handler={handle.handler}
                  x={handle.x - handleSize / 2}
                  y={handle.y - handleSize / 2}
                  width={handleSize}
                  height={handleSize}
                  onPointerDown={(event) => onResizeStart?.(handle.handler, event)}
                />
              ))
            : null}
        </g>
      ) : null}
      {drawPreview !== null ? (
        <rect
          className="pp-overlay-draw"
          data-testid="draw-preview"
          x={drawPreview.x}
          y={drawPreview.y}
          width={drawPreview.width}
          height={drawPreview.height}
          strokeWidth={1 / zoom}
          strokeDasharray={`${DASH_SIZE / zoom} ${DASH_SIZE / zoom}`}
        />
      ) : null}
      {curvePreview !== null && curvePreview.points.length > 1 ? (
        <polyline
          className="pp-overlay-draw"
          data-testid="curve-preview"
          points={pointsToString(curvePreview.points)}
          strokeWidth={1 / zoom}
        />
      ) : null}
      {hoverShape !== null ? (
        <ShapeOutline
          shape={hoverShape}
          zoom={zoom}
          className="pp-overlay-hover"
          testId="hover-outline"
        />
      ) : null}
      {areaSelect !== null ? (
        <rect
          className="pp-overlay-area"
          data-testid="area-select"
          x={areaSelect.x}
          y={areaSelect.y}
          width={areaSelect.width}
          height={areaSelect.height}
          strokeWidth={1 / zoom}
          strokeDasharray={`${DASH_SIZE / zoom} ${DASH_SIZE / zoom}`}
        />
      ) : null}
    </svg>
  );
}
