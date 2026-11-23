// Unit tests for the workspace propagation face (lib/render-wasm/propagate.ts).
//
// The packed input/output layouts and the Rust reflow have their own tests
// (engine/modifiers.test.ts and the renderer's Rust suite). This file pins
// the mapping the canvas depends on:
// - the boolean `propagate` flag turns into the engine's child/parent kind;
// - the legacy pixel-precision code turns into snap + ignored axis;
// - an empty set asks nothing and returns an empty list.

import { beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  propagateModifiers: vi.fn(),
}));

vi.mock("@/lib/render-wasm/engine", () => ({
  propagateModifiers: engine.propagateModifiers,
}));

import {
  propagateModifiers,
  type PropagateEntry,
} from "@/lib/render-wasm/propagate";
import type { WorkspaceApp } from "@/lib/render-wasm/workspace-app";
import type { Matrix6 } from "@/lib/render-wasm/engine";

const SHAPE_ID = "d8cf69c1-e3c8-8159-8008-6f934d0e82aa";
const OTHER_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const IDENTITY: Matrix6 = [1, 0, 0, 1, 0, 0];
const RESIZE: Matrix6 = [2, 0, 0, 3, 5, 7];

function makeApp(): WorkspaceApp {
  return {
    module: { name: "fake-module" },
    loop: { requestRender: (): boolean => true },
    host: { hostAttrs: (): void => {} },
  } as unknown as WorkspaceApp;
}

beforeEach(() => {
  engine.propagateModifiers.mockReset().mockReturnValue([]);
});

describe("propagateModifiers", () => {
  it("does not touch the engine for an empty list", () => {
    const app = makeApp();

    expect(propagateModifiers(app, [])).toEqual([]);

    expect(engine.propagateModifiers).not.toHaveBeenCalled();
  });

  it("maps the default and explicit propagate flag to child/parent", () => {
    const app = makeApp();
    const entries: PropagateEntry[] = [
      { id: SHAPE_ID, matrix: RESIZE },
      { id: OTHER_ID, matrix: IDENTITY, propagate: false },
    ];

    propagateModifiers(app, entries);

    expect(engine.propagateModifiers).toHaveBeenCalledWith(
      app.module,
      [
        { id: SHAPE_ID, transform: RESIZE, kind: "child" },
        { id: OTHER_ID, transform: IDENTITY, kind: "parent" },
      ],
      false,
      null,
    );
  });

  it("maps pixel precision to the engine snap flag and ignored axis", () => {
    const cases: Array<[number, boolean, "x" | "y" | null]> = [
      [0, false, null],
      [1, true, null],
      [2, true, "y"],
      [3, true, "x"],
    ];

    for (const [precision, snapPixel, ignoreAxis] of cases) {
      const app = makeApp();
      propagateModifiers(app, [{ id: SHAPE_ID, matrix: IDENTITY }], precision);
      expect(engine.propagateModifiers).toHaveBeenLastCalledWith(
        app.module,
        [{ id: SHAPE_ID, transform: IDENTITY, kind: "child" }],
        snapPixel,
        ignoreAxis,
      );
    }
  });

  it("returns the engine result in the renderer order", () => {
    const app = makeApp();
    const answer: Array<[string, Matrix6]> = [
      [SHAPE_ID, RESIZE],
      [OTHER_ID, IDENTITY],
    ];
    engine.propagateModifiers.mockReturnValue(answer);

    expect(propagateModifiers(app, [{ id: SHAPE_ID, matrix: IDENTITY }])).toBe(
      answer,
    );
  });
});
