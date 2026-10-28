// Unit tests for the multi-selection batch patches (lib/workspace-multi):
// the shared-value detection and the per-shape patches the panel sends in
// one commit. The module is pure, so every branch runs in node.

import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import type { WorkspaceShape } from "@/lib/workspace";
import {
  blendUpdates,
  blurAddUpdates,
  blurClearUpdates,
  constraintUpdates,
  flagUpdates,
  opacityUpdates,
  radiusUpdates,
  shadowAddUpdates,
  shadowClearUpdates,
  sharedFlag,
  sharedValue,
  sizingUpdates,
} from "@/lib/workspace-multi";

function shape(id: string, attrs: Record<string, unknown> = {}): WorkspaceShape {
  return { id, type: "rect", ...attrs };
}

describe("shared values", () => {
  it("answers the shared value", () => {
    expect(sharedValue([shape("a"), shape("b")], (s) => s.type)).toBe("rect");
  });

  it("answers undefined for a mixed or empty list", () => {
    expect(
      sharedValue([shape("a"), shape("b", { type: "circle" })], (s) => s.type),
    ).toBeUndefined();
    expect(sharedValue([], (s) => s.type)).toBeUndefined();
  });

  it("compares flags as booleans, not as stored values", () => {
    expect(sharedFlag([shape("a"), shape("b")], "hidden")).toBe(false);
    expect(sharedFlag([shape("a"), shape("b", { hidden: true })], "hidden")).toBe(
      undefined,
    );
    expect(
      sharedFlag([shape("a", { hidden: true }), shape("b", { hidden: true })], "hidden"),
    ).toBe(true);
  });
});

describe("flag and value updates", () => {
  it("sends one flag per shape", () => {
    expect(flagUpdates([shape("a"), shape("b")], "blocked", true)).toEqual([
      { id: "a", attrs: { blocked: true } },
      { id: "b", attrs: { blocked: true } },
    ]);
  });

  it("clamps the opacity to 0..1", () => {
    expect(opacityUpdates([shape("a")], 0.25)).toEqual([
      { id: "a", attrs: { opacity: 0.25 } },
    ]);
    expect(opacityUpdates([shape("a")], 3)[0].attrs.opacity).toBe(1);
    expect(opacityUpdates([shape("a")], -1)[0].attrs.opacity).toBe(0);
  });

  it("sends one blend mode per shape", () => {
    expect(blendUpdates([shape("a"), shape("b")], "multiply")).toEqual([
      { id: "a", attrs: { "blend-mode": "multiply" } },
      { id: "b", attrs: { "blend-mode": "multiply" } },
    ]);
    expect(blendUpdates([], "screen")).toEqual([]);
  });

  it("sets every corner on the rect and frame shapes only", () => {
    const updates = radiusUpdates(
      [shape("a"), shape("b", { type: "circle" }), shape("c", { type: "frame" })],
      6,
    );
    expect(updates).toEqual([
      { id: "a", attrs: { r1: 6, r2: 6, r3: 6, r4: 6 } },
      { id: "c", attrs: { r1: 6, r2: 6, r3: 6, r4: 6 } },
    ]);
    expect(radiusUpdates([shape("a")], -2)[0].attrs.r1).toBe(0);
  });
});

describe("shadow and blur batches", () => {
  it("prepends an independent shadow to every shape", () => {
    const ids = ["s1", "s2"];
    let next = 0;
    const updates = shadowAddUpdates(
      [shape("a"), shape("b", { shadow: [{ id: "old", style: "drop-shadow" }] })],
      () => ids[next++] as string,
    );
    expect(updates).toHaveLength(2);
    const first = updates[0].attrs.shadow as Record<string, unknown>[];
    const second = updates[1].attrs.shadow as Record<string, unknown>[];
    expect(first[0].id).toBe("s1");
    expect(second[0].id).toBe("s2");
    expect(second[1].id).toBe("old");
    expect(first).toHaveLength(1);
  });

  it("clears only the shapes that carry a shadow", () => {
    expect(
      shadowClearUpdates([shape("a"), shape("b", { shadow: [{ id: "s" }] })]),
    ).toEqual([{ id: "b", attrs: { shadow: null } }]);
  });

  it("adds one layer blur per shape under its own id", () => {
    const ids = ["b1", "b2"];
    let next = 0;
    const updates = blurAddUpdates([shape("a"), shape("b")], () => ids[next++] as string);
    expect((updates[0].attrs.blur as Record<string, unknown>).id).toBe("b1");
    expect((updates[1].attrs.blur as Record<string, unknown>).id).toBe("b2");
  });

  it("clears only the shapes that carry a blur", () => {
    expect(
      blurClearUpdates([shape("a"), shape("b", { blur: { id: "b1" } }), shape("c", { blur: null })]),
    ).toEqual([{ id: "b", attrs: { blur: null } }]);
  });
});

describe("constraints and sizing", () => {
  it("skips the root children and edits the requested axes", () => {
    const updates = constraintUpdates(
      [
        shape("a", { "parent-id": "frame-1" }),
        shape("b", { "parent-id": ZERO_UUID }),
        shape("c", { "parent-id": "frame-1" }),
      ],
      "left",
      null,
    );
    expect(updates).toEqual([
      { id: "a", attrs: { "constraints-h": "left" } },
      { id: "c", attrs: { "constraints-h": "left" } },
    ]);
  });

  it("sends empty attrs for a shape without a requested axis", () => {
    expect(constraintUpdates([shape("a", { "parent-id": "frame-1" })], null, null)).toEqual(
      [],
    );
  });

  it("sends the sizing axes every shape", () => {
    expect(sizingUpdates([shape("a"), shape("b")], "fill", null)).toEqual([
      { id: "a", attrs: { "layout-item-h-sizing": "fill" } },
      { id: "b", attrs: { "layout-item-h-sizing": "fill" } },
    ]);
    expect(sizingUpdates([shape("a")], null, null)).toEqual([]);
  });
});
