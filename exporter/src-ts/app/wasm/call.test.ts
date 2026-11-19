// app.wasm.call: the error-code classification the CLJS macro performs.

import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { call } from "./call.js";

describe("call", () => {
  it("invokes the named export with the given arguments", () => {
    const module = {
      _add: (a: number, b: number) => a + b,
    };

    expect(call<number>(module, "_add", 2, 3)).toBe(5);
  });

  it("raises a wasm-error when the export is missing", () => {
    try {
      call({}, "_nope");
      expect.unreachable();
    } catch (cause) {
      expect(cause).toBeInstanceOf(AppError);
      expect((cause as AppError).data).toMatchObject({
        type: "wasm-error",
        code: "wasm-critical",
        fn: "_nope",
      });
      expect((cause as AppError).message).toBe("WASM Error (wasm-critical)");
    }
  });

  it.each([
    [0x01, "wasm-non-blocking"],
    [0x02, "wasm-panic"],
    [0x00, "wasm-critical"],
    [0x7f, "wasm-critical"],
  ])("maps error code %i to %s", (number, code) => {
    const module = {
      _boom: () => {
        throw new Error("boom");
      },
      _read_error_code: () => number,
    };

    expect(() => call(module, "_boom")).toThrowError(AppError);
    try {
      call(module, "_boom");
    } catch (cause) {
      expect((cause as AppError).data.code).toBe(code);
      // The original throw stays attached for the log formatter.
      expect((cause as AppError).cause).toBeInstanceOf(Error);
      expect(((cause as AppError).cause as Error).message).toBe("boom");
    }
  });

  it("classifies a panic when the module exposes no error code reader", () => {
    const module = {
      _boom: () => {
        throw new Error("boom");
      },
    };

    try {
      call(module, "_boom");
      expect.unreachable();
    } catch (cause) {
      expect((cause as AppError).data.code).toBe("wasm-critical");
    }
  });
});
