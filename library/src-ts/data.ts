// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// Port of the `app.common.data` helpers the library builders rely on.

export function withoutNils<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) result[key] = value;
  }
  return result as T;
}

const NUMERIC_SUFFIX_RE = /(.*)-([0-9]+)$/;

function extractNumericSuffix(
  basename: string,
): [prefix: string, counter: number] {
  const match = NUMERIC_SUFFIX_RE.exec(basename);
  if (match == null) return [basename, 1];
  return [match[1], parseInt(match[2], 10) + 1];
}

/**
 * A unique name generator. Short inputs get a numeric suffix when the
 * plain name is already taken.
 */
export function uniqueName(
  basename: string,
  used: ReadonlySet<string>,
  prefixFirst = false,
): string {
  // Skip generating names for long strings: the regex can hang.
  if (basename.length > 1000) return basename;

  const [prefix, initial] = extractNumericSuffix(basename);

  if (!prefixFirst && !used.has(basename)) return basename;

  let counter = initial;
  for (;;) {
    const candidate =
      counter === 1 && prefixFirst ? prefix : `${prefix}-${counter}`;
    if (!used.has(candidate)) return candidate;
    counter++;
  }
}

export function isNil(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}
