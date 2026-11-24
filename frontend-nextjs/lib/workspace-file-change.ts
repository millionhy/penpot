// The frontend half of app.common.files.changes (G5.3). The CLJS namespace
// handles every entity in a file; this shell consumes a narrower surface:
//
// - the shape changes the canvas applies (lib/workspace-undo);
// - the page changes that keep the sitemap file slice current (this module);
// - the structural check of an inbound socket change vector, so a malformed
//   broadcast becomes a reported payload error instead of a render crash.
//
// Unknown change types stay valid on purpose. Another client may commit a
// component, token or media change this shell does not mirror yet; the socket
// classification must keep those batches, and the appliers ignore the types
// they do not know.
//
// Deviations from changes.cljc, documented:
// - A repeated add-page is a no-op. process-change :add-page keeps the page
//   order but overwrites the pages-index entry, which would wipe a page the
//   local model already holds when a delivery repeats.
// - A mov-page for an id missing from :pages is ignored instead of inserting
//   the unknown id into the order.
// - Only the page entities are applied here. Components, colors, media,
//   tokens, guides and flows wait for the slices that consume them.

import { hexColorString } from "@/lib/common/color";
import {
  isMap,
  isSafeInt,
  isSafeNumber,
  isText,
  isUuid,
} from "@/lib/common/schema";
import type {
  UpdateFileAddPageChange,
  UpdateFileChange,
  UpdateFileModPageChange,
  UpdateFilePageChange,
} from "@/lib/transit";
import type { WorkspaceFile, WorkspacePageData, WorkspaceShape } from "@/lib/workspace";
import {
  emptyPage,
  withPageAdded,
  withPageDeleted,
  withPageModified,
  withPageMoved,
  type WorkspacePagePatch,
} from "@/lib/workspace-pages";

// token-name-validation-regex of app.common.types.token/schema:token-name.
const TOKEN_NAME_RX = /^[a-zA-Z0-9_-][a-zA-Z0-9$_-]*(\.[a-zA-Z0-9$_-]+)*$/;

const PAGE_CHANGE_TYPES = new Set([
  "add-page",
  "mod-page",
  "del-page",
  "mov-page",
]);

export function isPageChange(
  change: UpdateFileChange,
): change is UpdateFilePageChange {
  return PAGE_CHANGE_TYPES.has(change.type);
}

// --- Validation ------------------------------------------------------------

export interface ChangeValidationError {
  // -1 when the value itself is not a change vector.
  index: number;
  reason: string;
}

export type ChangeValidation =
  | { ok: true; changes: UpdateFileChange[] }
  | { ok: false; errors: ChangeValidationError[] };

// One pass over the whole vector, like process-changes verifying before it
// reduces. Every entry reports at most one error: the caller only needs the
// first reason to classify the message as malformed.
export function validateFileChanges(value: unknown): ChangeValidation {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      errors: [{ index: -1, reason: "the changes are not an array" }],
    };
  }

  const errors: ChangeValidationError[] = [];
  // An indexed loop, not forEach: a hole in the array is still a missing
  // change and must not slip through to the applier.
  for (let index = 0; index < value.length; index += 1) {
    const reason = validateChange(value[index]);
    if (reason !== null) errors.push({ index, reason });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, changes: value as UpdateFileChange[] };
}

function validateChange(value: unknown): string | null {
  if (!isMap(value)) return "the change is not a map";
  const type = value.type;
  if (typeof type !== "string" || type.length === 0) {
    return "the change carries no type";
  }

  switch (type) {
    case "add-obj":
      return (
        uuidError(value, "id") ??
        optionalUuidError(value, "page-id") ??
        optionalUuidError(value, "component-id") ??
        uuidError(value, "frame-id") ??
        optionalNullableUuidError(value, "parent-id") ??
        (isMap(value.obj) ? null : "obj must be a shape map") ??
        optionalIndexError(value)
      );
    case "mod-obj":
      return (
        optionalUuidError(value, "page-id") ??
        optionalUuidError(value, "component-id") ??
        uuidError(value, "id") ??
        operationsError(value.operations)
      );
    case "del-obj":
      return (
        uuidError(value, "id") ??
        optionalUuidError(value, "page-id") ??
        optionalUuidError(value, "component-id")
      );
    case "mov-objects": {
      if (!Array.isArray(value.shapes) || !value.shapes.every(isUuid)) {
        return "shapes must be an array of uuids";
      }
      return (
        optionalUuidError(value, "page-id") ??
        optionalUuidError(value, "component-id") ??
        uuidError(value, "parent-id") ??
        optionalIndexError(value)
      );
    }
    case "set-comment-thread-position": {
      const frameId = value["frame-id"];
      const position = value.position;
      if (frameId !== null && !isUuid(frameId)) {
        return "frame-id must be a uuid or null";
      }
      if (position !== null) {
        if (!isMap(position) || !isFiniteNumber(position.x) || !isFiniteNumber(position.y)) {
          return "position must be a point map or null";
        }
      }
      return uuidError(value, "page-id") ?? uuidError(value, "comment-thread-id");
    }
    case "add-page":
      return addPageError(value);
    case "mod-page":
      return modPageError(value);
    case "del-page":
      return uuidError(value, "id");
    case "mov-page":
      return uuidError(value, "id") ??
        (isSafeInt(value.index) ? null : "index must be a safe integer");
    default:
      // A change of a family this shell does not apply yet. Keep it in the
      // vector: the page filter and the appliers know how to skip it.
      return null;
  }
}

function uuidError(map: Record<string, unknown>, key: string): string | null {
  return isUuid(map[key]) ? null : `${key} must be a uuid`;
}

// page-id and component-id are optional in schema:change: a shape change may
// target a page or a component objects map. The shell applies only the page
// branch, so a component-targeted change is validated and then skipped.
function optionalUuidError(
  map: Record<string, unknown>,
  key: string,
): string | null {
  if (map[key] === undefined) return null;
  return uuidError(map, key);
}

function optionalNullableUuidError(
  map: Record<string, unknown>,
  key: string,
): string | null {
  if (map[key] === undefined || map[key] === null) return null;
  return uuidError(map, key);
}

function optionalIndexError(map: Record<string, unknown>): string | null {
  if (map.index === undefined || map.index === null) return null;
  return isSafeInt(map.index) ? null : "index must be a safe integer";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function operationsError(value: unknown): string | null {
  if (!Array.isArray(value)) return "operations must be an array";
  for (const operation of value) {
    if (!isMap(operation)) return "a mod-obj operation is not a map";
    if (typeof operation.type !== "string" || operation.type.length === 0) {
      return "a mod-obj operation carries no type";
    }
    // assign / set-touched / set-remote-synced are component-sync operations
    // the shell does not apply yet; only the set operation is read here.
    if (operation.type === "set" && !isText(operation.attr)) {
      return "a set operation needs an attr";
    }
  }
  return null;
}

function addPageError(map: Record<string, unknown>): string | null {
  if (!isUuid(map.id)) return "id must be a uuid";
  if (map.page !== undefined) {
    if (!isMap(map.page)) return "page must be a page map";
    if (map.page.id !== map.id) return "page id must match the change id";
    if (!isMap(map.page.objects)) return "page needs an objects map";
    return null;
  }
  if (typeof map.name !== "string") return "add-page needs a name or a page";
  return null;
}

function modPageError(map: Record<string, unknown>): string | null {
  if (!isUuid(map.id)) return "id must be a uuid";

  const has = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(map, key);
  const present = [
    "name",
    "background",
    "background-token",
    "pixel-grid-color",
    "pixel-grid-opacity",
  ].filter(has);
  if (present.length === 0) return "mod-page needs at least one attribute";

  if (has("name") && typeof map.name !== "string") {
    return "name must be a string";
  }
  if (has("background") && map.background !== null && !hexColorString(map.background)) {
    return "background must be a hex color or null";
  }
  if (
    has("background-token") &&
    map["background-token"] !== null &&
    (typeof map["background-token"] !== "string" || !TOKEN_NAME_RX.test(map["background-token"]))
  ) {
    return "background-token must be a token name or null";
  }
  if (
    has("pixel-grid-color") &&
    map["pixel-grid-color"] !== null &&
    !hexColorString(map["pixel-grid-color"])
  ) {
    return "pixel-grid-color must be a hex color or null";
  }
  if (
    has("pixel-grid-opacity") &&
    map["pixel-grid-opacity"] !== null &&
    !isSafeNumber(map["pixel-grid-opacity"])
  ) {
    return "pixel-grid-opacity must be a safe number or null";
  }
  return null;
}

// --- Page application ------------------------------------------------------

export interface ApplyPageChangesOptions {
  // The root frame of the open page. An add-page with only {id, name} needs
  // one to build the same empty page the backend builds. Without it the
  // template of emptyPage applies.
  root?: WorkspaceShape | null;
}

// Applies the page-level changes in wire order over the file model. Nothing
// here touches a page's objects map, so a rename or a page order change
// leaves the canvas alone. A background edit of the open page does change
// the canvas background key and reloads that page (the engine needs the new
// color); deleting the open page moves the selection to another page.
export function applyPageChanges(
  file: WorkspaceFile,
  changes: readonly UpdateFilePageChange[],
  options: ApplyPageChangesOptions = {},
): WorkspaceFile {
  let next = file;

  for (const change of changes) {
    switch (change.type) {
      case "add-page": {
        const page = resolveAddedPage(change, options.root);
        if (page !== null) next = withPageAdded(next, page);
        break;
      }
      case "mod-page":
        next = withPageModified(next, change.id, pagePatch(change));
        break;
      case "del-page":
        next = withPageDeleted(next, change.id);
        break;
      case "mov-page":
        next = withPageMoved(next, change.id, change.index);
        break;
    }
  }

  return next;
}

function resolveAddedPage(
  change: UpdateFileAddPageChange,
  root: WorkspaceShape | null | undefined,
): WorkspacePageData | null {
  if (isMap(change.page)) {
    if (change.page.id !== change.id || !isMap(change.page.objects)) return null;
    return change.page as unknown as WorkspacePageData;
  }
  if (typeof change.name === "string") {
    return emptyPage(change.id, change.name, root ?? null);
  }
  return null;
}

// The patch keeps only the keys the change carries, so withPageModified can
// tell an absent attribute (keep) from an explicit null (remove).
function pagePatch(change: UpdateFileModPageChange): WorkspacePagePatch {
  const patch: WorkspacePagePatch = {};
  const has = (key: keyof UpdateFileModPageChange): boolean =>
    Object.prototype.hasOwnProperty.call(change, key);

  if (has("name")) patch.name = change.name;
  if (has("background")) patch.background = change.background;
  if (has("background-token")) patch["background-token"] = change["background-token"];
  if (has("pixel-grid-color")) patch["pixel-grid-color"] = change["pixel-grid-color"];
  if (has("pixel-grid-opacity")) {
    patch["pixel-grid-opacity"] = change["pixel-grid-opacity"];
  }
  return patch;
}
