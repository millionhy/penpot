// app.wasm.call: one call into the render-wasm module, with the same error
// classification the CLJS `helpers/call` macro does.
//
// The Rust side records whether the failure was a plain panic or a
// "non-blocking" error; the macro turns that number into a keyword. The
// exporter never shows a toast, so both end up as one AppError with a readable
// code and the original cause attached.

import { AppError } from "../errors.js";

const ERROR_CODES: Record<number, string> = {
  0x01: "wasm-non-blocking",
  0x02: "wasm-panic",
};

export type WasmCallable = Record<string, unknown>;

export function call<T = unknown>(module: WasmCallable, name: string, ...args: unknown[]): T {
  const fn = module[name];

  try {
    if (typeof fn !== "function") throw new TypeError(`${name} is not a function`);
    return (fn as (...values: unknown[]) => T)(...args);
  } catch (cause) {
    const read = module._read_error_code;
    const number = typeof read === "function" ? (read as () => number)() : undefined;
    const code = number === undefined ? "wasm-critical" : (ERROR_CODES[number] ?? "wasm-critical");

    throw new AppError(
      { type: "wasm-error", code, hint: `WASM Error (${code})`, fn: name },
      { cause },
    );
  }
}
