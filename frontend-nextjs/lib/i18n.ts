// Minimal i18n for the shell. Mirrors the subset of app.util.i18n the migrated
// pages need: keyed catalogs, %s positional substitution (cuerdas str/fmt),
// plural tuples, the "missing key renders the key" fallback and locale
// selection (matchLocale + the active-locale pair below).
//
// The catalogs are generated: node scripts/extract-translations.mjs pulls the
// keys used by the shell out of frontend/translations/*.po (en is the source
// of truth; zh_cn and zh_hant carry whatever upstream has translated and fall
// back to English per key), so strings stay byte-identical to the CLJS app.
//
// Locale selection mirrors app.util.i18n: the profile's lang picks the
// catalog, an empty lang autodetects the browser language, and an unknown or
// untranslated value falls back to English. components/locale-gate.tsx drives
// setActiveLocale from the session profile; tr() reads the active locale.
// The <Tr> component that renders link syntax lives in components/tr.tsx.

import { en, type TranslationEntry } from "./translations/en";
import { zh_cn } from "./translations/zh_cn";
import { zh_hant } from "./translations/zh_hant";

const catalogs: Record<string, Record<string, TranslationEntry>> = { en, zh_cn, zh_hant };
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

// --- locale selection -------------------------------------------------------

// The locale tr() resolves against. locale-gate.tsx is the only writer outside
// tests; it remounts the page subtree when the value changes, so no component
// keeps text rendered under a previous locale.
let activeLocale = defaultLocale;

export function getActiveLocale(): string {
  return activeLocale;
}

export function setActiveLocale(locale: string): void {
  activeLocale = catalogs[locale] !== undefined ? locale : defaultLocale;
}

// parse-locale in app.util.i18n: "zh-Hant" -> ["zh_hant", "zh"]. The
// two-letter candidate only matches an exact catalog; there is no bare "zh"
// catalog, mirroring the supported-locales set of the CLJS app.
function localeCandidates(locale: string): string[] {
  const normalized = locale.toLowerCase().replace(/-/g, "_");
  return normalized.includes("_") ? [normalized, normalized.slice(0, 2)] : [normalized];
}

function firstAvailable(input: string | null | undefined): string | undefined {
  if (input === null || input === undefined || input.length === 0) return undefined;
  return localeCandidates(input).find((candidate) => catalogs[candidate] !== undefined);
}

// Resolve the locale for a profile. Its lang wins whenever a catalog exists
// ("zh-CN" -> zh_cn); an empty lang ("Auto (browser)" in the settings) means
// autodetect from the browser, and anything unknown falls back to English,
// mirroring autodetect + set-locale in app.util.i18n.
export function matchLocale(
  lang: string | null | undefined,
  browserLanguage: string | null | undefined,
): string {
  if (lang !== null && lang !== undefined && lang.length > 0) {
    return firstAvailable(lang) ?? defaultLocale;
  }
  return firstAvailable(browserLanguage) ?? defaultLocale;
}

// BCP 47 tag for <html lang>: zh_cn -> zh-CN, zh_hant -> zh-Hant.
export function htmlLang(locale: string): string {
  const [language, region] = locale.split("_");
  if (region === undefined) return language;
  const tag = region.length === 2 ? region.toUpperCase() : region[0].toUpperCase() + region.slice(1);
  return `${language}-${tag}`;
}

export function lookup(key: string, locale: string = activeLocale): TranslationEntry | undefined {
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
// A label ending in |target:self marks an in-app link: the marked renderer in
// frontend/scripts/_helpers.js strips the suffix and emits target="_self".
const richRe = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;

const selfSuffix = "|target:self";

export interface RichSegment {
  text: string;
  href?: string;
  bold?: boolean;
  // Only set when the label declared target:self; plain links leave it off.
  self?: boolean;
}

export function richSegments(content: string): RichSegment[] {
  const segments: RichSegment[] = [];
  let last = 0;
  for (const match of content.matchAll(richRe)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ text: content.slice(last, start) });
    if (match[3] !== undefined) {
      segments.push({ text: match[3], bold: true });
    } else if (match[1].endsWith(selfSuffix)) {
      segments.push({
        text: match[1].slice(0, -selfSuffix.length),
        href: match[2],
        self: true,
      });
    } else {
      segments.push({ text: match[1], href: match[2] });
    }
    last = start + match[0].length;
  }
  if (last < content.length) segments.push({ text: content.slice(last) });
  return segments;
}
