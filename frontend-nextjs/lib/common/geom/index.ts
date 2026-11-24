// Namespace barrel for the TypeScript mirror of app.common.geom.
//
// point and matrix both export inverse/multiply/transformPoint, so the
// modules stay namespaced instead of being flattened into one namespace.

export * as point from "./point";
export * as matrix from "./matrix";
export * as rect from "./rect";

export type { Point } from "./point";
export type { Matrix } from "./matrix";
export type { Rect, RectLike } from "./rect";
