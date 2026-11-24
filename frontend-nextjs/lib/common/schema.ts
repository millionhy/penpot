// TypeScript mirror of the generic predicates of app.common.schema that the
// Next.js shell consumes. It is not a Malli replacement: the schemas stay in
// common until the Rust backend takes over, and this module only carries the
// checks the file-change boundary needs.
//
// Bounds note: ::sm/safe-int and ::sm/safe-number clamp to Integer/MAX_VALUE
// (2147483647), not Number.MAX_SAFE_INTEGER. Geometry code in lib/common/geom
// already uses those bounds.

export type Predicate<T> = (value: unknown) => value is T;

export const MAX_SAFE_INT = 2147483647;
export const MIN_SAFE_INT = -2147483648;

// uuid/regex in app.common.uuid: eight hex digits and four groups, either
// case. The shell normalizes UUIDs to strings at the Transit boundary.
export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// The email-re of app.common.schema. Kept for callers that validate account
// settings; the file-change boundary does not use it yet.
export const EMAIL_PATTERN =
  /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,63}$/;

// A Transit map decodes to a plain object. Arrays are separate values, so the
// map checks must reject them before reading fields.
export function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// ::sm/int accepts strings? No: the decode handlers parse strings before
// validation, so this boundary only sees numbers.
export function isSafeInt(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_SAFE_INT &&
    value <= MAX_SAFE_INT
  );
}

export function isSafeNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_SAFE_INT &&
    value <= MAX_SAFE_INT
  );
}

// ::sm/text: a string that is not blank. str/blank? treats nil and
// whitespace-only strings alike; the predicate already excludes non-strings.
export function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isEmail(value: unknown): value is string {
  return typeof value === "string" && EMAIL_PATTERN.test(value);
}

// ::sm/one-of: membership in the declared option set.
export function oneOf<T extends string>(values: readonly T[]): Predicate<T> {
  const options = new Set<string>(values);
  return (value: unknown): value is T =>
    typeof value === "string" && options.has(value);
}
