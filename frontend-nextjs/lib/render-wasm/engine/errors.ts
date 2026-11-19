// The failure shape every engine call raises.
//
// app.common.render-wasm.helpers/call maps the wasm error code to a keyword
// and throws ex-info with it; the api layer then routes :non-blocking to a
// toast and everything else to the internal error page. The codes below keep
// that split, as strings instead of keywords, and the original throwable in
// `cause` so the console keeps the wasm trap.

export type EngineErrorCode =
  | "wasm-module-not-ready"
  | "wasm-non-blocking"
  | "wasm-panic"
  | "wasm-critical";

export interface EngineErrorContext {
  // The wasm export that threw, when the failure came from an FFI call.
  fn?: string;
  hint?: string;
  cause?: unknown;
}

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly fn?: string;

  constructor(code: EngineErrorCode, message: string, context: EngineErrorContext = {}) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = "EngineError";
    this.code = code;
    this.fn = context.fn;
  }
}
