// Unit tests for the component predicates and walks of lib/workspace-component
// (F9.3 companion changes): the component-root add/remove of
// generate-relocate and the structural guards of the backend is-valid-move?.

import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import {
  componentsNestingLoop,
  getChildHeads,
  getChildrenIdsWithSelf,
  getInstanceRoot,
  isInComponentCopy,
  isInstanceRoot,
  isSubinstanceHead,
} from "@/lib/workspace-component";
import { isInstanceHead } from "@/lib/workspace-selection";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

function shape(id: string, type: string, extra: Record<string, unknown> = {}): WorkspaceShape {
  return { id, type, ...extra };
}

function fixture(): WorkspaceObjects {
  return {
    [ZERO_UUID]: shape(ZERO_UUID, "frame", { shapes: ["f1", "copy"] }),
    f1: shape("f1", "frame", { "parent-id": ZERO_UUID, "frame-id": ZERO_UUID, shapes: ["g"] }),
    g: shape("g", "group", {
      "parent-id": "f1",
      "frame-id": "f1",
      shapes: ["head", "leaf"],
    }),
    head: shape("head", "rect", {
      "parent-id": "g",
      "frame-id": "f1",
      "component-id": "c1",
      "component-root": true,
      shapes: ["sub"],
    }),
    sub: shape("sub", "rect", {
      "parent-id": "head",
      "frame-id": "f1",
      "component-id": "c2",
    }),
    leaf: shape("leaf", "rect", { "parent-id": "g", "frame-id": "f1" }),
    copy: shape("copy", "frame", {
      "parent-id": ZERO_UUID,
      "frame-id": ZERO_UUID,
      "shape-ref": "main",
      shapes: ["copied", "plain"],
    }),
    copied: shape("copied", "rect", {
      "parent-id": "copy",
      "frame-id": "copy",
      "shape-ref": "main-child",
    }),
    plain: shape("plain", "rect", { "parent-id": "copy", "frame-id": "copy" }),
  };
}

describe("component predicates", () => {
  it("reads the instance root, head and subinstance flags", () => {
    const objects = fixture();
    expect(isInstanceRoot(objects.head ?? null)).toBe(true);
    expect(isInstanceRoot(objects.leaf ?? null)).toBe(false);
    expect(isInstanceHead(objects.head ?? null)).toBe(true);
    expect(isInstanceHead(objects.sub ?? null)).toBe(true);
    expect(isInstanceHead(objects.leaf ?? null)).toBe(false);
    expect(isSubinstanceHead(objects.head ?? null)).toBe(false);
    expect(isSubinstanceHead(objects.sub ?? null)).toBe(true);
  });

  it("treats a shape-ref as living inside a component copy", () => {
    const objects = fixture();
    expect(isInComponentCopy(objects.copy ?? null)).toBe(true);
    expect(isInComponentCopy(objects.copied ?? null)).toBe(true);
    // The predicate reads the shape itself, not its ancestors: a child
    // without shape-ref is not a copy shape even below a copy.
    expect(isInComponentCopy(objects.plain ?? null)).toBe(false);
    expect(isInComponentCopy(objects.head ?? null)).toBe(false);
    expect(isInComponentCopy(null)).toBe(false);
  });
});

describe("getInstanceRoot", () => {
  it("returns the instance root itself and walks up from a descendant", () => {
    const objects = fixture();
    expect(getInstanceRoot(objects, objects.head ?? null)?.id).toBe("head");
    expect(getInstanceRoot(objects, objects.sub ?? null)?.id).toBe("head");
    expect(getInstanceRoot(objects, objects.g ?? null)).toBeNull();
  });

  it("answers null at the zero root and on a malformed cycle", () => {
    const objects = fixture();
    expect(getInstanceRoot(objects, null)).toBeNull();
    expect(getInstanceRoot(objects, objects[ZERO_UUID] ?? null)).toBeNull();
    // A cycle with no root in it must not hang the walk.
    const cyclic: WorkspaceObjects = {
      a: shape("a", "group", { "parent-id": "b" }),
      b: shape("b", "group", { "parent-id": "a" }),
    };
    expect(getInstanceRoot(cyclic, cyclic.a ?? null)).toBeNull();
  });
});

describe("getChildHeads", () => {
  it("includes the shape itself when it is a head and stops at the first heads", () => {
    const objects = fixture();
    expect(getChildHeads(objects, "head").map((head) => head.id)).toEqual(["head"]);
    // The nested subinstance head below head does not surface.
    expect(getChildHeads(objects, "g").map((head) => head.id)).toEqual(["head"]);
    expect(getChildHeads(objects, "f1").map((head) => head.id)).toEqual(["head"]);
    expect(getChildHeads(objects, "leaf")).toEqual([]);
  });

  it("returns every top head of a branch", () => {
    const objects = fixture();
    objects["a"] = shape("a", "group", { shapes: ["b", "c"] });
    objects["b"] = shape("b", "rect", { "component-id": "c1" });
    objects["c"] = shape("c", "rect", { "component-id": "c2" });
    expect(getChildHeads(objects, "a").map((head) => head.id)).toEqual(["b", "c"]);
  });
});

describe("getChildrenIdsWithSelf", () => {
  it("walks depth-first in the children order, including the shape", () => {
    const objects = fixture();
    expect(getChildrenIdsWithSelf(objects, "g")).toEqual(["g", "head", "sub", "leaf"]);
    expect(getChildrenIdsWithSelf(objects, "leaf")).toEqual(["leaf"]);
  });

  it("is cycle-safe", () => {
    const cyclic: WorkspaceObjects = {
      a: shape("a", "group", { shapes: ["b"] }),
      b: shape("b", "group", { shapes: ["a"] }),
    };
    expect(getChildrenIdsWithSelf(cyclic, "a")).toEqual(["a", "b"]);
  });
});

describe("componentsNestingLoop", () => {
  it("reports a loop when an ancestor of the target heads the same component", () => {
    const objects = fixture();
    // Moving the c1 root below its own descendant is already rejected by the
    // subtree rule; the nesting loop shows with another c1 head elsewhere.
    objects["other"] = shape("other", "rect", {
      "parent-id": "f1",
      "frame-id": "f1",
      "component-id": "c1",
    });
    expect(componentsNestingLoop(objects, "head", "other")).toBe(true);
    expect(componentsNestingLoop(objects, "head", "f1")).toBe(false);
    expect(componentsNestingLoop(objects, "leaf", "f1")).toBe(false);
  });
});
