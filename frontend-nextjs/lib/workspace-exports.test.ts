// The exports menu of lib/workspace-exports.ts: the :exports of a shape and
// the pure surgery behind the format / size / suffix / delete rows.

import { describe, expect, it } from "vitest";

import {
  addExport,
  exportPatch,
  exportsOf,
  EXPORT_SCALES,
  EXPORT_TYPES,
  newExport,
  removeExport,
  scaleEnabled,
  withExportScale,
  withExportSuffix,
  withExportType,
} from "@/lib/workspace-exports";
import type { WorkspaceShape } from "@/lib/workspace";

function shape(extra: Record<string, unknown> = {}): WorkspaceShape {
  return { id: "a", type: "rect", ...extra };
}

describe("exportsOf", () => {
  it("reads the stored specs", () => {
    const exports = [
      { type: "png", scale: 2, suffix: "@2x" },
      { type: "svg", scale: 1, suffix: "" },
    ];
    expect(exportsOf(shape({ exports }))).toEqual(exports);
  });

  it("drops an unknown type", () => {
    expect(exportsOf(shape({ exports: [{ type: "gif", scale: 1 }] }))).toEqual([]);
  });

  it("defaults a missing scale to one and a missing suffix to empty", () => {
    expect(exportsOf(shape({ exports: [{ type: "pdf" }] }))).toEqual([
      { type: "pdf", scale: 1, suffix: "" },
    ]);
  });

  it("rejects a non-positive scale", () => {
    expect(exportsOf(shape({ exports: [{ type: "png", scale: 0 }] }))[0].scale).toBe(1);
  });

  it("returns an empty list for a shape without exports", () => {
    expect(exportsOf(shape())).toEqual([]);
  });
});

describe("addExport / removeExport", () => {
  it("appends the png default", () => {
    expect(addExport([])).toEqual([newExport()]);
  });

  it("keeps the previous rows", () => {
    const first = { type: "svg" as const, scale: 1, suffix: "" };
    expect(addExport([first])[0]).toEqual(first);
  });

  it("splices the row at the index", () => {
    const exports = [newExport(), { type: "svg" as const, scale: 1, suffix: "" }];
    expect(removeExport(exports, 0)).toEqual([{ type: "svg", scale: 1, suffix: "" }]);
  });
});

describe("withExportType", () => {
  it("switches the format", () => {
    expect(withExportType([newExport()], 0, "svg")[0].type).toBe("svg");
  });

  it("ignores an unknown format", () => {
    expect(withExportType([newExport()], 0, "gif")[0].type).toBe("png");
  });
});

describe("withExportScale / withExportSuffix", () => {
  it("writes a positive scale", () => {
    expect(withExportScale([newExport()], 0, 3)[0].scale).toBe(3);
  });

  it("rejects a zero scale", () => {
    expect(withExportScale([newExport()], 0, 0)[0].scale).toBe(1);
  });

  it("writes the suffix", () => {
    expect(withExportSuffix([newExport()], 0, "@2x")[0].suffix).toBe("@2x");
  });

  it("leaves the other rows alone", () => {
    const exports = [newExport(), newExport()];
    expect(withExportSuffix(exports, 1, "@2x").map((spec) => spec.suffix)).toEqual([
      "",
      "@2x",
    ]);
  });
});

describe("scaleEnabled", () => {
  it("shows the size row for the bitmap formats only", () => {
    expect(scaleEnabled({ type: "png", scale: 1, suffix: "" })).toBe(true);
    expect(scaleEnabled({ type: "jpeg", scale: 1, suffix: "" })).toBe(true);
    expect(scaleEnabled({ type: "webp", scale: 1, suffix: "" })).toBe(true);
    expect(scaleEnabled({ type: "svg", scale: 1, suffix: "" })).toBe(false);
    expect(scaleEnabled({ type: "pdf", scale: 1, suffix: "" })).toBe(false);
  });
});

describe("exportPatch", () => {
  it("copies the specs so a later row edit cannot mutate the sent value", () => {
    const exports = [newExport()];
    const patch = exportPatch(exports);
    patch[0].suffix = "x";
    expect(exports[0].suffix).toBe("");
  });
});

describe("catalog", () => {
  it("keeps the CLJS format order", () => {
    expect(EXPORT_TYPES.map((option) => option.value)).toEqual([
      "png",
      "jpeg",
      "webp",
      "svg",
      "pdf",
    ]);
  });

  it("keeps the CLJS size steps", () => {
    expect(EXPORT_SCALES.map((option) => option.label)).toEqual([
      "0.5x",
      "0.75x",
      "1x",
      "1.5x",
      "2x",
      "3x",
      "4x",
      "6x",
    ]);
  });
});
