import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markContextInitialized,
  markContextLost,
  markReloading,
  resetModule,
  setModule,
  type RenderWasmModule,
} from "./module";
import {
  INPUT_MODIFIER_U8_SIZE,
  MODIFIER_U8_SIZE,
  OUTPUT_MODIFIER_U32_SIZE,
  PIXEL_PRECISION,
  STRUCTURE_MODIFIER_U8_SIZE,
  cleanModifiers,
  pixelPrecision,
  propagateModifiers,
  setModifiers,
  setModifiersEnd,
  setModifiersStart,
  setStructureModifiers,
} from "./modifiers";
import { uuidToU32 } from "./uuid";

const ID = "12345678-9abc-def0-1122-334455667788";
const PARENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

interface Recorded {
  name: string;
  args: unknown[];
}

function makeModule(recorded: Recorded[], heapSize = 1 << 16): RenderWasmModule {
  const heap = new Uint8Array(heapSize);
  let next = 8;
  const record = (name: string) =>
    (...args: unknown[]) => {
      recorded.push({ name, args });
      return 0;
    };

  return {
    HEAPU8: heap,
    HEAPU32: new Uint32Array(heap.buffer),
    HEAP32: new Int32Array(heap.buffer),
    HEAPF32: new Float32Array(heap.buffer),
    UTF8ToString: () => "",
    _alloc_bytes: (size: number) => {
      recorded.push({ name: "_alloc_bytes", args: [size] });
      const at = next;
      next += (size + 7) & ~3;
      return at;
    },
    _free_bytes: record("_free_bytes"),
    _clean_modifiers: record("_clean_modifiers"),
    _set_modifiers: record("_set_modifiers"),
    _set_modifiers_start: record("_set_modifiers_start"),
    _set_modifiers_end: record("_set_modifiers_end"),
    _set_structure_modifiers: record("_set_structure_modifiers"),
  };
}

let recorded: Recorded[];
let module: RenderWasmModule;

beforeEach(() => {
  resetModule();
  recorded = [];
  module = makeModule(recorded);
  setModule(module);
  markContextInitialized();
});

afterEach(() => {
  resetModule();
  vi.restoreAllMocks();
});

function names(): string[] {
  return recorded.map((entry) => entry.name);
}

function view(): DataView {
  return new DataView(module.HEAPU8.buffer);
}

describe("pixelPrecision", () => {
  it("maps the snapping flags to the renderer modes", () => {
    expect(pixelPrecision(false)).toBe(PIXEL_PRECISION.disabled);
    expect(pixelPrecision(true)).toBe(PIXEL_PRECISION.both);
    expect(pixelPrecision(true, "x")).toBe(PIXEL_PRECISION.onlyY);
    expect(pixelPrecision(true, "y")).toBe(PIXEL_PRECISION.onlyX);
    expect(pixelPrecision(false, "x")).toBe(PIXEL_PRECISION.disabled);
  });
});

describe("setStructureModifiers", () => {
  it("writes 44-byte entries and hands them to the renderer", () => {
    setStructureModifiers(module, [
      { type: "remove-children", parent: PARENT, id: ID },
      { type: "scale-content", parent: PARENT, id: ID, value: 0.5 },
    ]);

    expect(names()).toEqual(["_alloc_bytes", "_set_structure_modifiers"]);
    expect(recorded[0].args).toEqual([2 * STRUCTURE_MODIFIER_U8_SIZE]);

    const data = view();
    expect(data.getUint32(8, true)).toBe(1); // remove-children
    expect(data.getUint32(12, true)).toBe(0); // nil index
    expect(data.getUint32(16, true)).toBe(0xaaaaaaaa); // parent
    expect(data.getUint32(32, true)).toBe(0x12345678); // id
    expect(data.getFloat32(48, true)).toBe(0); // default value

    expect(data.getUint32(52, true)).toBe(3); // scale-content
    expect(data.getFloat32(92, true)).toBe(0.5);
  });

  it("keeps the index when one is given", () => {
    setStructureModifiers(module, [
      { type: "add-children", parent: PARENT, id: ID, index: 7 },
    ]);
    expect(view().getUint32(12, true)).toBe(7);
  });

  it("does nothing for an empty list", () => {
    setStructureModifiers(module, []);
    expect(recorded).toEqual([]);
  });

  it("rejects a type the renderer cannot decode", () => {
    expect(() =>
      setStructureModifiers(module, [{ type: "explode", parent: PARENT, id: ID }]),
    ).toThrowError(/unknown structure modifier type "explode"/);
    expect(recorded).toEqual([]);
  });

  it("is gated by the reload flag and the lost context", () => {
    markReloading(true);
    setStructureModifiers(module, [{ type: "add-children", parent: PARENT, id: ID }]);
    expect(recorded).toEqual([]);

    markReloading(false);
    markContextLost(true);
    setStructureModifiers(module, [{ type: "add-children", parent: PARENT, id: ID }]);
    expect(recorded).toEqual([]);
  });
});

describe("setModifiers", () => {
  it("writes the whole move set, commits and requests one render", () => {
    const sink = { requestRender: vi.fn() };
    setModifiers(
      module,
      [
        [ID, [1, 0, 0, 1, 5, 6]],
        [PARENT, [2, 0, 0, 2, 0, 0]],
      ],
      sink,
    );

    expect(names()).toEqual(["_alloc_bytes", "_set_modifiers"]);
    expect(recorded[0].args).toEqual([2 * MODIFIER_U8_SIZE]);

    const data = view();
    expect(data.getUint32(8, true)).toBe(0x12345678);
    expect(data.getFloat32(24, true)).toBe(1); // a
    expect(data.getFloat32(28, true)).toBe(0); // b
    expect(data.getFloat32(32, true)).toBe(0); // c
    expect(data.getFloat32(36, true)).toBe(1); // d
    expect(data.getFloat32(40, true)).toBe(5); // e
    expect(data.getFloat32(44, true)).toBe(6); // f

    expect(data.getUint32(48, true)).toBe(0xaaaaaaaa);
    expect(data.getFloat32(76, true)).toBe(2); // d of the second entry
    expect(sink.requestRender).toHaveBeenCalledWith("set-modifiers");
  });

  it("treats an empty set as a no-op, not a clear", () => {
    const sink = { requestRender: vi.fn() };
    setModifiers(module, [], sink);
    expect(recorded).toEqual([]);
    expect(sink.requestRender).not.toHaveBeenCalled();
  });
});

describe("the modifier lifecycle", () => {
  it("forwards start, end and clean without requesting a render", () => {
    setModifiersStart(module);
    setModifiersEnd(module);
    cleanModifiers(module);
    expect(names()).toEqual(["_set_modifiers_start", "_set_modifiers_end", "_clean_modifiers"]);
  });

  it("skips every call while the context is lost", () => {
    markContextLost(true);
    setModifiersStart(module);
    setModifiersEnd(module);
    cleanModifiers(module);
    setModifiers(module, [[ID, [1, 0, 0, 1, 0, 0]]]);
    expect(recorded).toEqual([]);
  });
});

describe("propagateModifiers", () => {
  function answer(at: number, entries: Array<[string, readonly number[]]>) {
    return (value: number) => {
      recorded.push({ name: "_propagate_modifiers", args: [value] });
      const data = new DataView(module.HEAPU8.buffer);
      data.setUint32(at, entries.length, true);
      let cursor = at + 4;
      for (const [id, matrix] of entries) {
        const quartet = uuidToU32(id);
        for (let index = 0; index < 4; index += 1) {
          data.setUint32(cursor + index * 4, quartet[index], true);
        }
        for (let index = 0; index < 6; index += 1) {
          data.setFloat32(cursor + 16 + index * 4, matrix[index], true);
        }
        cursor += OUTPUT_MODIFIER_U32_SIZE * 4;
      }
      return at;
    };
  }

  it("writes 44-byte inputs, marks the kind and reads the answer", () => {
    (module as Record<string, unknown>)._propagate_modifiers = answer(4096, [
      [ID, [1, 0, 0, 1, 10, 20]],
    ]);

    const result = propagateModifiers(module, [
      { id: ID, transform: [1, 0, 0, 1, 5, 6] },
      { id: PARENT, transform: [1, 0, 0, 1, 0, 0], kind: "parent" },
    ]);

    expect(result).toEqual([[ID, [1, 0, 0, 1, 10, 20]]]);

    const data = view();
    expect(recorded[0]).toMatchObject({ name: "_alloc_bytes", args: [2 * INPUT_MODIFIER_U8_SIZE] });
    expect(data.getUint32(8, true)).toBe(0x12345678);
    expect(data.getFloat32(40, true)).toBe(5); // e
    expect(data.getFloat32(44, true)).toBe(6); // f
    expect(data.getUint32(48, true)).toBe(1); // kind child by default
    expect(data.getUint32(92, true)).toBe(0); // kind parent
    expect(recorded.at(-1)?.name).toBe("_free_bytes");
  });

  it("passes the snapping mode and survives an empty answer", () => {
    (module as Record<string, unknown>)._propagate_modifiers = answer(4096, []);
    expect(propagateModifiers(module, [{ id: ID, transform: [1, 0, 0, 1, 0, 0] }], true, "x")).toEqual([]);
    expect(recorded.filter((entry) => entry.name === "_propagate_modifiers")[0].args).toEqual([3]);
    expect(names()).toContain("_free_bytes");
  });

  it("asks nothing of the renderer for an empty or dead context", () => {
    expect(propagateModifiers(module, [])).toEqual([]);
    expect(recorded).toEqual([]);

    markReloading(true);
    expect(propagateModifiers(module, [{ id: ID, transform: [1, 0, 0, 1, 0, 0] }])).toEqual([]);
    expect(recorded).toEqual([]);
  });
});