// app.util.object: the small set of javascript object helpers the exporter
// uses. The CLJS namespace works on `js/obj` because the playwright options are
// plain objects; the same holds here, so the helpers are thin wrappers with
// types that let a caller keep the shape of what it builds.

export type Dict<T = unknown> = Record<string, T>;

export function newObject<T extends object = Dict>(): T {
  return {} as T;
}

export function get<T = unknown>(obj: unknown, key: string, fallback?: T): T | undefined {
  if (obj === undefined || obj === null) return fallback;
  const value = (obj as Dict)[key] as T | undefined;
  return value === undefined ? fallback : value;
}

export function getIn<T = unknown>(obj: unknown, keys: readonly string[], fallback?: T): T | undefined {
  let current: unknown = obj;
  for (const key of keys) {
    if (current === undefined || current === null) return fallback === undefined ? (current as undefined) : fallback;
    current = (current as Dict)[key];
  }
  return current === undefined || current === null ? fallback : (current as T);
}

export function clone<T extends object>(value: T): T {
  return Object.assign({}, value);
}

export function merge<T extends object>(a: T, b: Partial<T>): T {
  return Object.assign({}, a, b);
}

export function set<T extends object>(obj: T, key: string, value: unknown): T {
  (obj as Dict)[key] = value;
  return obj;
}