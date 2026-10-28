// Plugin shape proxy (F7.4). Port of app.plugins.shape/shape-proxy: the
// object a plugin receives for one shape, with the reads that resolve
// against the live page model on every access and the writes that commit
// through the workspace bridge.
//
// Registered deviations from the CLJS:
//   - the proxy is a class, not a obj/reify; the private $ fields are plain
//     own properties instead of non-enumerable accessors,
//   - the writes commit asynchronously and report a failure on the console
//     (the CLJS emits a store event and returns at once, which the plugin
//     cannot observe either),
//   - name sets the attribute only; the CLJS rename-shape-or-variant also
//     rewrites the children labels of a group with the new path,
//   - flipX / flipY write the stored flip attribute; the CLJS flips the
//     geometry through flip-horizontal-selected,
//   - borderRadius* validate and then write r1..r4; the CLJS goes through
//     the corner helpers, which clamp the value to the shape size,
//   - resize / rotate write geometry only; the CLJS also switches a layout
//     child to fixed sizing before a resize,
//   - boardX / boardY read the same parent origin the CLJS getter reads (its
//     setter reads :frame-id instead, which is the same parent for every
//     shape but a direct root child),
//   - fills and strokes expose live element proxies over the solid color
//     attributes; gradients, images and the library color refs are not
//     modelled in this slice and answer undefined (a write reports the
//     invalid value),
//   - remove, clone, appendChild, insertChild, the layout and component
//     methods, the text range, the plugin data and the interaction list wait
//     for the slices that bring the incremental delete, the layout engine and
//     the component model: each throws a named error instead of silently
//     doing nothing.
//
// The proxy never caches the shape: every read asks the bridge and the store
// (u/proxy->shape), so a commit from another plugin or the user shows up on
// the next access.

import { checkPluginPermission } from "@/lib/plugins";
import { notValid, validNonNegativeNumber, validNumber } from "@/lib/plugin-validation";
import { boundsOf } from "@/lib/workspace-align";
import {
  liveFile,
  liveObjects,
  livePageId,
  requireWorkspaceBridge,
} from "@/lib/workspace-bridge";
import { selrectOf } from "@/lib/workspace-geometry";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import { ZERO_UUID } from "@/lib/file-data";

// The mark that tells a shape proxy from any other object a plugin holds
// (obj/type-of? "ShapeProxy" in the CLJS). A WeakSet keeps the mark off the
// proxy itself, so the members a plugin iterates stay the API ones.
const shapeProxies = new WeakSet<object>();

// The shape types getChildren and appendChild accept (cfh/frame-shape?,
// group-shape?, svg-raw-shape?, bool-shape?).
const CONTAINER_TYPES: ReadonlySet<string> = new Set(["frame", "group", "svg-raw", "bool"]);

// format/shape-type: the plugin-facing name of a stored type.
export function pluginShapeType(type: unknown): string {
  switch (type) {
    case "frame":
      return "board";
    case "rect":
      return "rectangle";
    case "circle":
      return "ellipse";
    case "bool":
      return "boolean";
    default:
      return typeof type === "string" ? type : "";
  }
}

// The horizontal and vertical constraint sets of cts/horizontal-constraint-
// types and cts/vertical-constraint-types, with the plugin-facing name of
// each value.
export const HORIZONTAL_CONSTRAINTS: readonly string[] = [
  "left",
  "right",
  "leftright",
  "center",
  "scale",
];

export const VERTICAL_CONSTRAINTS: readonly string[] = [
  "top",
  "bottom",
  "topbottom",
  "center",
  "scale",
];

// The stored blend modes; the plugin value is the stored keyword name.
export function validBlendMode(value: string): boolean {
  return BLEND_MODE_VALUES.has(value);
}

const BLEND_MODE_VALUES: ReadonlySet<string> = new Set([
  "normal",
  "darken",
  "multiply",
  "color-burn",
  "lighten",
  "screen",
  "color-dodge",
  "overlay",
  "soft-light",
  "hard-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);

// The interface the runtime hands to plugin code. Kept loose on purpose: a
// plugin reads and writes members by name, and the CLJS contract has no
// static shape either.
export type PluginShapeProxy = Record<string, unknown>;

const WRITE_DENIED = "Plugin doesn't have 'content:write' permission";
const NOT_ACTIVE = "Cannot modify a page that is not currently active";

function shapeProxyOf(value: unknown): ShapeProxy | null {
  if (value === null || typeof value !== "object") return null;
  return shapeProxies.has(value) ? (value as ShapeProxy) : null;
}

export function isShapeProxy(value: unknown): value is PluginShapeProxy {
  return shapeProxyOf(value) !== null;
}

// The id a proxy stands for, for the callers that build an id list out of a
// plugin argument (the selection setter, zoomIntoView, align).
export function shapeProxyId(value: unknown): string | null {
  return shapeProxyOf(value)?.$id ?? null;
}

// The page a proxy was minted for; a write never crosses pages.
export function shapeProxyPage(value: unknown): string | null {
  return shapeProxyOf(value)?.$page ?? null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function numberAt(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The live objects of the page a proxy was minted for; null once the file
// unloads or another page opens.
function objectsOf(pageId: string): WorkspaceObjects | null {
  if (livePageId() !== pageId) return null;
  return liveObjects();
}

function shapeOf(pageId: string, id: string): WorkspaceShape | null {
  const objects = objectsOf(pageId);
  if (objects === null) return null;
  const shape = objects[id];
  return shape === undefined || shape === null ? null : shape;
}

// The painted origin: the top-left of the points bounding box
// (grc/points->rect).
function originOf(shape: WorkspaceShape): { x: number; y: number } | null {
  const box = boundsOf(shape);
  return box === null ? null : { x: box.x, y: box.y };
}

function parentOf(
  objects: WorkspaceObjects,
  shape: WorkspaceShape,
): { parent: WorkspaceShape | null; parentId: string | null } {
  const parentId = shape["parent-id"];
  if (typeof parentId !== "string") return { parent: null, parentId: null };
  const parent = objects[parentId];
  return {
    parent: parent === undefined || parent === null ? null : parent,
    parentId,
  };
}

// The stored solid color records a plugin may write. A null answer means the
// value is not an array of records (the caller reports it).
function recordList(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  const out: Record<string, unknown>[] = [];
  for (const item of value) {
    const record = recordOf(item);
    if (record === null) return null;
    out.push(record);
  }
  return out;
}

const FILL_KEYS: Record<string, string> = {
  fillColor: "fill-color",
  fillOpacity: "fill-opacity",
  fillColorRefFile: "fill-color-ref-file",
  fillColorRefId: "fill-color-ref-id",
  fillOpacityRefFile: "fill-opacity-ref-file",
  fillOpacityRefId: "fill-opacity-ref-id",
};

const STROKE_KEYS: Record<string, string> = {
  strokeColor: "stroke-color",
  strokeOpacity: "stroke-opacity",
  strokeStyle: "stroke-style",
  strokeWidth: "stroke-width",
  strokeAlignment: "stroke-alignment",
  strokeCapStart: "stroke-cap-start",
  strokeCapEnd: "stroke-cap-end",
  strokeColorRefFile: "stroke-color-ref-file",
  strokeColorRefId: "stroke-color-ref-id",
};

// The camelCase view of one stored record, with the writes going to the
// caller's commit. The CLJS fill-proxy / stroke-proxy behave the same: the
// element mutates an atom that holds the list and asks the shape to commit
// the whole list on every write.
function liveElement(
  record: Record<string, unknown>,
  keys: Record<string, string>,
  onChange: (next: Record<string, unknown>) => void,
): Record<string, unknown> {
  const state = { ...record };
  const target: Record<string, unknown> = {};
  for (const [camel, stored] of Object.entries(keys)) {
    Object.defineProperty(target, camel, {
      enumerable: true,
      get: () => state[stored],
      set: (value: unknown) => {
        state[stored] = value;
        onChange({ ...state });
      },
    });
  }
  return target;
}

// The stored list from a plugin value: accepts the live proxies (camelCase
// reads) and the stored kebab-case records, so a round trip through the
// getter and back keeps working.
function storedList(
  value: unknown,
  keys: Record<string, string>,
): Record<string, unknown>[] | null {
  const list = recordList(value);
  if (list === null) return null;
  return list.map((entry) => {
    const stored: Record<string, unknown> = {};
    for (const [camel, name] of Object.entries(keys)) {
      const camelValue = entry[camel];
      const kebabValue = entry[name];
      if (camelValue !== undefined) stored[name] = camelValue;
      else if (kebabValue !== undefined) stored[name] = kebabValue;
    }
    // A record the caller built from the stored form may carry attributes
    // this slice does not model; keep them so a fills write never drops the
    // refs of a paint the panel set.
    for (const [name, storedValue] of Object.entries(entry)) {
      if (!(name in stored) && !(name in keys)) stored[name] = storedValue;
    }
    return stored;
  });
}

function isValidFills(list: readonly Record<string, unknown>[]): boolean {
  for (const fill of list) {
    const color = fill["fill-color"];
    if (color !== undefined && typeof color !== "string") return false;
    const opacity = fill["fill-opacity"];
    if (opacity !== undefined && !validNonNegativeNumber(opacity)) return false;
  }
  return true;
}

function isValidStrokes(list: readonly Record<string, unknown>[]): boolean {
  for (const stroke of list) {
    const color = stroke["stroke-color"];
    if (color !== undefined && typeof color !== "string") return false;
    const opacity = stroke["stroke-opacity"];
    if (opacity !== undefined && !validNonNegativeNumber(opacity)) return false;
    const width = stroke["stroke-width"];
    if (width !== undefined && !validNonNegativeNumber(width)) return false;
    for (const name of ["stroke-style", "stroke-alignment", "stroke-cap-start", "stroke-cap-end"]) {
      const value = stroke[name];
      if (value !== undefined && typeof value !== "string") return false;
    }
  }
  return true;
}

// One shape proxy. The constructor takes the plugin id, the page the proxy
// was minted for (u/proxy->shape's $page) and the shape id.
class ShapeProxy {
  readonly $plugin: string;
  readonly $id: string;
  readonly $page: string;

  constructor(pluginId: string, pageId: string, id: string) {
    this.$plugin = pluginId;
    this.$id = id;
    this.$page = pageId;
    shapeProxies.add(this);
  }

  // The file the open page belongs to; null once the file unloads.
  get $file(): string | null {
    return liveFile()?.id ?? null;
  }

  private shape(): WorkspaceShape | null {
    return shapeOf(this.$page, this.$id);
  }

  private objects(): WorkspaceObjects | null {
    return objectsOf(this.$page);
  }

  // Whether a write may run: the page the proxy was minted for must still be
  // the open page (u/page-active?).
  private active(): boolean {
    return livePageId() === this.$page;
  }

  // --- Validation helpers -------------------------------------------------

  private notValidOn(code: string, value: unknown): null {
    return notValid(this.$plugin, code, value);
  }

  private deny(code: string): null {
    return notValid(this.$plugin, code, WRITE_DENIED);
  }

  private inactive(code: string): null {
    return notValid(this.$plugin, code, NOT_ACTIVE);
  }

  // The gate every write shares: permission, then the open page. Returns
  // true when the write may proceed.
  private canWrite(code: string): boolean {
    if (!checkPluginPermission(this.$plugin, "content:write")) {
      this.deny(code);
      return false;
    }
    if (!this.active()) {
      this.inactive(code);
      return false;
    }
    return true;
  }

  // A fire-and-forget commit: the plugin API is synchronous, so the answer
  // lands on the console. The CLJS emits and also answers at once.
  private commit(code: string, run: () => Promise<boolean>): void {
    if (!this.canWrite(code)) return;
    run().catch((cause: unknown) => {
      console.error(`[PENPOT PLUGIN] '${code}' failed`, cause);
    });
  }

  private setAttr(code: string, attrs: Record<string, unknown>): void {
    this.commit(code, () =>
      requireWorkspaceBridge(code).updateShapeAttrs(this.$id, attrs),
    );
  }

  private setGeometry(code: string, target: Record<string, number>): void {
    this.commit(code, () =>
      requireWorkspaceBridge(code).updateShapeGeometry(this.$id, target),
    );
  }

  // --- Identity -----------------------------------------------------------

  get id(): string {
    return this.$id;
  }

  get type(): string {
    const shape = this.shape();
    return shape === null ? "" : pluginShapeType(shape.type);
  }

  get name(): string | undefined {
    return this.shape()?.name;
  }

  set name(value: unknown) {
    const text = typeof value === "string" ? value.trim() : null;
    const valid =
      text !== null && text.length > 0 && !text.endsWith("/");
    if (!valid) {
      this.notValidOn("name", value);
      return;
    }
    this.setAttr("name", { name: text });
  }

  // --- Flags --------------------------------------------------------------

  get blocked(): boolean {
    return this.shape()?.blocked === true;
  }

  set blocked(value: unknown) {
    if (typeof value !== "boolean") {
      this.notValidOn("blocked", value);
      return;
    }
    this.setAttr("blocked", { blocked: value });
  }

  get hidden(): boolean {
    return this.shape()?.hidden === true;
  }

  set hidden(value: unknown) {
    if (typeof value !== "boolean") {
      this.notValidOn("hidden", value);
      return;
    }
    this.setAttr("hidden", { hidden: value });
  }

  get visible(): boolean {
    return this.shape()?.hidden !== true;
  }

  set visible(value: unknown) {
    if (typeof value !== "boolean") {
      this.notValidOn("visible", value);
      return;
    }
    this.setAttr("visible", { hidden: !value });
  }

  get proportionLock(): boolean {
    return this.shape()?.["proportion-lock"] === true;
  }

  set proportionLock(value: unknown) {
    if (typeof value !== "boolean") {
      this.notValidOn("proportionLock", value);
      return;
    }
    this.setAttr("proportionLock", { "proportion-lock": value });
  }

  get fixedWhenScrolling(): boolean {
    return this.shape()?.["fixed-scroll"] === true;
  }

  set fixedWhenScrolling(value: unknown) {
    if (typeof value !== "boolean") {
      this.notValidOn("fixedWhenScrolling", value);
      return;
    }
    // The CLJS setter skips the page-active check for this one.
    if (!checkPluginPermission(this.$plugin, "content:write")) {
      this.deny("fixedWhenScrolling");
      return;
    }
    this.setAttr("fixedWhenScrolling", { "fixed-scroll": value });
  }

  get constraintsHorizontal(): string | undefined {
    return this.shape()?.["constraints-h"] as string | undefined;
  }

  set constraintsHorizontal(value: unknown) {
    if (typeof value !== "string" || !HORIZONTAL_CONSTRAINTS.includes(value)) {
      this.notValidOn("constraintsHorizontal", value);
      return;
    }
    this.setAttr("constraintsHorizontal", { "constraints-h": value });
  }

  get constraintsVertical(): string | undefined {
    return this.shape()?.["constraints-v"] as string | undefined;
  }

  set constraintsVertical(value: unknown) {
    if (typeof value !== "string" || !VERTICAL_CONSTRAINTS.includes(value)) {
      this.notValidOn("constraintsVertical", value);
      return;
    }
    this.setAttr("constraintsVertical", { "constraints-v": value });
  }

  // --- Style --------------------------------------------------------------

  get opacity(): number | undefined {
    const value = this.shape()?.opacity;
    return typeof value === "number" ? value : undefined;
  }

  set opacity(value: unknown) {
    if (!validNumber(value) || value < 0 || value > 1) {
      this.notValidOn("opacity", value);
      return;
    }
    this.setAttr("opacity", { opacity: value });
  }

  get blendMode(): string {
    const value = this.shape()?.["blend-mode"];
    return typeof value === "string" ? value : "normal";
  }

  set blendMode(value: unknown) {
    if (typeof value !== "string" || !validBlendMode(value)) {
      this.notValidOn("blendMode", value);
      return;
    }
    this.setAttr("blendMode", { "blend-mode": value });
  }

  // borderRadius sets the four corners (ctsr/set-radius-to-all-corners).
  get borderRadius(): number | undefined {
    const value = this.shape()?.r1;
    return typeof value === "number" ? value : undefined;
  }

  set borderRadius(value: unknown) {
    if (!validNonNegativeNumber(value)) {
      this.notValidOn("borderRadius", value);
      return;
    }
    this.setAttr("borderRadius", { r1: value, r2: value, r3: value, r4: value });
  }

  get borderRadiusTopLeft(): number | undefined {
    return this.radius("r1");
  }

  set borderRadiusTopLeft(value: unknown) {
    this.setRadius("borderRadiusTopLeft", "r1", value);
  }

  get borderRadiusTopRight(): number | undefined {
    return this.radius("r2");
  }

  set borderRadiusTopRight(value: unknown) {
    this.setRadius("borderRadiusTopRight", "r2", value);
  }

  get borderRadiusBottomRight(): number | undefined {
    return this.radius("r3");
  }

  set borderRadiusBottomRight(value: unknown) {
    this.setRadius("borderRadiusBottomRight", "r3", value);
  }

  get borderRadiusBottomLeft(): number | undefined {
    return this.radius("r4");
  }

  set borderRadiusBottomLeft(value: unknown) {
    this.setRadius("borderRadiusBottomLeft", "r4", value);
  }

  private radius(corner: string): number | undefined {
    const value = this.shape()?.[corner];
    return typeof value === "number" ? value : undefined;
  }

  private setRadius(code: string, corner: string, value: unknown): void {
    if (!validNonNegativeNumber(value)) {
      this.notValidOn(code, value);
      return;
    }
    this.setAttr(code, { [corner]: value });
  }

  get fills(): unknown[] {
    const fills = this.shape()?.fills;
    const list = Array.isArray(fills) ? fills : [];
    return this.formatPaintList("fills", list, FILL_KEYS);
  }

  set fills(value: unknown) {
    this.commitPaints("fills", value, FILL_KEYS, isValidFills);
  }

  get strokes(): unknown[] {
    const strokes = this.shape()?.strokes;
    const list = Array.isArray(strokes) ? strokes : [];
    return this.formatPaintList("strokes", list, STROKE_KEYS);
  }

  set strokes(value: unknown) {
    this.commitPaints("strokes", value, STROKE_KEYS, isValidStrokes);
  }

  // The live element list: every element write commits the whole list, like
  // the CLJS fill-proxy / stroke-proxy do.
  private formatPaintList(
    code: string,
    list: readonly unknown[],
    keys: Record<string, string>,
  ): unknown[] {
    const out: unknown[] = [];
    for (const item of list) {
      const record = recordOf(item);
      if (record === null) continue;
      // The index is captured before the push: the callback runs later, when
      // out already holds every element.
      const index = out.length;
      out.push(
        liveElement(record, keys, (next) => {
          const current = Array.isArray(this.shape()?.[code])
            ? (this.shape()?.[code] as unknown[])
            : [];
          const updated = [...current];
          updated[index] = next;
          this.commit(code, () =>
            requireWorkspaceBridge(code).updateShapeAttrs(this.$id, {
              [code]: updated,
            }),
          );
        }),
      );
    }
    return out;
  }

  private commitPaints(
    code: string,
    value: unknown,
    keys: Record<string, string>,
    validate: (list: readonly Record<string, unknown>[]) => boolean,
  ): void {
    const list = storedList(value, keys);
    if (list === null || !validate(list)) {
      this.notValidOn(code, value);
      return;
    }
    this.setAttr(code, { [code]: list });
  }

  // --- Geometry -----------------------------------------------------------

  get x(): number | undefined {
    const shape = this.shape();
    return shape === null ? undefined : originOf(shape)?.x;
  }

  set x(value: unknown) {
    if (!validNumber(value)) {
      this.notValidOn("x", value);
      return;
    }
    this.setGeometry("x", { x: value });
  }

  get y(): number | undefined {
    const shape = this.shape();
    return shape === null ? undefined : originOf(shape)?.y;
  }

  set y(value: unknown) {
    if (!validNumber(value)) {
      this.notValidOn("y", value);
      return;
    }
    this.setGeometry("y", { y: value });
  }

  get parentX(): number | undefined {
    return this.relativePosition("x");
  }

  set parentX(value: unknown) {
    this.setRelativePosition("parentX", "x", value);
  }

  get parentY(): number | undefined {
    return this.relativePosition("y");
  }

  set parentY(value: unknown) {
    this.setRelativePosition("parentY", "y", value);
  }

  get boardX(): number | undefined {
    return this.relativePosition("x");
  }

  set boardX(value: unknown) {
    this.setRelativePosition("boardX", "x", value);
  }

  get boardY(): number | undefined {
    return this.relativePosition("y");
  }

  set boardY(value: unknown) {
    this.setRelativePosition("boardY", "y", value);
  }

  private relativePosition(axis: "x" | "y"): number | undefined {
    const shape = this.shape();
    const objects = this.objects();
    if (shape === null || objects === null) return undefined;
    const origin = originOf(shape);
    const { parent } = parentOf(objects, shape);
    if (origin === null || parent === null) return undefined;
    const parentOrigin = originOf(parent);
    return parentOrigin === null ? undefined : origin[axis] - parentOrigin[axis];
  }

  private setRelativePosition(
    code: string,
    axis: "x" | "y",
    value: unknown,
  ): void {
    if (!validNumber(value)) {
      this.notValidOn(code, value);
      return;
    }
    const shape = this.shape();
    const objects = this.objects();
    if (shape === null || objects === null) return;
    const { parent } = parentOf(objects, shape);
    if (parent === null) return;
    const parentOrigin = originOf(parent);
    if (parentOrigin === null) return;
    this.setGeometry(code, { [axis]: parentOrigin[axis] + value });
  }

  get width(): number | undefined {
    const shape = this.shape();
    if (shape === null) return undefined;
    return selrectOf(shape)?.width;
  }

  get height(): number | undefined {
    const shape = this.shape();
    if (shape === null) return undefined;
    return selrectOf(shape)?.height;
  }

  get bounds(): { x: number; y: number; width: number; height: number } | undefined {
    const shape = this.shape();
    if (shape === null) return undefined;
    const box = boundsOf(shape);
    return box === null
      ? undefined
      : { x: box.x, y: box.y, width: box.width, height: box.height };
  }

  get center(): { x: number; y: number } | undefined {
    const box = this.bounds;
    return box === undefined
      ? undefined
      : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  get rotation(): number {
    const value = this.shape()?.rotation;
    return typeof value === "number" ? value : 0;
  }

  // A write turns the absolute angle into the delta increase-rotation takes.
  set rotation(value: unknown) {
    if (!validNumber(value)) {
      this.notValidOn("rotation", value);
      return;
    }
    this.setGeometry("rotation", { rotation: this.rotation + value });
  }

  get flipX(): boolean {
    return this.shape()?.["flip-x"] === true;
  }

  set flipX(value: unknown) {
    if (typeof value !== "boolean") {
      this.notValidOn("flipX", value);
      return;
    }
    this.setAttr("flipX", { "flip-x": value });
  }

  get flipY(): boolean {
    return this.shape()?.["flip-y"] === true;
  }

  set flipY(value: unknown) {
    if (typeof value !== "boolean") {
      this.notValidOn("flipY", value);
      return;
    }
    this.setAttr("flipY", { "flip-y": value });
  }

  // --- Tree ---------------------------------------------------------------

  get parent(): PluginShapeProxy | null {
    const shape = this.shape();
    const objects = this.objects();
    if (shape === null || objects === null) return null;
    if (this.$id === ZERO_UUID) return null;
    const { parentId } = parentOf(objects, shape);
    if (parentId === null) return null;
    return new ShapeProxy(this.$plugin, this.$page, parentId) as unknown as PluginShapeProxy;
  }

  get parentIndex(): number {
    const shape = this.shape();
    const objects = this.objects();
    if (shape === null || objects === null) return 0;
    if (this.$id === ZERO_UUID) return 0;
    const { parent } = parentOf(objects, shape);
    const children = parent !== null && Array.isArray(parent.shapes) ? parent.shapes : [];
    const index = children.indexOf(this.$id);
    return index < 0 ? 0 : index;
  }

  // getChildren: only the containers of cfh/frame-shape? and its siblings.
  getChildren(): PluginShapeProxy[] {
    const shape = this.shape();
    if (shape === null) return [];
    if (!CONTAINER_TYPES.has(shape.type)) {
      this.notValidOn("getChildren", shape.type);
      return [];
    }
    const objects = this.objects();
    if (objects === null) return [];
    const children = Array.isArray(shape.shapes) ? shape.shapes : [];
    const out: PluginShapeProxy[] = [];
    for (const childId of children) {
      const child = objects[childId];
      if (child === undefined || child === null) continue;
      out.push(
        new ShapeProxy(this.$plugin, this.$page, String(childId)) as unknown as PluginShapeProxy,
      );
    }
    return out;
  }

  // --- Methods ------------------------------------------------------------

  // resize: update-dimensions on both axes, one commit.
  resize(width: unknown, height: unknown): void {
    if (!validNumber(width) || width <= 0) {
      this.notValidOn("resize", width);
      return;
    }
    if (!validNumber(height) || height <= 0) {
      this.notValidOn("resize", height);
      return;
    }
    this.setGeometry("resize", { width, height });
  }

  // rotate: increase-rotation with the angle as a delta, around the shape
  // center. A custom center is not supported by the geometry command (it
  // always turns around the selrect center), so a caller that passes one
  // gets the invalid-value report instead of a silent wrong pivot.
  rotate(angle: unknown, center?: unknown): void {
    if (!validNumber(angle)) {
      this.notValidOn("rotate-angle", angle);
      return;
    }
    if (center !== undefined && center !== null) {
      const point = recordOf(center);
      const x = point === null ? null : numberAt(point, "x");
      const y = point === null ? null : numberAt(point, "y");
      if (x === null || y === null) {
        this.notValidOn("rotate-center", center);
        return;
      }
      if (x !== this.center?.x || y !== this.center?.y) {
        this.notValidOn("rotate-center", center);
        return;
      }
    }
    this.setGeometry("rotate", { rotation: this.rotation + angle });
  }

  // --- Deferred surface ---------------------------------------------------

  private pending(method: string): never {
    throw new Error(
      `[PENPOT PLUGIN] '${method}' needs the shape structure editor, which is not available yet`,
    );
  }

  remove(): never {
    return this.pending("remove");
  }

  clone(): never {
    return this.pending("clone");
  }

  appendChild(): never {
    return this.pending("appendChild");
  }

  insertChild(): never {
    return this.pending("insertChild");
  }

  setParentIndex(): never {
    return this.pending("setParentIndex");
  }

  bringForward(): never {
    return this.pending("bringForward");
  }

  sendBackward(): never {
    return this.pending("sendBackward");
  }

  bringToFront(): never {
    return this.pending("bringToFront");
  }

  sendToBack(): never {
    return this.pending("sendToBack");
  }

  getPluginData(): never {
    return this.pending("getPluginData");
  }

  setPluginData(): never {
    return this.pending("setPluginData");
  }
}

export function createShapeProxy(
  pluginId: string,
  pageId: string,
  id: string,
): PluginShapeProxy {
  return new ShapeProxy(pluginId, pageId, id) as unknown as PluginShapeProxy;
}
