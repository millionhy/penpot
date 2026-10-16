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
// - the shape outlines (viewport/outline.cljs outline*): the rect of the
//   selrect, the polygon of the rotated points; stroke 1 / zoom, fill none;
// - the total bounds box of the selection plus the 8 static handles
//   (viewport/selection.cljs calculate-handlers; draw-only for now);
// - the hover outline of the single hover shape (the CLJS :id @hover);
// - the marquee of the running area selection (widgets selection-rect*).
// - the live drag offset (F9.3): while a move drag runs the selection
//   outlines, the bounds box and the handles shift by the store's
//   dragDelta — the wasm modifier preview moves the shapes themselves, so
//   the overlay keeps their outlines in step; the hover outline stays put.
//
// Deviations from the compiled original, documented:
// - Selection and hover outlines share the accent-tertiary color: the CLJS
//   recolors shapes inside components with the assets-component highlight,
//   which has no token port yet.
// - The outlines are geometric approximations: rect/polygon from the
//   selrect/points instead of the per-type rendering of outline.cljs
//   (circle -> ellipse, path -> path data); exact path outlines are a
//   later slice.
// - The handles render as squares of 8 / zoom (draw-only; the CLJS draws
//   circles and later slices wire their drag handlers, which F9.3 does
//   not port: the resize gesture is outside this slice).
// - The marquee draws dashed (the CLJS draws it solid) and fills with the
//   existing --color-accent-select token, the port of the CLJS
//   accent-tertiary-muted fill.
// - No rotation handler, snap guides, measurements or pixel overlays: this
//   slice visualizes the selection, the hover and the area only.

import { useMemo, useSyncExternalStore } from "react";

import { pageObjects, type WorkspaceFile, type WorkspaceShape } from "@/lib/workspace";
import {
  getInitialWorkspaceState,
  getWorkspaceState,
  subscribeWorkspace,
  type DragDelta,
} from "@/lib/workspace-store";
import type { ViewportRect } from "@/lib/workspace-viewport";

// The handle square size of viewport/selection.cljs (resize-point-rect-size),
// in world units.
const HANDLE_SIZE = 8;

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

// The rotated corner points as an SVG polygon, or null when the shape is
// unrotated or the points are not usable; the drag offset shifts every
// vertex.
function polygonOf(shape: WorkspaceShape, dx: number, dy: number): string | null {
  if (typeof shape.rotation !== "number" || shape.rotation === 0) return null;
  const points = shape.points;
  if (!Array.isArray(points) || points.length < 4) return null;
  return points.map((point) => `${point.x + dx},${point.y + dy}`).join(" ");
}

// outline*: the polygon of a rotated shape, the rect of the selrect
// otherwise; stroke 1 / zoom (the viewBox scale is the zoom, so the stroke
// stays one screen pixel). The offset is the live drag delta.
function ShapeOutline({
  shape,
  zoom,
  className,
  testId,
  offset,
}: {
  shape: WorkspaceShape;
  zoom: number;
  className: string;
  testId?: string;
  offset?: DragDelta | null;
}) {
  const dx = offset?.dx ?? 0;
  const dy = offset?.dy ?? 0;
  const polygon = polygonOf(shape, dx, dy);
  if (polygon !== null) {
    return (
      <polygon
        className={className}
        data-testid={testId}
        points={polygon}
        strokeWidth={1 / zoom}
      />
    );
  }
  const rect = selrectOf(shape);
  if (rect === null) return null;
  return (
    <rect
      className={className}
      data-testid={testId}
      x={rect.x + dx}
      y={rect.y + dy}
      width={rect.width}
      height={rect.height}
      strokeWidth={1 / zoom}
    />
  );
}

// The union of the selrects of the selection (the bounds box of
// calculate-handlers).
function selectionBounds(shapes: readonly WorkspaceShape[]): ViewportRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    const rect = selrectOf(shape);
    if (rect === null) continue;
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// The 8 static handles of calculate-handlers: the corners and the edge
// midpoints of the bounds box.
function handlePositions(rect: ViewportRect): { x: number; y: number }[] {
  const midX = rect.x + rect.width / 2;
  const midY = rect.y + rect.height / 2;
  return [
    { x: rect.x, y: rect.y },
    { x: midX, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: midY },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: midX, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x, y: midY },
  ];
}

export interface WorkspaceViewportOverlayProps {
  // The resolved file of lib/workspace (the store's file): the overlay
  // reads the page objects for the outline geometry.
  file: WorkspaceFile;
  pageId: string;
}

export function WorkspaceViewportOverlay({ file, pageId }: WorkspaceViewportOverlayProps) {
  const state = useSyncExternalStore(
    subscribeWorkspace,
    getWorkspaceState,
    getInitialWorkspaceState,
  );

  const { selection, hoverShapeId, areaSelect, zoom, vbox, dragDelta } = state;
  const storeObjects = state.objects;
  const objects = useMemo(
    () => storeObjects ?? pageObjects(file, pageId),
    [storeObjects, file, pageId],
  );

  if (zoom === null || vbox === null) return null;

  const selectedShapes: WorkspaceShape[] = [];
  for (const id of selection) {
    const shape = objects[id];
    if (shape !== undefined && shape !== null) selectedShapes.push(shape);
  }
  const hoverShape = hoverShapeId === null ? null : (objects[hoverShapeId] ?? null);
  const bounds = selectionBounds(selectedShapes);
  // The selection visuals follow a running drag; the hover outline does not.
  const drawnBounds =
    bounds !== null && dragDelta !== null
      ? {
          x: bounds.x + dragDelta.dx,
          y: bounds.y + dragDelta.dy,
          width: bounds.width,
          height: bounds.height,
        }
      : bounds;
  const handleSize = HANDLE_SIZE / zoom;

  return (
    <svg
      className="pp-workspace-overlay"
      data-testid="viewport-overlay"
      viewBox={`${vbox.x} ${vbox.y} ${vbox.width} ${vbox.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <g className="pp-overlay-outlines">
        {selectedShapes.map((shape) => (
          <ShapeOutline
            key={shape.id}
            shape={shape}
            zoom={zoom}
            className="pp-overlay-outline"
            testId="selection-outline"
            offset={dragDelta}
          />
        ))}
      </g>
      {drawnBounds !== null ? (
        <g className="pp-overlay-bounds">
          <rect
            className="pp-overlay-bounds-box"
            x={drawnBounds.x}
            y={drawnBounds.y}
            width={drawnBounds.width}
            height={drawnBounds.height}
            strokeWidth={1 / zoom}
          />
          {handlePositions(drawnBounds).map((point, index) => (
            <rect
              key={index}
              className="pp-overlay-handle"
              x={point.x - handleSize / 2}
              y={point.y - handleSize / 2}
              width={handleSize}
              height={handleSize}
            />
          ))}
        </g>
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
