// Unit tests for the workspace modifier face (lib/render-wasm/modifiers.ts).
//
// The engine owns the packed buffers and their guards; those layouts have
// their own tests under engine/modifiers.test.ts. This file pins the small
// adapter the canvas calls: which engine entry point runs, in what order, and
// that the render loop is the one that asks for the preview frame.

import { beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  setModifiersStart: vi.fn(),
  setModifiersEnd: vi.fn(),
  cleanModifiers: vi.fn(),
  setModifiers: vi.fn(),
}));

vi.mock("@/lib/render-wasm/engine", () => ({
  setModifiersStart: engine.setModifiersStart,
  setModifiersEnd: engine.setModifiersEnd,
  cleanModifiers: engine.cleanModifiers,
  setModifiers: engine.setModifiers,
}));

import {
  cleanModifiers,
  configureModifiers,
  endModifiers,
  resetModifierPreview,
  startModifiers,
  type Matrix6,
} from "@/lib/render-wasm/modifiers";
import type { WorkspaceApp } from "@/lib/render-wasm/workspace-app";

const SHAPE_ID = "d8cf69c1-e3c8-8159-8008-6f934d0e82aa";
const OTHER_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

let calls: string[];

function makeApp() {
  const renders: string[] = [];
  const loop = {
    requestRender: (reason: string): boolean => {
      renders.push(reason);
      return true;
    },
  };
  const app = {
    module: { name: "fake-module" },
    loop,
    host: { hostAttrs: (): void => {} },
  };
  return { app: app as unknown as WorkspaceApp, renders, loop };
}

beforeEach(() => {
  calls = [];
  engine.setModifiersStart.mockReset().mockImplementation(() => {
    calls.push("start");
  });
  engine.setModifiersEnd.mockReset().mockImplementation(() => {
    calls.push("end");
  });
  engine.cleanModifiers.mockReset().mockImplementation(() => {
    calls.push("clean");
  });
  engine.setModifiers.mockReset().mockImplementation(() => {
    calls.push("set");
  });
});

describe("modifier lifecycle", () => {
  it("startModifiers calls set-modifiers-start alone", () => {
    const { app } = makeApp();

    startModifiers(app);

    expect(engine.setModifiersStart).toHaveBeenCalledWith(app.module);
    expect(calls).toEqual(["start"]);
  });

  it("endModifiers calls set-modifiers-end alone", () => {
    const { app } = makeApp();

    endModifiers(app);

    expect(engine.setModifiersEnd).toHaveBeenCalledWith(app.module);
    expect(calls).toEqual(["end"]);
  });

  it("cleanModifiers calls clean-modifiers and requests no render", () => {
    const { app, renders } = makeApp();

    cleanModifiers(app);

    expect(engine.cleanModifiers).toHaveBeenCalledWith(app.module);
    expect(calls).toEqual(["clean"]);
    expect(renders).toEqual([]);
  });

  it("resetModifierPreview runs end, clean and the restore render", () => {
    const { app, renders } = makeApp();

    resetModifierPreview(app);

    expect(calls).toEqual(["end", "clean"]);
    expect(renders).toEqual(["clean-modifiers"]);
  });
});

describe("configureModifiers", () => {
  it("passes the whole set and the render loop to the engine", () => {
    const { app } = makeApp();
    const entries: Array<readonly [string, Matrix6]> = [
      [SHAPE_ID, [1, 0, 0, 1, 5, 7]],
      [OTHER_ID, [2, 0, 0, 2, -3, 4]],
    ];

    configureModifiers(app, entries);

    expect(engine.setModifiers).toHaveBeenCalledTimes(1);
    expect(engine.setModifiers).toHaveBeenCalledWith(app.module, entries, app.loop);
    expect(calls).toEqual(["set"]);
  });

  it("still calls the engine for an empty set (the engine owns the no-op)", () => {
    const { app } = makeApp();

    configureModifiers(app, []);

    expect(engine.setModifiers).toHaveBeenCalledWith(app.module, [], app.loop);
  });
});
