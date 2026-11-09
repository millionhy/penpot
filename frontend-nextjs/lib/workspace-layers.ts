// Workspace layer tree (F9.4): the pure data behind the Layers panel.
//
// Port of the tree walk in app.main.ui.workspace.sidebar.layers. The CLJS
// layers-tree* and layer-item* build their row list with (conj (list) ...),
// which prepends each :shapes id, so every level renders the container's
// children in REVERSE array order (the topmost shape, i.e. the last id in
// :shapes, shows first). This module walks :shapes from the end so the tree
// comes out in the same display order the CLJS panel renders.
//
// The panel only renders the rows, so the traversal and the filter stay
// testable in vitest's node environment.
//
// Defensive rules that the CLJS gets from the resolved file:
// - a root child stays visible even when its parent-id points nowhere;
// - a child id missing from objects is skipped;
// - a cycle or a repeated id renders once, so the walk always terminates.
//
// Deviations from the CLJS original, documented:
// - Filtering is a name search only (the CLJS also searches variant-name
//   and, in dev builds, ids); this slice has no variants.
// - The filtered tree keeps the ancestors of each match rather than
//   reparenting the matches to the root (layers.cljs calc-reparented-
//   objects); the panel renders the real hierarchy.

import { ZERO_UUID } from "@/lib/file-data";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

export interface LayerNode {
  id: string;
  name: string;
  type: string;
  // Depth in the original tree; the filtered tree keeps the ancestors, so
  // the depth stays meaningful after filtering.
  depth: number;
  children: LayerNode[];
}

export interface LayerRow {
  node: LayerNode;
  depth: number;
}

// dm/name fallback: a blank or missing name uses the shape type.
function layerName(shape: WorkspaceShape): string {
  const name = typeof shape.name === "string" ? shape.name.trim() : "";
  return name || shape.type || "shape";
}

export function buildLayerTree(objects: WorkspaceObjects): LayerNode[] {
  const seen = new Set<string>([ZERO_UUID]);

  const build = (shape: WorkspaceShape, depth: number): LayerNode => {
    const children: LayerNode[] = [];
    const ids = shape.shapes ?? [];
    // Reverse array order: the last id in :shapes (the topmost shape) is
    // built first, matching the (conj (list)) prepending of the CLJS panel.
    for (let i = ids.length - 1; i >= 0; i--) {
      const childId = ids[i];
      if (seen.has(childId)) continue;
      const child = objects[childId];
      if (child === undefined || child === null) continue;
      seen.add(childId);
      children.push(build(child, depth + 1));
    }
    return {
      id: shape.id,
      name: layerName(shape),
      type: shape.type,
      depth,
      children,
    };
  };

  const root = objects[ZERO_UUID];
  const nodes: LayerNode[] = [];
  const rootIds = root?.shapes ?? [];
  for (let i = rootIds.length - 1; i >= 0; i--) {
    const id = rootIds[i];
    if (seen.has(id)) continue;
    const shape = objects[id];
    if (shape === undefined || shape === null) continue;
    seen.add(id);
    nodes.push(build(shape, 0));
  }
  return nodes;
}

function filterNodes(nodes: LayerNode[], query: string): LayerNode[] {
  const out: LayerNode[] = [];
  for (const node of nodes) {
    const children = filterNodes(node.children, query);
    const matches = node.name.toLowerCase().includes(query);
    if (!matches && children.length === 0) continue;
    out.push({ ...node, children });
  }
  return out;
}

// Case-insensitive name search; every ancestor of a match survives, and an
// empty query returns the input tree.
export function filterLayerTree(nodes: LayerNode[], query: string): LayerNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return nodes;
  return filterNodes(nodes, needle);
}

// The rows the panel renders: a collapsed node hides its descendants, while
// a filtered tree shows every remaining node regardless of the expanded
// set.
export function visibleLayerRows(
  nodes: LayerNode[],
  expanded: ReadonlySet<string>,
  filtered: boolean,
): LayerRow[] {
  const rows: LayerRow[] = [];
  const visit = (node: LayerNode): void => {
    rows.push({ node, depth: node.depth });
    if (filtered || expanded.has(node.id)) {
      for (const child of node.children) visit(child);
    }
  };
  for (const node of nodes) visit(node);
  return rows;
}
