#!/usr/bin/env node
// F1.2: Generate TypeScript types for the Penpot RPC surface.
//
// Inputs (all read-only):
//   - rpc-inventory.json (S1): the command list with ns/file/line/auth metadata.
//   - backend/src/**/*.clj: the malli schema forms behind each command's
//     ::sm/params and ::sm/result, plus every top-level `(def schema ...)` they
//     reference, and the ns alias tables needed to resolve ::sm/... keywords.
//
// Output: src/index.ts with RpcCommandName, RpcParams and RpcResults. The
// malli subset covered here matches what backend RPC schemas actually use
// (:map/:maybe/:vector/:set/:tuple/:enum/:or/:and/:merge/:map-of/:multi/:delay
// plus the app.common.schema primitives); anything unresolvable degrades to
// `unknown` and is reported in the run summary so the table can be extended.
//
// Usage: node scripts/generate-types.mjs [--backend <dir>] [--inventory <file>] [--out <file>]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(pkgRoot, "../../..");

const args = {
  backend: path.join(repoRoot, "backend", "src"),
  common: path.join(repoRoot, "common", "src"),
  inventory: path.join(pkgRoot, "rpc-inventory.json"),
  out: path.join(pkgRoot, "src", "index.ts"),
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--backend") args.backend = path.resolve(argv[++i]);
  else if (argv[i] === "--common") args.common = path.resolve(argv[++i]);
  else if (argv[i] === "--inventory") args.inventory = path.resolve(argv[++i]);
  else if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
}

// ---------------------------------------------------------------- scanning

function walkCljFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkCljFiles(full));
    else if (/\.(clj|cljc|cljs)$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

function skipString(src, i) {
  i++;
  while (i < src.length) {
    if (src[i] === "\\") i += 2;
    else if (src[i] === '"') return i + 1;
    else i++;
  }
  return i;
}

// String/comment aware balanced scan. src[start] must be `open`.
function scanBalanced(src, start, open, close) {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') { i = skipString(src, i); continue; }
    if (ch === ";") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "\\") { i += 2; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return -1;
}

// "#{...}" is not handled by scanBalanced (open/close differ); scan it here.
function scanSetLiteral(src, start) {
  let i = start + 2;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '"') { i = skipString(src, i); continue; }
    if (ch === ";") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "\\") { i += 2; continue; }
    if (depth === 0) return i + 1;
    i++;
  }
  return -1;
}

function skipWs(src, i) {
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === ";") { while (i < src.length && src[i] !== "\n") i++; continue; }
    break;
  }
  return i;
}

function skipMeta(src, i) {
  for (;;) {
    i = skipWs(src, i);
    if (src[i] !== "^") return i;
    i++;
    i = skipWs(src, i);
    if (src[i] === "{") i = scanBalanced(src, i, "{", "}");
    else { let j = i; while (j < src.length && !/[\s\[\]\{\}\(\)]/.test(src[j])) j++; i = j; }
  }
}

function extractNsInfo(src) {
  const idx = src.search(/\(ns\s/);
  if (idx < 0) return null;
  const end = scanBalanced(src, idx, "(", ")");
  if (end < 0) return null;
  const form = src.slice(idx, end);
  // Token-wise name extraction: a regex with a greedy [^\s]* backtrack can
  // silently capture a suffix of the ns name instead.
  const parts = form.split(/[\s[\](){}]+/).filter(Boolean);
  let ns = null;
  for (let k = 1; k < parts.length; k++) {
    if (parts[k] === "ns" || parts[k].startsWith("^")) continue;
    ns = parts[k];
    break;
  }
  const aliases = {};
  const aliasRe = /\[\s*([a-z][a-z0-9.\-]*)\s+:as(?:-alias)?\s+([^\]\s]+)\s*\]/g;
  let m;
  while ((m = aliasRe.exec(form)) !== null) aliases[m[2]] = m[1];
  // [some.ns :refer [a b]] makes bare symbols a/b resolve to some.ns/a|b.
  const refer = {};
  const referRe = /\[\s*([a-z][a-z0-9.\-]*)\s+:refer\s+\[([^\]]*)\]/g;
  while ((m = referRe.exec(form)) !== null) {
    for (const sym of m[2].split(/[\s,]+/).filter(Boolean)) refer[sym] = m[1] + "/" + sym;
  }
  return { ns, aliases, refer };
}

// ------------------------------------------------------------- form parser

function parseForm(src, i) {
  i = skipWs(src, i);
  const ch = src[i];
  if (ch === undefined) return { form: null, next: i };
  if (ch === "[") {
    const items = [];
    i++;
    for (;;) {
      i = skipWs(src, i);
      if (src[i] === "]" || i >= src.length) { i++; break; }
      const r = parseForm(src, i);
      if (!r.form) break;
      items.push(r.form);
      i = r.next;
    }
    return { form: { t: "vec", items }, next: i };
  }
  if (ch === "(") {
    const items = [];
    i++;
    for (;;) {
      i = skipWs(src, i);
      if (src[i] === ")" || i >= src.length) { i++; break; }
      const r = parseForm(src, i);
      if (!r.form) break;
      items.push(r.form);
      i = r.next;
    }
    return { form: { t: "list", items }, next: i };
  }
  if (ch === "{") {
    const entries = [];
    i++;
    for (;;) {
      i = skipWs(src, i);
      if (src[i] === "}" || i >= src.length) { i++; break; }
      const k = parseForm(src, i);
      if (!k.form) break;
      const v = parseForm(src, k.next);
      entries.push([k.form, v.form]);
      i = v.next;
    }
    return { form: { t: "map", entries }, next: i };
  }
  if (ch === "#" && src[i + 1] === "{") {
    const items = [];
    i += 2;
    for (;;) {
      i = skipWs(src, i);
      if (src[i] === "}" || i >= src.length) { i++; break; }
      const r = parseForm(src, i);
      if (!r.form) break;
      items.push(r.form);
      i = r.next;
    }
    return { form: { t: "set", items }, next: i };
  }
  if (ch === "#" && src[i + 1] === "(") {
    const end = scanBalanced(src, i + 1, "(", ")");
    return { form: { t: "opaque" }, next: end < 0 ? src.length : end };
  }
  if (ch === "#" && src[i + 1] === '"') {
    const end = skipString(src, i + 1);
    return { form: { t: "regex" }, next: end };
  }
  if (ch === "#") {
    let j = i + 1;
    while (j < src.length && /[a-zA-Z0-9_.\-]/.test(src[j])) j++;
    const tag = src.slice(i + 1, j);
    const r = parseForm(src, j);
    return { form: { t: "tagged", tag, form: r.form }, next: r.next };
  }
  if (ch === "^") {
    const meta = parseForm(src, i + 1);
    return parseForm(src, meta.next);
  }
  if (ch === "'") return parseForm(src, i + 1);
  if (ch === '"') {
    const end = skipString(src, i);
    const raw = src.slice(i + 1, end - 1);
    return { form: { t: "str", value: raw.replace(/\\(["\\])/g, "$1") }, next: end };
  }
  if (ch === "\\") {
    let j = i + 1;
    while (j < src.length && !/[\s\[\]\{\}\(\)]/.test(src[j])) j++;
    return { form: { t: "str", value: src.slice(i + 1, j) }, next: j };
  }
  let j = i;
  while (j < src.length && !/[\s\[\]\{\}\(\)"';,]/.test(src[j])) j++;
  const tok = src.slice(i, j);
  if (tok.length === 0) return { form: { t: "opaque" }, next: i + 1 };
  if (tok === "true") return { form: { t: "bool", value: true }, next: j };
  if (tok === "false") return { form: { t: "bool", value: false }, next: j };
  if (tok === "nil") return { form: { t: "nil" }, next: j };
  if (/^-?\d/.test(tok)) return { form: { t: "num", raw: tok }, next: j };
  if (tok.startsWith("::")) {
    const rest = tok.slice(2);
    const slash = rest.indexOf("/");
    return {
      form: slash >= 0
        ? { t: "kw", dc: true, ns: rest.slice(0, slash), name: rest.slice(slash + 1), raw: tok }
        : { t: "kw", dc: true, ns: null, name: rest, raw: tok },
      next: j,
    };
  }
  if (tok.startsWith(":")) {
    const rest = tok.slice(1);
    const slash = rest.indexOf("/");
    return {
      form: slash >= 0
        ? { t: "kw", dc: false, ns: rest.slice(0, slash), name: rest.slice(slash + 1), raw: tok }
        : { t: "kw", dc: false, ns: null, name: rest, raw: tok },
      next: j,
    };
  }
  return { form: { t: "sym", raw: tok }, next: j };
}

function parseAll(src) {
  const r = parseForm(src, 0);
  return r.form;
}

// ------------------------------------------------------- schema collection

const files = [...walkCljFiles(args.backend), ...(fs.existsSync(args.common) ? walkCljFiles(args.common) : [])];
const fileCache = new Map();
// fq def key ("ns/name") -> { ns, aliases, form | dynamic:true }
const defs = new Map();

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  fileCache.set(file, src);
  const nsInfo = extractNsInfo(src);
  if (!nsInfo || !nsInfo.ns) continue;
  const defRe = /\n\(def\s+/g;
  let m;
  while ((m = defRe.exec(src)) !== null) {
    let i = m.index + m[0].length;
    i = skipMeta(src, i);
    let j = i;
    while (j < src.length && !/[\s\[\]\{\}\(\)]/.test(src[j])) j++;
    const name = src.slice(i, j);
    if (!name) continue;
    i = skipWs(src, j);
    if (src[i] === '"') i = skipString(src, i);
    i = skipWs(src, i);
    const fq = nsInfo.ns + "/" + name;
    const defCtx = { ns: nsInfo.ns, aliases: nsInfo.aliases, refer: nsInfo.refer };
    let form = null;
    if (src[i] === "[") {
      const end = scanBalanced(src, i, "[", "]");
      if (end > 0) form = parseAll(src.slice(i, end));
    } else if (src[i] === "#" && src[i + 1] === "{") {
      // set literal (e.g. valid-roles): capture as a set form
      const end = scanSetLiteral(src, i);
      if (end > 0) form = parseAll(src.slice(i, end));
    } else if (src[i] === "(") {
      // (def x (sm/register! ^{::sm/type ::t} [:schema props inner])) ->
      // unwrap to the inner schema vector when recognizable.
      const end = scanBalanced(src, i, "(", ")");
      if (end > 0) {
        const list = parseAll(src.slice(i, end));
        if (list && list.t === "list" && list.items.length > 0 &&
            list.items[0].t === "sym" && /register!$/.test(list.items[0].raw)) {
          for (let k = list.items.length - 1; k >= 1; k--) {
            if (list.items[k].t === "vec") { form = list.items[k]; break; }
          }
        } else if (list && list.t === "list" && list.items.length >= 2 &&
                   list.items[0].t === "sym" && list.items[0].raw === "->" &&
                   list.items[1].t === "list" && list.items[1].items.length >= 3 &&
                   list.items[1].items[0].t === "sym" && list.items[1].items[0].raw === "reduce" &&
                   list.items[1].items[1].t === "sym" && /union$/.test(list.items[1].items[1].raw) &&
                   list.items[1].items[2].t === "vec") {
          // (-> (reduce mu/union [A B ...]) ...) == union of maps == intersection type
          form = {
            t: "vec",
            items: [{ t: "kw", dc: false, ns: null, name: "and", raw: ":and" }].concat(list.items[1].items[2].items),
          };
        }
      }
    }
    if (form) defs.set(fq, { ...defCtx, form });
    else defs.set(fq, { ...defCtx, dynamic: true });
  }
}

// ------------------------------------------------------------ compilation

const SM = "app.common.schema/";
const CT = "app.common.time/";

// TS mapping for the app.common.schema registered primitives and a few other
// well-known refs. Values are final TS type strings.
const PRIMITIVES = {
  [SM + "uuid"]: "string",
  [SM + "user-provided-uuid"]: "string",
  [SM + "email"]: "string",
  [SM + "text"]: "string",
  [SM + "word-string"]: "string",
  [SM + "password"]: "string",
  [SM + "uri"]: "string",
  [SM + "boolean"]: "boolean",
  [SM + "int"]: "number",
  [SM + "integer"]: "number",
  [SM + "safe-int"]: "number",
  [SM + "double"]: "number",
  [SM + "safe-double"]: "number",
  [SM + "number"]: "number",
  [SM + "safe-number"]: "number",
  [SM + "non-negative-safe-number"]: "number",
  [SM + "positive-safe-number"]: "number",
  [SM + "keyword"]: "string",
  [SM + "set-of-strings"]: "string[]",
  [SM + "set-of-keywords"]: "string[]",
  [SM + "set-of-uuid"]: "string[]",
  [SM + "coll-of-uuid"]: "string[]",
  [SM + "bytes"]: "Uint8Array",
  [SM + "any"]: "unknown",
  [SM + "fn"]: "unknown",
  [SM + "contains-any"]: "unknown",
  [SM + "one-of"]: "unknown",
  [SM + "atom"]: "unknown",
  [SM + "agent"]: "unknown",
  [CT + "inst"]: "Date",
  [CT + "duration"]: "number",
  [CT + "schema:inst"]: "Date",
  [SM + "inst"]: "Date",
  "datoteka.fs/path": "string",
  "app.common.features/features": "string[]",
  "app.common.geom.point/point": "{ x: number; y: number }",
  "app.common.geom.matrix/matrix": "{ a: number; b: number; c: number; d: number; e: number; f: number }",
  "app.common.geom.matrix/schema:matrix": "{ a: number; b: number; c: number; d: number; e: number; f: number }",
  "app.common.geom.rect/rect": "{ x: number; y: number; width: number; height: number; x1: number; y1: number; x2: number; y2: number }",
  "app.common.types.color/schema:hex-color": "string",
  "app.common.types.color/hex-color": "string",
  "clojure.core/uuid": "string",
};

// malli built-in simple types referenced as bare keywords.
const BUILTIN = {
  string: "string",
  int: "number",
  double: "number",
  number: "number",
  boolean: "boolean",
  keyword: "string",
  symbol: "string",
  any: "unknown",
  nil: "null",
  uuid: "string",
  inst: "Date",
  re: "string",
  fn: "unknown",
  "pos-int": "number",
  neg: "number",
  nat: "number",
  "pos-double": "number",
  map: "Record<string, unknown>",
  vector: "unknown[]",
  sequential: "unknown[]",
  set: "unknown[]",
};

const unresolvedRefs = new Map();
function unresolved(ref, ctx) {
  const key = ctx && ctx.ns ? ref + "  @ns=" + ctx.ns : ref;
  unresolvedRefs.set(key, (unresolvedRefs.get(key) ?? 0) + 1);
  return "unknown";
}

const defStack = new Set();

function qualify(kw, ctx) {
  if (kw.ns === null) return kw.dc ? ctx.ns + "/" + kw.name : null;
  if (kw.dc) return (ctx.aliases[kw.ns] ?? kw.ns) + "/" + kw.name;
  return kw.ns + "/" + kw.name;
}

function literal(form) {
  if (!form) return "unknown";
  switch (form.t) {
    case "str": return JSON.stringify(form.value);
    case "num": return form.raw;
    case "bool": return String(form.value);
    case "nil": return "null";
    case "kw": return JSON.stringify(form.name);
    case "sym": return JSON.stringify(form.raw);
    default: return "unknown";
  }
}

function resolveRef(form, ctx) {
  if (!form) return "unknown";
  if (form.t === "kw") {
    const fq = qualify(form, ctx);
    if (fq === null) return BUILTIN[form.name] ?? unresolved(form.raw, ctx);
    if (PRIMITIVES[fq]) return PRIMITIVES[fq];
    return compileDef(fq, ctx);
  }
  if (form.t === "sym") {
    const slash = form.raw.lastIndexOf("/");
    let fq;
    if (slash >= 0) {
      // Qualified symbol: the prefix is usually an ns ALIAS (media.v/...,
      // ct/..., types.team/...), exactly like Clojure var resolution.
      const prefix = form.raw.slice(0, slash);
      const ns = (ctx.aliases && ctx.aliases[prefix]) || prefix;
      fq = ns + "/" + form.raw.slice(slash + 1);
    } else {
      fq = (ctx.refer && ctx.refer[form.raw]) || ctx.ns + "/" + form.raw;
    }
    if (PRIMITIVES[fq]) return PRIMITIVES[fq];
    return compileDef(fq, ctx);
  }
  return compile(form, ctx);
}

function compileDef(fq, ctx) {
  if (defStack.has(fq)) return "unknown"; // recursive schema
  const def = defs.get(fq);
  if (!def) return unresolved(fq, ctx);
  if (def.dynamic || !def.form) return unresolved(fq + " (dynamic)", ctx);
  defStack.add(fq);
  const out = compile(def.form, { ns: def.ns, aliases: def.aliases, refer: def.refer });
  defStack.delete(fq);
  return out;
}

// [::sm/one-of coll] validates membership in a fixed set of values; compile
// to a literal union when the values are statically known.
function oneOf(rest, ctx) {
  const child = rest[0];
  if (!child) return "string";
  let items = null;
  if (child.t === "vec" || child.t === "set") items = child.items;
  if (child.t === "sym") {
    const slash = child.raw.lastIndexOf("/");
    const fq = slash >= 0
      ? ((ctx.aliases[child.raw.slice(0, slash)] || child.raw.slice(0, slash)) + "/" + child.raw.slice(slash + 1))
      : ((ctx.refer && ctx.refer[child.raw]) || ctx.ns + "/" + child.raw);
    const def = defs.get(fq);
    if (def && def.form && (def.form.t === "set" || def.form.t === "vec")) items = def.form.items;
  }
  if (!items || items.length === 0) return "string";
  return "(" + items.map(literal).join(" | ") + ")";
}

function compileMapBody(items, ctx) {
  const fields = [];
  for (const entry of items) {
    if (entry.t !== "vec" || entry.items.length === 0) continue;
    const parts = entry.items;
    const keyForm = parts[0];
    let key = null;
    if (keyForm.t === "kw") key = JSON.stringify(keyForm.ns ? keyForm.ns + "/" + keyForm.name : keyForm.name);
    else if (keyForm.t === "str") key = JSON.stringify(keyForm.value);
    let rest = parts.slice(1);
    let optional = false;
    if (rest.length > 1 && rest[0].t === "map") {
      for (const [k, v] of rest[0].entries) {
        if (k.t === "kw" && k.name === "optional" && v.t === "bool" && v.value) optional = true;
      }
      rest = rest.slice(1);
    }
    const ts = rest.length > 0 ? compile(rest[rest.length - 1], ctx) : "unknown";
    if (key === null) { fields.push("[key: string]: " + ts); continue; }
    fields.push(key + (optional ? "?" : "") + ": " + ts);
  }
  if (fields.length === 0) return "Record<string, never>";
  return "{ " + fields.join("; ") + " }";
}

function compile(form, ctx) {
  if (!form) return "unknown";
  switch (form.t) {
    case "kw": return resolveRef(form, ctx);
    case "sym": return resolveRef(form, ctx);
    case "str": return "string";
    case "num": return "number";
    case "bool": return "boolean";
    case "nil": return "null";
    case "regex": return "string";
    case "tagged":
      if (form.tag === "uuid") return "string";
      return "unknown";
    case "set": return "unknown";
    case "list": return "unknown";
    case "map": return compileMapBody(form.entries.map(([k, v]) => ({ t: "vec", items: [k, v] })), ctx);
    case "vec": {
      const items = form.items;
      const head = items[0];
      if (!head) return "unknown";
      if (head.t !== "kw") {
        // Not a schema vector head; treat as opaque value.
        return "unknown";
      }
      const fq = qualify(head, ctx);
      let rest = items.slice(1);
      if (rest.length > 0 && rest[0].t === "map") rest = rest.slice(1);
      const name = head.name;
      if (fq === null) {
        switch (name) {
          case "map": return compileMapBody(rest, ctx);
          case "=": return rest.length > 0 ? literal(rest[0]) : "unknown";
          case "maybe": return "(" + compile(rest[0], ctx) + " | null)";
          case "vector": case "sequential": return "Array<" + compile(rest[0], ctx) + ">";
          case "set": return "Array<" + compile(rest[0], ctx) + ">";
          case "tuple": return "[" + rest.map((f) => compile(f, ctx)).join(", ") + "]";
          case "enum": return rest.length > 1 ? "(" + rest.map(literal).join(" | ") + ")" : rest.map(literal).join(" | ");
          case "or": return "(" + rest.map((f) => compile(f, ctx)).join(" | ") + ")";
          case "and": case "merge": return "(" + rest.map((f) => compile(f, ctx)).join(" & ") + ")";
          case "map-of": return "Record<string, " + compile(rest[1], ctx) + ">";
          case "multi": {
            const variants = rest.filter((f) => f.t === "vec" && f.items.length >= 2)
              .map((f) => compile(f.items[f.items.length - 1], ctx));
            return variants.length > 0 ? "(" + variants.join(" | ") + ")" : "unknown";
          }
          case "delay": return compile(rest[0], ctx);
          case "schema": return resolveRef(rest[0], ctx);
          case "re": return "string";
          case "fn": return "unknown";
          case "string": return "string";
          case "int": case "double": case "number": return "number";
          case "boolean": return "boolean";
          case "cat": return "[" + rest.map((f) => compile(f, ctx)).join(", ") + "]";
          default: return unresolved(head.raw, ctx);
        }
      }
      // qualified head: primitive or named schema, optionally parameterized
      if (fq === SM + "vec" || fq === SM + "set") {
        return rest.length > 0 ? "Array<" + compile(rest[0], ctx) + ">" : "unknown[]";
      }
      if (fq === SM + "one-of") {
        return oneOf(rest, ctx);
      }
      if (PRIMITIVES[fq]) return PRIMITIVES[fq];
      return resolveRef(head, ctx);
    }
    default: return "unknown";
  }
}

// --------------------------------------------------------- command schemas

// --debug-file <path>: print the ns info + collected defs of one file (dev aid)
if (argv.includes("--debug-file")) {
  const target = path.resolve(argv[argv.indexOf("--debug-file") + 1]);
  const src = fs.readFileSync(target, "utf8");
  const info = extractNsInfo(src);
  console.log(JSON.stringify({ ns: info && info.ns, aliases: info && info.aliases, refer: info && info.refer }, null, 2));
  for (const [k, v] of defs) if (info && k.startsWith(info.ns + "/")) console.log("def:", k, v.dynamic ? "(dynamic)" : JSON.stringify(v.form).slice(0, 120));
  process.exit(0);
}

const inventory = JSON.parse(fs.readFileSync(args.inventory, "utf8"));

// Extract the raw ::sm/params / ::sm/result value forms from a defmethod opts
// block (balanced capture, unlike the inventory's rest-of-line strings).
function extractSchemaRef(src, optsStart) {
  const optsEnd = scanBalanced(src, optsStart, "{", "}");
  if (optsEnd < 0) return { params: null, result: null };
  const opts = src.slice(optsStart, optsEnd);
  function valueOf(marker) {
    const idx = opts.indexOf(marker);
    if (idx < 0) return null;
    let i = skipWs(opts, idx + marker.length);
    if (opts[i] === "[") {
      const end = scanBalanced(opts, i, "[", "]");
      return end > 0 ? { inline: opts.slice(i, end) } : null;
    }
    let j = i;
    while (j < opts.length && !/[\s\}\]]/.test(opts[j])) j++;
    const tok = opts.slice(i, j);
    return tok.length > 0 ? { ref: tok } : null;
  }
  return { params: valueOf("::sm/params"), result: valueOf("::sm/result") };
}

function lineOffsets(src) {
  const offsets = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") offsets.push(i + 1);
  return offsets;
}

const commands = [];
let paramsResolved = 0;
let resultsResolved = 0;

for (const command of inventory.commands) {
  const src = fileCache.get(path.join(repoRoot, command.file));
  if (src === undefined) continue;
  const offsets = lineOffsets(src);
  const start = offsets[command.line - 1] ?? 0;
  const marker = "(sv/defmethod ::" + command.name;
  const at = src.indexOf(marker, Math.max(0, start - 1));
  if (at < 0) continue;
  let i = at + marker.length;
  i = skipMeta(src, i);
  i = skipWs(src, i);
  if (src[i] === '"') i = skipString(src, i);
  i = skipWs(src, i);
  const nsInfo = extractNsInfo(src);
  const ctx = {
    ns: command.ns ?? (nsInfo ? nsInfo.ns : null),
    aliases: nsInfo ? nsInfo.aliases : {},
    refer: nsInfo ? nsInfo.refer : {},
  };
  let params = "Record<string, unknown>";
  let result = null;
  if (src[i] === "{") {
    const refs = extractSchemaRef(src, i);
    if (refs.params) {
      const form = refs.params.inline ? parseAll(refs.params.inline) : refs.params.ref ? parseAll(refs.params.ref) : null;
      const compiled = form ? compile(form, ctx) : "Record<string, unknown>";
      params = compiled === "unknown" ? "Record<string, unknown>" : compiled;
      if (params !== "Record<string, unknown>") paramsResolved++;
    }
    if (refs.result) {
      const form = refs.result.inline ? parseAll(refs.result.inline) : refs.result.ref ? parseAll(refs.result.ref) : null;
      if (form) { result = compile(form, ctx); if (result !== "unknown") resultsResolved++; else result = null; }
    }
  }
  commands.push({ ...command, tsParams: params, tsResult: result });
}

// ------------------------------------------------------------------ output

function tsKey(name) {
  return JSON.stringify(name);
}

// Deduplicate by command NAME: the public RPC surface (/api/main/methods) is
// keyed by name, so internal management registrations that reuse a name (e.g.
// app.rpc.management.nitrate/get-teams) must not produce duplicate type keys.
// Prefer the app.rpc.commands.* registration; otherwise keep the first.
const byName = new Map();
for (const c of commands) {
  const prev = byName.get(c.name);
  if (!prev || (!prev.ns.startsWith("app.rpc.commands.") && c.ns.startsWith("app.rpc.commands."))) {
    byName.set(c.name, c);
  }
}
const unique = [...byName.values()];
const skipped = commands.length - unique.length;

const lines = [];
lines.push("// Generated by scripts/generate-types.mjs - DO NOT EDIT BY HAND.");
lines.push("// Source: backend/src sv/defmethod registrations and their malli schemas");
lines.push("// (static, read-only scan; the Clojure backend is never modified).");
lines.push("// Regenerate: node scripts/generate-types.mjs");
lines.push("//");
lines.push("// " + unique.length + " commands; params typed: " + paramsResolved + "; results typed: " + resultsResolved + ".");
lines.push("// Unresolvable schema refs degrade to unknown (see generator summary).");
lines.push("");
lines.push("export type RpcCommandName =");
unique.forEach((c, idx) => {
  lines.push("  | " + tsKey(c.name) + (idx === unique.length - 1 ? ";" : ""));
});
lines.push("");
lines.push("export type RpcPublicCommandName =");
const publicCommands = unique.filter((c) => !c.auth);
if (publicCommands.length === 0) lines.push("  never;");
else publicCommands.forEach((c, idx) => {
  lines.push("  | " + tsKey(c.name) + (idx === publicCommands.length - 1 ? ";" : ""));
});
lines.push("");
lines.push("// Command params (transit request body decoded shape). Commands without a");
lines.push("// ::sm/params schema accept an arbitrary map.");
lines.push("export interface RpcParams {");
for (const c of unique) lines.push("  " + tsKey(c.name) + ": " + c.tsParams + ";");
lines.push("}");
lines.push("");
lines.push("// Command results, only for commands that declare ::sm/result. Others");
lines.push("// return unknown at the type level (add ::sm/result upstream in Phase B).");
lines.push("export interface RpcResults {");
for (const c of unique) {
  if (c.tsResult !== null) lines.push("  " + tsKey(c.name) + ": " + c.tsResult + ";");
}
lines.push("}");
lines.push("");
lines.push("export type RpcParamsOf<C extends RpcCommandName> = C extends keyof RpcParams ? RpcParams[C] : Record<string, unknown>;");
lines.push("export type RpcResultOf<C extends RpcCommandName> = C extends keyof RpcResults ? RpcResults[C] : unknown;");
lines.push("");

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, lines.join("\n"));

const sortedUnresolved = [...unresolvedRefs.entries()].sort((a, b) => b[1] - a[1]);
console.log("[F1.2] commands: " + unique.length + " (public: " + publicCommands.length + ", deduped: " + skipped + ")");
console.log("[F1.2] params typed: " + paramsResolved + " / " + unique.length + "; results typed: " + resultsResolved);
const shown = sortedUnresolved.length <= 40 ? sortedUnresolved : sortedUnresolved.slice(0, 10);
console.log("[F1.2] unresolved refs: " + sortedUnresolved.length + (shown.length ? " (" + shown.map(([k, v]) => k + " x" + v).join(", ") + ")" : ""));
console.log("[F1.2] wrote " + path.relative(process.cwd(), args.out));