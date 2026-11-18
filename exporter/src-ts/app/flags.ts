// app.common.flags/parse: a flag list is applied left to right, "enable-" adds
// and "disable-" removes. Names keep the CLJS keyword form as plain strings
// (no leading colon), which is how the rest of the ported code reads them.

export type FlagSet = Set<string>;

export function parseFlags(input: string | readonly string[] | undefined | null): FlagSet {
  const result: FlagSet = new Set();

  const items =
    input === undefined || input === null
      ? []
      : typeof input === "string"
        ? input.split(/[,\s]+/)
        : input;

  for (const raw of items) {
    const item = String(raw).trim();
    if (item.length === 0) continue;

    // A keyword literal ("enable-foo") reaches parse by name only.
    const name = item.startsWith(":") ? item.slice(1) : item;

    if (name.startsWith("enable-")) result.add(name.slice("enable-".length));
    else if (name.startsWith("disable-")) result.delete(name.slice("disable-".length));
  }

  return result;
}

export function hasFlag(flags: FlagSet, name: string): boolean {
  return flags.has(name);
}