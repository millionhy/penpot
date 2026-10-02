#!/usr/bin/env node
// S1: RPC command inventory scanner (read-only over backend/src).
//
// Statically extracts every `(sv/defmethod ::<name> ...)` registration from the
// Clojure backend and records: command name, source file, line, docstring,
// whether it requires authentication (::rpc/auth false => public), the raw
// ::sm/params and ::sm/result schema references and the ::doc/added version.
// The output (rpc-inventory.json) is the input for the F1.2 api-types
// generator; the backend is never modified.
//
// Usage: node scan-rpc-inventory.mjs [--backend <path/to/backend/src>] [--out <file>]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../../..");

function parseArgs(argv) {
  const args = { backend: path.join(repoRoot, "backend", "src"), out: path.resolve(scriptDir, "../rpc-inventory.json") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--backend") args.backend = path.resolve(argv[++i]);
    else if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
  }
  return args;
}

function walkCljFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkCljFiles(full));
    else if (entry.name.endsWith(".clj")) out.push(full);
  }
  return out.sort();
}

// Skip a double-quoted string starting at index i (handles \" escapes).
function skipString(src, i) {
  i++;
  while (i < src.length) {
    if (src[i] === "\\") i += 2;
    else if (src[i] === '"') return i + 1;
    else i++;
  }
  return i;
}

// Extract the balanced {...} block starting at the first "{" at/after index i.
function extractBraceBlock(src, i) {
  const start = src.indexOf("{", i);
  if (start < 0) return null;
  let depth = 0;
  let j = start;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '"') { j = skipString(src, j); continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return { text: src.slice(start, j + 1), end: j + 1 }; }
    j++;
  }
  return null;
}

// Extract the double-quoted string starting at the first non-space at/after i.
function extractDocstring(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== '"') return { text: null, end: i };
  const end = skipString(src, i);
  return { text: src.slice(i + 1, end - 1), end };
}

function restOfLine(src, i) {
  const nl = src.indexOf("\n", i);
  const line = src.slice(i, nl < 0 ? src.length : nl);
  return line.trim();
}

function schemaAfter(optsText, marker) {
  const idx = optsText.indexOf(marker);
  if (idx < 0) return null;
  // restOfLine may end on the opts map closing brace; strip it, then trim
  // surrounding quotes from string values like ::doc/added "1.15".
  let value = restOfLine(optsText, idx + marker.length).replace(/\}+\s*$/, "").trim();
  const quoted = value.match(/^"(.*)"$/);
  if (quoted) value = quoted[1];
  return value.length > 0 ? value : null;
}

// The (ns <name> ...) form at the top of the file; disambiguates commands
// registered from different namespaces (e.g. management helpers).
function fileNamespace(src) {
  const match = src.match(/^\(ns\s+([a-zA-Z0-9_.\-<>*!+]+)/m);
  return match ? match[1] : null;
}

function lineNumber(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

const DEFMETHOD = /\(sv\/defmethod\s+::([a-zA-Z0-9_*-]+)/g;

function scanFile(file, backendRoot, repoRootRel) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(repoRootRel, file).split(path.sep).join("/");
  const ns = fileNamespace(src);
  const commands = [];
  let match;
  DEFMETHOD.lastIndex = 0;
  while ((match = DEFMETHOD.exec(src)) !== null) {
    const name = match[1];
    let cursor = match.index + match[0].length;
    const doc = extractDocstring(src, cursor);
    const docstring = doc.text;
    cursor = doc.end;
    const opts = extractBraceBlock(src, cursor);
    const optsText = opts ? opts.text : "";
    commands.push({
      name,
      ns,
      file: rel,
      line: lineNumber(src, match.index),
      docstring: docstring && docstring.length > 0 ? docstring : null,
      auth: !/::rpc\/auth\s+false/.test(optsText),
      paramsSchema: schemaAfter(optsText, "::sm/params"),
      resultSchema: schemaAfter(optsText, "::sm/result"),
      added: schemaAfter(optsText, "::doc/added"),
    });
  }
  return commands;
}

const args = parseArgs(process.argv.slice(2));
if (!fs.existsSync(args.backend)) {
  console.error("backend source not found: " + args.backend);
  process.exit(1);
}
const files = walkCljFiles(args.backend);
const commands = [];
for (const file of files) commands.push(...scanFile(file, args.backend, repoRoot));
commands.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

const inventory = {
  generatedAt: new Date().toISOString(),
  source: path.relative(repoRoot, args.backend).split(path.sep).join("/"),
  count: commands.length,
  commands,
};
fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(inventory, null, 2) + "\n");

const publicCount = commands.filter((c) => !c.auth).length;
const withResult = commands.filter((c) => c.resultSchema).length;
const withParams = commands.filter((c) => c.paramsSchema).length;
console.log(`[S1] scanned ${files.length} .clj files under ${inventory.source}`);
console.log(`[S1] commands: ${commands.length} (public: ${publicCount}, params schema: ${withParams}, result schema: ${withResult})`);
console.log(`[S1] wrote ${path.relative(process.cwd(), args.out)}`);