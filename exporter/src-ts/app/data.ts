// Small helpers ported from app.common.data. Only the functions the exporter
// needs are here; each keeps the CLJS name and shape so the ported call sites
// read like the originals.

export type Dict<T> = Record<string, T>;

// without-nils: drop undefined and null values.
export function withoutNils<T extends Record<string, unknown>>(data: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out as Partial<T>;
}

// group-by: insertion-ordered, like the array-map the CLJS reduce builds for
// the small export batches.
export function groupBy<T, K>(keyFn: (item: T) => K, items: readonly T[]): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = result.get(key);
    if (bucket === undefined) result.set(key, [item]);
    else bucket.push(item);
  }
  return result;
}

export function indexBy<T, K extends string>(keyFn: (item: T) => K, items: readonly T[]): Record<K, T> {
  const result = {} as Record<K, T>;
  for (const item of items) result[keyFn(item)] = item;
  return result;
}

// distinct-xf over a key function.
export function distinctBy<T, K>(keyFn: (item: T) => K, items: Iterable<T>): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// obfuscate-string: keep the first five characters, star the rest.
export function obfuscateString(value: string, full = false): string {
  if (value.length === 0) return value;
  if (full || value.length < 10) return "*".repeat(value.length);
  return value.slice(0, 5) + "*".repeat(value.length - 5);
}

// parse-double: NaN and non-finite values fall back to the default.
export function parseDouble(value: unknown, fallback?: number): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// d/merge for flat attribute maps (svg element attributes in the renderer).
export function mergeAttrs(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...(a ?? {}), ...(b ?? {}) };
}