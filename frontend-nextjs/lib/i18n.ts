// Minimal i18n for the shell. Mirrors the subset of app.util.i18n the migrated
// pages need: a keyed catalog, %s positional substitution (cuerdas str/fmt),
// plural tuples, and the "missing key renders the key" fallback.
//
// The catalog is generated: node scripts/extract-translations.mjs pulls the
// keys used by the shell out of frontend/translations/en.po, so strings stay
// byte-identical to the CLJS app and later locales are additive.
//
// Locale selection (profile lang / browser lang, app.util.i18n locale atom)
// lands with the settings pages (F4); for now the catalog is English only.
// The <Tr> component that renders link syntax lives in components/tr.tsx.

import { en, type TranslationEntry } from "./translations/en";

const catalogs: Record<string, Record<string, TranslationEntry>> = { en };
const defaultLocale = "en";

// Substitute %s placeholders left to right, like cuerdas str/fmt. Extra
// arguments are ignored; a placeholder with no argument is left as-is.
export function format(template: string, args: ReadonlyArray<unknown>): string {
  let index = 0;
  return template.replace(/%s/g, (placeholder) => {
    if (index >= args.length) return placeholder;
    const value = args[index];
    index += 1;
    return value === null || value === undefined ? "" : String(value);
  });
}

export function lookup(key: string, locale: string = defaultLocale): TranslationEntry | undefined {
  return catalogs[locale]?.[key] ?? catalogs[defaultLocale]?.[key];
}

// Translate a literal key. Always pass a string literal so
// scripts/extract-translations.mjs can see the call site.
export function tr(key: string, ...args: unknown[]): string {
  const entry = lookup(key);
  if (entry === undefined) return key;
  if (Array.isArray(entry)) {
    const count = args.find((arg) => typeof arg === "number");
    const template = count === 1 ? entry[0] : entry[1];
    return format(template, args);
  }
  return format(entry, args);
}

// The CLJS catalog writes inline links as [label](url) and bold runs as
// **text** (the #{markdown} entries), rendered by i18n/tr-html* through
// dangerouslySetInnerHTML. The shell parses the same syntax into real anchors
// and <strong> runs instead, so no translation string is ever injected as
// markup. Everything outside a link or a bold run becomes a text segment.
const richRe = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;

export interface RichSegment {
  text: string;
  href?: string;
  bold?: boolean;
}

export function richSegments(content: string): RichSegment[] {
  const segments: RichSegment[] = [];
  let last = 0;
  for (const match of content.matchAll(richRe)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ text: content.slice(last, start) });
    if (match[3] !== undefined) {
      segments.push({ text: match[3], bold: true });
    } else {
      segments.push({ text: match[1], href: match[2] });
    }
    last = start + match[0].length;
  }
  if (last < content.length) segments.push({ text: content.slice(last) });
  return segments;
}
