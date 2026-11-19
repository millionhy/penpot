// The FFI call helper: one place that turns a wasm trap into an EngineError.
//
// Ported from app.common.render-wasm.helpers/call. The CLJS macro catches the
// throwable, asks the wasm side for its error code and rethrows with a
// keyword the caller can route on. The same three outcomes apply here:
//
//   _read_error_code -> 1  wasm-non-blocking  surface a toast, keep going
//   _read_error_code -> 2  wasm-panic         internal error page
//   anything else          wasm-critical      internal error page

import { EngineError, type EngineErrorCode } from "./errors";
import type { RenderWasmModule } from "./module";

type WasmExport = (...args: unknown[]) => unknown;

const ERROR_CODES: Readonly<Record<number, EngineErrorCode>> = {
  0x01: "wasm-non-blocking",
  0x02: "wasm-panic",
};

function wasmExport(target: RenderWasmModule, name: string): WasmExport {
  const value = target[name];
  if (typeof value !== "function") {
    throw new EngineError(
      "wasm-critical",
      `render-wasm: missing wasm export "${name}"`,
      { fn: name },
    );
  }
  return value as WasmExport;
}

// The artifact's own error slot. A trap can leave the module too broken to
// answer, so a failed read is treated as "no code" instead of masking the
// original throwable.
function readErrorCode(target: RenderWasmModule): number | undefined {
  const read = target._read_error_code;
  if (typeof read !== "function") return undefined;
  try {
    return read();
  } catch {
    return undefined;
  }
}

export function call<T = unknown>(
  target: RenderWasmModule,
  name: string,
  ...args: unknown[]
): T {
  const fn = wasmExport(target, name);
  try {
    return fn(...args) as T;
  } catch (cause) {
    const code = ERROR_CODES[readErrorCode(target) ?? 0] ?? "wasm-critical";
    throw new EngineError(code, `WASM Error (${code})`, { fn: name, cause });
  }
}
