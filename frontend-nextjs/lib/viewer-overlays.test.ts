import { describe, expect, it } from "vitest";

import { closeOverlay, openOverlay, toggleOverlay } from "@/lib/viewer-overlays";
import type { OverlaySpec } from "@/lib/viewer-interactions";

// The pure state helpers of the wasm viewer overlays (dv/open-overlay,
// toggle-overlay, close-overlay). A no-op must return the same list
// reference, so the React state setter can skip the re-render.

function overlay(frameId: string): OverlaySpec {
  return { frameId, position: { x: 10, y: 20 }, snapTo: ["top", "left"] };
}

describe("openOverlay", () => {
  it("appends a closed frame at the end", () => {
    const base = [overlay("f1")];
    expect(openOverlay(base, overlay("f2"))).toEqual([overlay("f1"), overlay("f2")]);
    expect(base).toHaveLength(1);
  });

  it("ignores a frame that is already open", () => {
    const base = [overlay("f1")];
    expect(openOverlay(base, overlay("f1"))).toBe(base);
  });

  it("opens into an empty list", () => {
    expect(openOverlay([], overlay("f1"))).toEqual([overlay("f1")]);
  });
});

describe("toggleOverlay", () => {
  it("opens a closed frame", () => {
    const base = [overlay("f1")];
    expect(toggleOverlay(base, overlay("f2"))).toEqual([overlay("f1"), overlay("f2")]);
  });

  it("closes an open frame", () => {
    const base = [overlay("f1"), overlay("f2")];
    expect(toggleOverlay(base, overlay("f1"))).toEqual([overlay("f2")]);
    expect(base).toHaveLength(2);
  });
});

describe("closeOverlay", () => {
  it("removes the frame from the list", () => {
    const base = [overlay("f1"), overlay("f2")];
    expect(closeOverlay(base, "f1")).toEqual([overlay("f2")]);
    expect(base).toHaveLength(2);
  });

  it("keeps the list reference when nothing matches", () => {
    const base = [overlay("f1")];
    expect(closeOverlay(base, "f2")).toBe(base);
    expect(closeOverlay([], "f2")).toEqual([]);
  });
});
