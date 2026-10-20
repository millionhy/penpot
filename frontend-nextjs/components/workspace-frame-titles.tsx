"use client";

// The frame titles of the workspace overlay (F9.4): one label above the
// top-left edge of every visible top-level frame, the port of the
// frame-title* markup of viewport/widgets.cljs.
//
// The label lives inside the world-coordinate SVG. The group transform
// keeps the text at a constant screen size (scale 1/zoom) while the label
// geometry comes from lib/workspace-frame-titles. The overlay passes its
// selection down so a selected frame title takes the accent color.
//
// Deviations from the CLJS original, documented (AD10):
// - No inline rename, hover handlers, context menu or grid-edition icon;
//   the label is read-only and never takes pointer events, so clicking it
//   falls through to the canvas.
// - No icon and no id suffix in the label.

import { useMemo } from "react";

import {
  titleTransform,
  titleTransformUseWidth,
  topLevelFrames,
} from "@/lib/workspace-frame-titles";
import type { WorkspaceObjects } from "@/lib/workspace";

// The CLJS unselected frame-title color (not a token in this slice).
const UNSELECTED_COLOR = "#8f9da3";
const SELECTED_COLOR = "var(--color-accent-tertiary)";

export interface WorkspaceFrameTitlesProps {
  objects: WorkspaceObjects;
  selection: readonly string[];
  zoom: number;
  showFrameTitles: boolean;
}

export function WorkspaceFrameTitles({
  objects,
  selection,
  zoom,
  showFrameTitles,
}: WorkspaceFrameTitlesProps) {
  const selected = useMemo(() => new Set(selection), [selection]);

  const labels = useMemo(() => {
    const frames = topLevelFrames(objects);
    const out = [];
    for (const frame of frames) {
      if (frame.hidden === true) continue;
      const name = typeof frame.name === "string" ? frame.name.trim() : "";
      if (name === "") continue;
      const transform = titleTransform(frame, zoom);
      if (transform === null) continue;

      const side = titleTransformUseWidth(frame) ? frame.width : frame.height;
      const textWidth =
        typeof side === "number" && Number.isFinite(side)
          ? Math.max(0, side * zoom)
          : 0;
      const color = selected.has(frame.id) ? SELECTED_COLOR : UNSELECTED_COLOR;

      out.push(
        <g
          key={frame.id}
          className="pp-workspace-frame-title"
          data-testid="frame-title"
          data-frame-id={frame.id}
          transform={`rotate(${transform.angle} ${transform.pivotX} ${transform.pivotY}) scale(${transform.scale} ${transform.scale}) translate(${transform.translateX} ${transform.translateY})`}
        >
          <foreignObject
            className="pp-workspace-frame-title-wrapper"
            x={0}
            y={-11}
            width={textWidth}
            height={20}
          >
            <div
              className="pp-workspace-frame-title-label"
              style={{ color }}
              title={name}
            >
              {name}
            </div>
          </foreignObject>
        </g>,
      );
    }
    return out;
  }, [objects, selected, zoom]);

  return (
    <g
      className="pp-workspace-frame-titles"
      data-testid="frame-titles"
      style={{ visibility: showFrameTitles ? "visible" : "hidden" }}
    >
      {labels}
    </g>
  );
}
