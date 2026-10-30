// The workspace undo stack (F9.7): client-side entries of update-file
// changes, the CLJS app.main.data.workspace.undo port.
//
// The CLJS keeps :undo-changes and :redo-changes in the potok store and
// sends one update-file with the saved vector on undo/redo (never through
// the backend undo, which does not exist). This module keeps the pure part
// of that: the stack cursor, the inversion of one commit into its undo
// changes, and the local application of either direction over the JS model.
//
// Deviations from the CLJS original, documented:
// - The stack is per page load, not global across pages: the canvas owns it
//   and resets it on every load (a page switch reloads the model, so an
//   entry from another page could not apply its shapes locally). The CLJS
//   keeps one file-wide stack; that is a later slice if page switching
//   needs it.
// - There are no undo groups or transactions: every committed request is
//   one entry. The one exception is a layout reflow (F9.11): it trails the
//   attribute edit that asked for it as a second request, so mergeUndo
//   folds it into that edit and one user action stays one step.
// - Selection restore is tracked as before/after arrays; the after value is
//   captured when undo runs, so redo returns to the selection the user had
//   before undoing.

import { ZERO_UUID } from "@/lib/file-data";
import type {
  UpdateFileChange,
  UpdateFileSetOperation,
} from "@/lib/transit";
import { applyReparent } from "@/lib/workspace-move";
import { insertChildren } from "@/lib/workspace-order";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

// The CLJS MAX-UNDO-SIZE: the oldest entry drops off the front.
export const UNDO_LIMIT = 50;

export interface UndoEntry {
  // The committed changes, replayed on redo.
  changes: UpdateFileChange[];
  // The inverse changes, sent on undo.
  undoChanges: UpdateFileChange[];
  // The selection before the commit; restored on undo.
  selectionBefore: string[];
  // The selection to restore on redo; rewritten when the undo runs.
  selectionAfter: string[];
}

// The cursor points at the last applied entry (-1 when nothing is applied).
export interface UndoState {
  entries: UndoEntry[];
  index: number;
}

export function createUndoState(): UndoState {
  return { entries: [], index: -1 };
}

export function canUndo(state: UndoState): boolean {
  return state.index >= 0;
}

export function canRedo(state: UndoState): boolean {
  return state.index < state.entries.length - 1;
}

// Push one commit entry: the redo branch is dropped when the commit happens
// after an undo, and the stack is capped at UNDO_LIMIT (oldest first).
export function pushUndo(state: UndoState, entry: UndoEntry): UndoState {
  const kept = state.entries.slice(0, state.index + 1);
  kept.push(entry);
  const overflow = kept.length - UNDO_LIMIT;
  const entries = overflow > 0 ? kept.slice(overflow) : kept;
  return { entries, index: entries.length - 1 };
}

// Fold one commit into the entry just pushed (F9.11). A reflow arrives as a
// second update-file request after the attribute edit that caused it, but
// the user made one edit: undo must revert both. The redo changes append
// (the edit, then its reflow) and the undo changes prepend (the reflow
// first, then the edit), while the selection stays the one the first
// request captured. A stack without an entry to merge into simply pushes.
export function mergeUndo(state: UndoState, entry: UndoEntry): UndoState {
  if (state.index < 0) return pushUndo(state, entry);
  const current = state.entries[state.index];
  const merged: UndoEntry = {
    changes: [...current.changes, ...entry.changes],
    undoChanges: [...entry.undoChanges, ...current.undoChanges],
    selectionBefore: current.selectionBefore,
    selectionAfter: current.selectionAfter,
  };
  const entries = [...state.entries];
  entries[state.index] = merged;
  return { entries, index: state.index };
}

export interface UndoStep {
  state: UndoState;
  entry: UndoEntry;
}

// Move the cursor one entry back and return the entry to undo. The caller
// sends entry.undoChanges and only then commits the returned state.
export function undoStep(state: UndoState): UndoStep | null {
  if (state.index < 0) return null;
  return {
    state: { entries: state.entries, index: state.index - 1 },
    entry: state.entries[state.index],
  };
}

// Move the cursor one entry forward and return the entry to redo.
export function redoStep(state: UndoState): UndoStep | null {
  const next = state.index + 1;
  if (next >= state.entries.length) return null;
  return {
    state: { entries: state.entries, index: next },
    entry: state.entries[next],
  };
}

// The undo changes of one commit, derived from the model before the commit
// (the same shape the CLJS commit carries explicitly):
// - mod-obj: one set per redo operation, with the previous value; an
//   attribute the old shape does not carry (or carries as nil) inverts to a
//   nil val, which the backend set-shape-attr applies as a dissoc.
// - add-obj: a del-obj;
// - del-obj: the add-obj changes that re-create the deleted subtree;
// - mov-objects: one mov-objects per shape, back to its previous parent and
//   previous position.
// The changes are walked in reverse, so a commit that adds then modifies a
// shape is undone by deleting it last.
export function invertChanges(
  objects: WorkspaceObjects,
  changes: readonly UpdateFileChange[],
): UpdateFileChange[] {
  const inverted: UpdateFileChange[] = [];

  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index];
    switch (change.type) {
      case "mod-obj": {
        const shape = objects[change.id];
        if (shape === undefined || shape === null) break;
        const operations: UpdateFileSetOperation[] = [];
        for (let op = change.operations.length - 1; op >= 0; op -= 1) {
          const attr = change.operations[op].attr;
          // A missing (or nil) attribute inverts to a nil val, i.e. a
          // dissoc: the F9.3 companions add hide-in-viewer and
          // component-root this way, and their undo must remove them.
          const previous = shape[attr];
          const val = previous === undefined ? null : previous;
          operations.push({ type: "set", attr, val });
        }
        if (operations.length > 0) inverted.push({ ...change, operations });
        break;
      }
      case "add-obj":
        inverted.push({
          type: "del-obj",
          "page-id": change["page-id"],
          id: change.id,
        });
        break;
      case "del-obj":
        // The only F9 write that deletes is the empty text commit, and the
        // model before the commit still holds the snapshot: re-add it. A
        // delete takes the whole subtree, so every descendant comes back
        // too, each one after its parent.
        inverted.push(...restoreAdds(objects, change.id, change["page-id"]));
        break;
      case "add-page":
      case "mod-page":
      case "del-page":
        // The sidebar commits page changes outside the stack (F9.13,
        // lib/workspace-pages): applyUpdateChanges works over one page's
        // objects and could neither restore a deleted page nor re-add one to
        // the file, so a page change must never reach the inverse.
        throw new Error("workspace-undo: a page change has no model inverse");
      case "mov-objects": {
        // One change per shape, carrying the position it had in its
        // previous parent. A grouped append would lose the stacking when a
        // commit moved several shapes out of one parent (undoing [A,B,C,D]
        // minus B and D with one append would land them [A,C,B,D]);
        // ascending old-index order replays the removals in reverse.
        const entries: Array<{ id: string; parentId: string; index: number }> = [];
        for (const id of change.shapes) {
          const shape = objects[id];
          if (shape === undefined || shape === null) continue;
          const parentId = shape["parent-id"];
          if (typeof parentId !== "string") continue;
          const parent = objects[parentId];
          const siblings =
            parent !== undefined && parent !== null && Array.isArray(parent.shapes)
              ? parent.shapes
              : [];
          const at = siblings.indexOf(id);
          entries.push({ id, parentId, index: at < 0 ? siblings.length : at });
        }
        entries.sort((a, b) => {
          if (a.parentId !== b.parentId) return a.parentId < b.parentId ? -1 : 1;
          return a.index - b.index;
        });
        for (const item of entries) {
          inverted.push({
            type: "mov-objects",
            "page-id": change["page-id"],
            "parent-id": item.parentId,
            shapes: [item.id],
            index: item.index,
          });
        }
        break;
      }
    }
  }

  return inverted;
}

// The add-obj changes that restore one deleted shape: the shape itself at the
// index it held in the parent it was cut from, then its subtree (a child
// needs its parent to exist; the container's snapshot already lists it, so
// the backend add-shape leaves the children list alone).
function restoreAdds(
  objects: WorkspaceObjects,
  id: string,
  pageId: string,
): UpdateFileChange[] {
  const shape = objects[id];
  if (shape === undefined || shape === null) return [];

  const parentId =
    typeof shape["parent-id"] === "string" ? shape["parent-id"] : ZERO_UUID;
  const frameId =
    typeof shape["frame-id"] === "string" ? shape["frame-id"] : parentId;
  const parent = objects[parentId];
  const siblings =
    parent !== undefined && parent !== null && Array.isArray(parent.shapes)
      ? parent.shapes
      : [];
  const at = siblings.indexOf(id);

  const changes: UpdateFileChange[] = [
    {
      type: "add-obj",
      id,
      "page-id": pageId,
      "frame-id": frameId,
      "parent-id": parentId,
      index: at < 0 ? siblings.length : at,
      obj: { ...shape },
    },
  ];

  const children = Array.isArray(shape.shapes) ? shape.shapes : [];
  for (const childId of children) {
    changes.push(...restoreAdds(objects, String(childId), pageId));
  }
  return changes;
}

// The local mirror of process-changes over the JS model, used by undo and
// redo so both directions share one application path:
// - mod-obj: the set operations applied in order over a copy of the shape;
//   a nil val deletes the attribute (the backend process-operation :set
//   calls set-shape-attr, which dissocs on nil);
// - add-obj: the shape inserted under its parent, at the change index when
//   it carries one and at the tail otherwise;
// - del-obj: the shape and its subtree removed, detached from its parent;
// - mov-objects: applyReparent (insert into the new parent at the change
//   index or at the tail, rewrite the frame-id of the subtree, detach from
//   the old parent).
// Changes apply in order, like process-changes: a later index reads the
// children list left by the earlier changes.
// Shapes missing from the model are skipped: an entry never reaches across
// pages in this slice.
export function applyUpdateChanges(
  objects: WorkspaceObjects,
  changes: readonly UpdateFileChange[],
): WorkspaceObjects {
  let next = objects;

  for (const change of changes) {
    switch (change.type) {
      case "mod-obj": {
        const shape = next[change.id];
        if (shape === undefined || shape === null) break;
        const updated: WorkspaceShape = { ...shape };
        let changed = false;
        for (const operation of change.operations) {
          if (operation.val === null || operation.val === undefined) {
            if (!(operation.attr in updated)) continue;
            delete updated[operation.attr];
            changed = true;
          } else {
            updated[operation.attr] = operation.val;
            changed = true;
          }
        }
        if (changed) next = { ...next, [change.id]: updated };
        break;
      }
      case "add-obj": {
        const record = change.obj as Record<string, unknown>;
        const shape: WorkspaceShape = {
          ...record,
          id: change.id,
          type: typeof record.type === "string" ? record.type : "",
          "parent-id": change["parent-id"],
          "frame-id": change["frame-id"],
        };
        next = { ...next, [change.id]: shape };
        const parent = next[change["parent-id"]];
        if (parent !== undefined && parent !== null) {
          const children = Array.isArray(parent.shapes) ? parent.shapes : [];
          if (!children.includes(change.id)) {
            next = {
              ...next,
              [change["parent-id"]]: {
                ...parent,
                shapes:
                  typeof change.index === "number"
                    ? insertChildren(children, change.index, [change.id])
                    : [...children, change.id],
              },
            };
          }
        }
        break;
      }
      case "del-obj":
        next = deleteShape(next, change.id);
        break;
      case "mov-objects": {
        const roots = change.shapes.filter((id) => {
          const shape = next[id];
          return shape !== undefined && shape !== null;
        });
        if (roots.length > 0) {
          next = applyReparent(next, roots, change["parent-id"], change.index);
        }
        break;
      }
    }
  }

  return next;
}

// delete-shape: removes the subtree first, then detaches the id from its
// parent children list. The root (ZERO_UUID) is never a target of del-obj.
function deleteShape(objects: WorkspaceObjects, id: string): WorkspaceObjects {
  const shape = objects[id];
  if (shape === undefined || shape === null) return objects;

  let next = objects;
  const children = Array.isArray(shape.shapes) ? shape.shapes : [];
  for (const childId of children) next = deleteShape(next, String(childId));

  const parentId = shape["parent-id"];
  // The root itself is never deleted; a root-level shape still detaches
  // from the ZERO_UUID root frame's children.
  if (typeof parentId === "string" && id !== ZERO_UUID) {
    const parent = next[parentId];
    if (parent !== undefined && parent !== null && Array.isArray(parent.shapes)) {
      next = {
        ...next,
        [parentId]: { ...parent, shapes: parent.shapes.filter((child) => child !== id) },
      };
    }
  }

  if (next === objects) next = { ...objects };
  delete next[id];
  return next;
}
