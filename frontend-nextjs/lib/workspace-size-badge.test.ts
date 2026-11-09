// Unit tests for the selection size badge math (lib/workspace-size-badge):
// the label formatting, the tiny-shape hide rule, the below-placement and the
// vbox flip, all in world units at a known zoom.

import { describe, expect, it } from "vitest";

import {
  formatSizeNumber,
  selectionSizeBadge,
} from "@/lib/workspace-size-badge";

describe("formatSizeNumber", () => {
  it("prints whole numbers without a decimal part", () => {
    expect(formatSizeNumber(300)).toBe("300");
    expect(formatSizeNumber(150)).toBe("150");
  });

  it("keeps up to two decimals and drops trailing zeros", () => {
    expect(formatSizeNumber(300.5)).toBe("300.5");
    expect(formatSizeNumber(300.499)).toBe("300.5");
    expect(formatSizeNumber(10.123)).toBe("10.12");
  });

  it("normalizes negative zero", () => {
    expect(formatSizeNumber(-0.001)).toBe("0");
  });
});

describe("selectionSizeBadge", () => {
  const vbox = { x: 0, y: 0, width: 1000, height: 800 };

  it("builds a W x H pill centered under a board that fits the viewport", () => {
    const bounds = { x: 100, y: 100, width: 300, height: 150 };
    const badge = selectionSizeBadge(bounds, 300, 150, 1, vbox);

    expect(badge).not.toBeNull();
    expect(badge?.text).toBe("300 x 150");
    expect(badge?.cx).toBe(250);
    // below: y(100) + height(150) + gap(8) + half(8) = 166
    expect(badge?.cy).toBe(266);
    expect(badge?.height).toBe(16);
  });

  it("scales every dimension by the zoom", () => {
    const bounds = { x: 100, y: 100, width: 300, height: 150 };
    const badge = selectionSizeBadge(bounds, 300, 150, 2, vbox);

    expect(badge?.height).toBe(8);
    // gap and half both halve: 100 + 150 + 4 + 4 = 258
    expect(badge?.cy).toBe(258);
    // the pill is half as wide in world units
    const full = selectionSizeBadge(bounds, 300, 150, 1, vbox);
    expect(badge?.width).toBe((full?.width ?? 0) / 2);
  });

  it("flips above the selection when it would leave the viewport bottom", () => {
    // A shape whose bottom edge sits at the vbox floor (y 800).
    const bounds = { x: 100, y: 650, width: 300, height: 150 };
    const badge = selectionSizeBadge(bounds, 300, 150, 1, vbox);

    expect(badge).not.toBeNull();
    // above: y(650) - gap(8) - half(8) = 634
    expect(badge?.cy).toBe(634);
  });

  it("hides a shape narrower than the pill", () => {
    const bounds = { x: 100, y: 100, width: 40, height: 40 };
    // "40 x 40" is 7 chars -> 7*6.5 + 12 = 57.5 world units > 40.
    expect(selectionSizeBadge(bounds, 40, 40, 1, vbox)).toBeNull();
  });

  it("hides a shape shorter than the pill height", () => {
    const bounds = { x: 100, y: 100, width: 300, height: 10 };
    expect(selectionSizeBadge(bounds, 300, 10, 1, vbox)).toBeNull();
  });

  it("returns null for a non-positive zoom", () => {
    const bounds = { x: 0, y: 0, width: 300, height: 150 };
    expect(selectionSizeBadge(bounds, 300, 150, 0, vbox)).toBeNull();
  });
});
