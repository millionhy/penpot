// app.wasm.enums: binds the enum table emitted next to the artifact.

import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import {
  SERIALIZER_EXPORTS,
  fromShared,
  initSerializers,
  serializers,
  setSerializers,
} from "./enums.js";

function sharedTable(): Record<string, unknown> {
  const table: Record<string, unknown> = {};
  for (const [, name] of SERIALIZER_EXPORTS) table[name] = { plain: 0, other: 1 };
  return table;
}

afterEach(() => {
  setSerializers(undefined);
});

describe("SERIALIZER_EXPORTS", () => {
  it("covers the serializer keys the serializers read", () => {
    const keys = SERIALIZER_EXPORTS.map(([key]) => key);

    expect(keys).toContain("raster-format");
    expect(keys).toContain("fill-data");
    expect(keys).toContain("font-style");
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("fromShared", () => {
  it("maps the module exports to serializer keys", () => {
    const table = fromShared(sharedTable());

    expect(table["raster-format"]).toEqual({ plain: 0, other: 1 });
    expect(table["font-style"]).toEqual({ plain: 0, other: 1 });
    expect(serializers()).toBe(table);
  });

  it("rejects a stale shared.js that misses an export", () => {
    const shared = sharedTable();
    shared.RawFillRule = undefined;

    try {
      fromShared(shared);
      expect.unreachable();
    } catch (cause) {
      expect(cause).toBeInstanceOf(AppError);
      expect((cause as AppError).data).toMatchObject({
        type: "internal",
        code: "stale-wasm-enums",
        missing: ["fill-rule"],
      });
    }
  });
});

describe("serializers", () => {
  it("raises until a table is registered", () => {
    try {
      serializers();
      expect.unreachable();
    } catch (cause) {
      expect((cause as AppError).data).toMatchObject({
        type: "internal",
        code: "wasm-enums-not-ready",
      });
    }
  });

  it("returns the table registered by initSerializers", () => {
    const table = { "raster-format": { png: 0 } };
    initSerializers(table);

    expect(serializers()).toBe(table);
  });
});
