// Lazy access to the exporter's runtime dependencies.
//
// The TS tree is compiled before the exporter has its own node_modules (that
// lands with the build switch) and the unit tests run without playwright,
// archiver or xml-js installed. Loading through `createRequire` with a runtime
// specifier keeps the compiler from resolving those packages while the runtime
// still does, and turns a missing package into one readable AppError instead of
// a module resolution crash at import time.

import { createRequire } from "node:module";
import { AppError } from "./errors.js";

const require = createRequire(import.meta.url);

export function load<T>(name: string): T {
  try {
    return require(name) as T;
  } catch (cause) {
    throw new AppError(
      { type: "internal", code: "missing-dependency", hint: `unable to load ${name}` },
      { cause },
    );
  }
}