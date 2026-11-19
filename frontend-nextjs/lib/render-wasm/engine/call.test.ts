import { describe, expect, it } from "vitest";
import { call } from "./call";
import { EngineError } from "./errors";
import type { RenderWasmModule } from "./module";

// A module-shaped stub: real typed arrays so the helpers under test can use
// them, plus whichever exports each case needs.
function makeModule(overrides: Record<string, unknown> = {}): RenderWasmModule {
  return {
    HEAPU8: new Uint8Array(64),
    HEAPU32: new Uint32Array(16),
    HEAP32: new Int32Array(16),
    HEAPF32: new Float32Array(16),
    UTF8ToString: (ptr: number) => `#${ptr}`,
    ...overrides,
  };
}

describe("call", () => {
  it("forwards the arguments and returns the export result", () => {
    const seen: unknown[] = [];
    const target = makeModule({
      _add: (a: number, b: number) => {
        seen.push(a, b);
        return a + b;
      },
    });

    expect(call<number>(target, "_add", 2, 3)).toBe(5);
    expect(seen).toEqual([2, 3]);
  });

  it("keeps booleans as the artifact expects them", () => {
    let received: unknown;
    const target = makeModule({
      _set_flag: (value: unknown) => {
        received = value;
        return 1;
      },
    });

    call(target, "_set_flag", true);

    expect(received).toBe(true);
  });

  it("maps a non-blocking wasm error and keeps the throwable", () => {
    const trap = new Error("trap");
    const target = makeModule({
      _fail: () => {
        throw trap;
      },
      _read_error_code: () => 0x01,
    });

    let caught: unknown;
    try {
      call(target, "_fail");
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(EngineError);
    const error = caught as EngineError;
    expect(error.code).toBe("wasm-non-blocking");
    expect(error.fn).toBe("_fail");
    expect(error.message).toBe("WASM Error (wasm-non-blocking)");
    expect(error.cause).toBe(trap);
  });

  it("maps a panic", () => {
    const target = makeModule({
      _fail: () => {
        throw new Error("boom");
      },
      _read_error_code: () => 0x02,
    });

    expect(() => call(target, "_fail")).toThrowError(
      expect.objectContaining({ code: "wasm-panic" }),
    );
  });

  it("falls back to critical when the artifact has no error slot", () => {
    const target = makeModule({
      _fail: () => {
        throw new Error("boom");
      },
    });

    expect(() => call(target, "_fail")).toThrowError(
      expect.objectContaining({ code: "wasm-critical" }),
    );
  });

  it("treats an unreadable error slot as critical instead of masking the trap", () => {
    const trap = new Error("boom");
    const target = makeModule({
      _fail: () => {
        throw trap;
      },
      _read_error_code: () => {
        throw new Error("module is dead");
      },
    });

    try {
      call(target, "_fail");
      expect.unreachable("call should have thrown");
    } catch (cause) {
      expect(cause).toBeInstanceOf(EngineError);
      expect((cause as EngineError).code).toBe("wasm-critical");
      expect((cause as EngineError).cause).toBe(trap);
    }
  });

  it("reports a missing export by name", () => {
    const target = makeModule();

    expect(() => call(target, "_nope")).toThrowError(
      expect.objectContaining({
        code: "wasm-critical",
        message: 'render-wasm: missing wasm export "_nope"',
      }),
    );
  });
});
