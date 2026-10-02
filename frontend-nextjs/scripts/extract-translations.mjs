#!/usr/bin/env node
// Regenerate lib/translations/en.ts from frontend/translations/en.po, limited
// to the keys the Next.js shell actually uses.
//
// The CLJS app ships every translation to the browser and resolves keys at
// runtime (app.util.i18n). The shell only needs the keys of the pages already
// migrated, so this script scans the shell sources for static tr("...") call
// sites, for the key fields of data-driven views (see trFieldRe) and for the
// RUNTIME_KEYS list (keys the backend sends back for translation), then emits
// a typed catalog. Re-run after migrating a page:
//
//   node scripts/extract-translations.mjs
//
// An unknown key fails the run, so a typo cannot silently render a raw key.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shellRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(shellRoot, "..");
const poPath = path.join(repoRoot, "frontend", "translations", "en.po");
const outPath = path.join(shellRoot, "lib", "translations", "en.ts");

const scanDirs = ["app", "components", "lib"];
const scanExtensions = new Set([".ts", ".tsx"]);
const skipDirs = new Set(["translations", "node_modules", ".next"]);
// Test files assert against catalog values; they are not call sites.
const skipFileRe = /\.test\.tsx?$/;

// Keys that reach tr() through a dynamic argument, so the scanner cannot see
// them. Mirrors the commented list next to the [:validation :weak-password]
// branch in frontend/src/app/main/ui/auth/register.cljs.
const runtimeKeys = [
  "errors.weak-password.too-short",
  "errors.weak-password.insufficient-digits",
  "errors.weak-password.insufficient-lowercase",
  "errors.weak-password.insufficient-uppercase",
  "errors.weak-password.insufficient-special",
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
      const value =
        current.plurals.length > 0
          ? [current.plurals[0] ?? "", current.plurals[1] ?? ""]
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

function emit(catalog, used) {
  const keys = [...used.keys()].filter((key) => catalog.has(key)).sort();
  const lines = keys.map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(catalog.get(key))},`);
  return `// GENERATED FILE - do not edit by hand.
// Regenerate with: node scripts/extract-translations.mjs
//
// Subset of frontend/translations/en.po limited to the keys used by the
// migrated shell pages. Values keep the %s placeholders and the
// [label](url) link syntax of the source catalog; lib/i18n.tsx resolves both.

export type TranslationEntry = string | [string, string];

export const en: Record<string, TranslationEntry> = {
${lines.join("\n")}
};
`;
}

function main() {
  const catalog = parsePo(readFileSync(poPath, "utf8"));
  const used = collectUsedKeys();
  const missing = [...used.entries()].filter(([key]) => !catalog.has(key));
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, emit(catalog, used), "utf8");
  const found = used.size - missing.length;
  process.stdout.write(`extract-translations: ${found}/${used.size} keys -> ${path.relative(shellRoot, outPath)}\n`);
  if (missing.length > 0) {
    for (const [key, where] of missing) {
      process.stderr.write(`  missing in en.po: ${key} (used by ${where})\n`);
    }
    process.exitCode = 1;
  }
}

main();
