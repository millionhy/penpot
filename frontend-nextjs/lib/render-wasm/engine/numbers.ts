// d/parse-double: js/parseFloat with the NaN -> default step.
//
// Both arities of the CLJS helper land here: without a fallback the caller
// wants to know the value was unreadable (`undefined`), with one it wants the
// default. `parseFloat(String(...))` is what the compiled code runs, so
// `null`, `undefined` and garbage all fall through to the default.

export function parseDouble(value: unknown, fallback?: number): number | undefined {
  const parsed = Number.parseFloat(String(value));
  return Number.isNaN(parsed) ? fallback : parsed;
}