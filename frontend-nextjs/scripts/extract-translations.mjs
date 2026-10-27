#!/usr/bin/env node
// Regenerate the typed catalogs in lib/translations/ from
// frontend/translations/<locale>.po, limited to the keys the Next.js shell
// actually uses.
//
// The CLJS app ships every translation to the browser and resolves keys at
// runtime (app.util.i18n). The shell only needs the keys of the pages already
// migrated, so this script scans the shell sources for static tr("...") call
// sites, for the key fields of data-driven views (see trFieldRe) and for the
// RUNTIME_KEYS list (keys the backend sends back for translation), then emits
// one typed catalog per entry of `locales` below. Re-run after migrating a
// page:
//
//   node scripts/extract-translations.mjs
//
// English is the source of truth: an unknown key fails the run, so a typo
// cannot silently render a raw key. The other catalogs cover what upstream has
// translated; keys missing or still empty there fall back to English at
// runtime (lib/i18n.ts), so the shell still renders no raw keys.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shellRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(shellRoot, "..");
const poDir = path.join(repoRoot, "frontend", "translations");
const outDir = path.join(shellRoot, "lib", "translations");

// Catalogs to emit. `code` names both the generated file and the catalog the
// runtime resolves (the locale values of supportedLocales in lib/settings.ts);
// `requireAll` marks the source-of-truth locale, whose catalog has to cover
// every used key.
const locales = [
  { code: "en", po: "en.po", label: "English", requireAll: true },
  { code: "zh_cn", po: "zh_CN.po", label: "Simplified Chinese", requireAll: false },
  { code: "zh_hant", po: "zh_Hant.po", label: "Traditional Chinese", requireAll: false },
];

const scanDirs = ["app", "components", "lib"];
const scanExtensions = new Set([".ts", ".tsx"]);
const skipDirs = new Set(["translations", "node_modules", ".next"]);
// Test files assert against catalog values; they are not call sites.
const skipFileRe = /\.test\.tsx?$/;

// Keys that reach tr() through a dynamic argument or stay out of the static
// call sites, so the scanner cannot see them. Mirrors the commented list
// next to the [:validation :weak-password] branch in
// frontend/src/app/main/ui/auth/register.cljs, plus the left-sidebar Tokens
// tab label (workspace-layers-panel keeps the CLJS literal on purpose, but
// the catalog carries the translation for i18n.test.ts).
const runtimeKeys = [
  "errors.weak-password.too-short",
  "errors.weak-password.insufficient-digits",
  "errors.weak-password.insufficient-lowercase",
  "errors.weak-password.insufficient-uppercase",
  "errors.weak-password.insufficient-special",
  "workspace.sidebar.tokens",
];

// --- gettext parsing -------------------------------------------------------

function unquote(body) {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    i += 1;
    if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") out += "\r";
    else out += next ?? "";
  }
  return out;
}

const quotedRe = /^"(.*)"$/;

function parsePo(text) {
  const entries = new Map();
  let current = null;
  let slot = null;

  const flush = () => {
    if (current === null) return;
    if (current.id.length > 0) {
      // Single-form locales (zh_Hant: nplurals=1) carry one msgstr[0] that
      // already includes the count; the app build reads a one-element msgstr
      // as a plain string, so mirror that instead of emitting [form, ""].
      const value =
        current.plurals.length >= 2
          ? [current.plurals[0] ?? "", current.plurals[1] ?? ""]
          : current.plurals.length === 1
            ? (current.plurals[0] ?? "")
            : current.str;
      entries.set(current.id, value);
    }
    current = null;
    slot = null;
  };

  const append = (rest) => {
    const match = quotedRe.exec(rest.trim());
    if (match === null || current === null || slot === null) return;
    const piece = unquote(match[1]);
    if (slot === "id") current.id += piece;
    else if (slot === "idPlural") current.idPlural += piece;
    else if (slot === "str") current.str += piece;
    else current.plurals[slot] = (current.plurals[slot] ?? "") + piece;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("#")) continue;
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    let match = /^msgid\s+(.*)$/.exec(line);
    if (match !== null) {
      flush();
      current = { id: "", idPlural: "", str: "", plurals: [] };
      slot = "id";
      append(match[1]);
      continue;
    }
    match = /^msgid_plural\s+(.*)$/.exec(line);
    if (match !== null) {
      slot = "idPlural";
      append(match[1]);
      continue;
    }
    match = /^msgstr\[(\d+)\]\s+(.*)$/.exec(line);
    if (match !== null) {
      slot = Number(match[1]);
      append(match[2]);
      continue;
    }
    match = /^msgstr\s+(.*)$/.exec(line);
    if (match !== null) {
      slot = "str";
      append(match[1]);
      continue;
    }
    // Bare continuation line of the previous msgid/msgstr.
    append(line);
  }
  flush();
  return entries;
}

// --- shell scanning --------------------------------------------------------

// Static call sites: tr("key") and the <Tr k="key"> component, which exists
// because a catalog entry may contain [label](url) link syntax.
const trCallRe = /\btr\(\s*"([^"\\]+)"/g;
const trElementRe = /<Tr\b[^>]*\bk="([^"\\]+)"/g;
// Data-driven call sites: a nav entry keeps the key in a field and the view
// hands it over as tr(item.labelKey), so trCallRe never sees the literal.
// settingsNav in lib/settings.ts is the only such view today; a new one has to
// extend this pattern or its labels render as raw keys.
const trFieldRe = /\blabelKey:\s*"([^"\\]+)"/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const full = path.join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) yield* walk(full);
    else if (scanExtensions.has(path.extname(full)) && !skipFileRe.test(full)) yield full;
  }
}

function collectUsedKeys() {
  const used = new Map();
  for (const dir of scanDirs) {
    const abs = path.join(shellRoot, dir);
    if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const file of walk(abs)) {
      const text = readFileSync(file, "utf8");
      for (const pattern of [trCallRe, trElementRe, trFieldRe]) {
        for (const match of text.matchAll(pattern)) {
          const key = match[1];
          if (!used.has(key)) used.set(key, path.relative(shellRoot, file));
        }
      }
    }
  }
  for (const key of runtimeKeys) used.set(key, "runtime (backend-provided key)");
  return used;
}

// --- emit ------------------------------------------------------------------

function isEmpty(value) {
  if (Array.isArray(value)) return value.every((part) => part.length === 0);
  return value.length === 0;
}

function emit(locale, catalog, keys) {
  const lines = keys.map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(catalog.get(key))},`);
  const fallback = locale.requireAll
    ? ""
    : "//\n// Keys missing or still empty upstream fall back to the English catalog\n// at runtime (lib/i18n.ts), so the shell never renders a raw key.\n";
  const typing = locale.requireAll
    ? "export type TranslationEntry = string | [string, string];\n"
    : 'import type { TranslationEntry } from "./en";\n';
  return `// GENERATED FILE - do not edit by hand.
// Regenerate with: node scripts/extract-translations.mjs
//
// ${locale.label} subset of frontend/translations/${locale.po}, limited to
// the keys the migrated shell pages use. Values keep the %s placeholders and
// the [label](url) link syntax of the source catalog; lib/i18n.ts resolves
// both.
${fallback}
${typing}
export const ${locale.code}: Record<string, TranslationEntry> = {
${lines.join("\n")}
};
`;
}

function main() {
  const used = collectUsedKeys();
  mkdirSync(outDir, { recursive: true });
  let failed = false;
  for (const locale of locales) {
    const catalog = parsePo(readFileSync(path.join(poDir, locale.po), "utf8"));
    const outPath = path.join(outDir, `${locale.code}.ts`);
    const keys = [...used.keys()]
      .filter((key) => catalog.has(key) && (locale.requireAll || !isEmpty(catalog.get(key))))
      .sort();
    writeFileSync(outPath, emit(locale, catalog, keys), "utf8");
    process.stdout.write(`extract-translations: ${locale.code} ${keys.length}/${used.size} keys -> ${path.relative(shellRoot, outPath)}\n`);
    if (locale.requireAll) {
      const missing = [...used.entries()].filter(([key]) => !catalog.has(key));
      for (const [key, where] of missing) {
        process.stderr.write(`  missing in ${locale.po}: ${key} (used by ${where})\n`);
      }
      if (missing.length > 0) failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}

main();
