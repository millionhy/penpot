// F9.11: the workspace face of the engine's geometry propagation (G4.6b).
//
// The layout reflow and the constraint spread live in the Rust renderer
// (shapes/modifiers.rs plus reflow_flex_layout / reflow_grid_layout); the
// shell only sends the transforms of the roots and applies the matrices the
// renderer returns. `engine/modifiers.ts` owns the packed input and output
// buffers, so this file only keeps the boolean `propagate` flag the workspace
// callers already speak.
//
// An IDENTITY matrix is not a no-op: the renderer turns it into a reflow mark
// ("We use the identity transform as a mark that a reflow is needed").

import {
  propagateModifiers as propagateEngineModifiers,
  type Matrix6,
  type SnapIgnoreAxis,
} from "@/lib/render-wasm/engine";
import type { WorkspaceApp } from "@/lib/render-wasm/workspace-app";

// One transform to propagate. `propagate` defaults to true, the "geometry
// root" case (kind :child in the CLJS caller); false marks a result the
// renderer already spread (kind :parent).
export interface PropagateEntry {
  readonly id: string;
  readonly matrix: Matrix6;
  readonly propagate?: boolean;
}

// Propagate the transforms of `entries` through the renderer tree and answer
// the matrix of every affected shape, keyed by id in the order the renderer
// reports. An empty entry list asks nothing of the renderer and returns an
// empty list without touching the wasm heap.
export function propagateModifiers(
  app: WorkspaceApp,
  entries: readonly PropagateEntry[],
  pixelPrecision = 0,
): Array<[string, Matrix6]> {
  if (entries.length === 0) return [];
  // PIXEL_PRECISION: 0 disabled, 1 both axes, 2 only-x, 3 only-y. The engine
  // takes the ignored axis instead, so 2 means "ignore y" and 3 "ignore x".
  const ignoreAxis: SnapIgnoreAxis =
    pixelPrecision === 2 ? "y" : pixelPrecision === 3 ? "x" : null;
  return propagateEngineModifiers(
    app.module,
    entries.map((entry) => ({
      id: entry.id,
      transform: entry.matrix,
      kind: entry.propagate === false ? "parent" : "child",
    })),
    pixelPrecision !== 0,
    ignoreAxis,
  );
}
