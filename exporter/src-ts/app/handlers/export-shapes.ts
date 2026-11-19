// app.handlers.export-shapes: the `export-shapes` command.
//
// One export renders a single file and hands back its resource; several
// exports share a zip. Exports that ask for the headless backend are grouped
// and rendered on one leased worker, browser exports keep one DOM page per
// partition of fifty objects.
//
// Mirrors `exporter/src/app/handlers/export_shapes.cljs`. The renderer, the
// resource helpers, the job tracker and the filesystem calls are injectable so
// tests run the whole command without a backend, a browser or disk access.

import { raise } from "../errors.js";
import * as jobs from "../jobs.js";
import type { Job, Resource } from "../jobs.js";
import * as jobUtils from "../jobs/utils.js";
import { headless, render, withScope } from "../renderer.js";
import type { OnObject, RenderObject, RenderParams, RenderType } from "../renderer.js";
import { getExtension, type ExportType } from "../util/mime.js";
import { move } from "../util/shell.js";
import type { Prepared, ResourceHandle } from "./export.js";
import * as resources from "./resources.js";

type Dict = Record<string, unknown>;

// Regex to clean namefiles
const SANITIZE = /[\\/:*?"<>|]/g;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_PARTITION_SIZE = 50;

// --- injectable collaborators

export interface ExportShapesDeps {
  createResource: typeof resources.create;
  createZip: typeof resources.createZip;
  addToZip: typeof resources.addToZip;
  closeZip: typeof resources.closeZip;
  uploadResource: typeof resources.uploadResource;
  render: typeof render;
  withScope: typeof withScope;
  headless: typeof headless;
  track: typeof jobUtils.track;
  move: typeof move;
  progress: typeof jobs.progress;
  checkCancelled: typeof jobs.checkCancelled;
}

const defaultDeps: ExportShapesDeps = {
  createResource: resources.create,
  createZip: resources.createZip,
  addToZip: resources.addToZip,
  closeZip: resources.closeZip,
  uploadResource: resources.uploadResource,
  render,
  withScope,
  headless,
  track: jobUtils.track,
  move,
  progress: jobs.progress,
  checkCancelled: jobs.checkCancelled,
};

let deps: ExportShapesDeps = defaultDeps;

export function setDeps(next?: Partial<ExportShapesDeps>): void {
  deps = { ...defaultDeps, ...next };
}

export function resetDeps(): void {
  deps = defaultDeps;
}

// --- params validation
//
// The CLJS spec is a `s/keys` envelope plus one spec per export entry. Only
// the first problem of each key is reported, which is what the explain text
// shows; the exact expound wording is not reproduced (nothing parses it).

interface Problem {
  path: Array<string | number>;
  pred: string;
}

function problem(path: Array<string | number>, pred: string): Problem {
  return { path, pred };
}

function isRecord(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function invalid(problems: Problem[]): never {
  return raise({ type: "validation", code: "spec-validation", hint: "invalid params", problems });
}

function checkExportsEntry(entry: unknown, index: number, problems: Problem[]): void {
  if (!isRecord(entry)) {
    problems.push(problem(["exports", index], "should be a map"));
    return;
  }

  for (const key of ["page-id", "file-id", "object-id"]) {
    if (!isUuid(entry[key])) problems.push(problem(["exports", index, key], "should be a uuid"));
  }

  if (typeof entry.type !== "string" || entry.type === "") {
    problems.push(problem(["exports", index, "type"], "should be a keyword"));
  }

  for (const key of ["suffix", "name"]) {
    if (typeof entry[key] !== "string") problems.push(problem(["exports", index, key], "should be a string"));
  }

  if (typeof entry.scale !== "number" || Number.isNaN(entry.scale)) {
    problems.push(problem(["exports", index, "scale"], "should be a number"));
  }

  if (entry["share-id"] !== undefined && !isUuid(entry["share-id"])) {
    problems.push(problem(["exports", index, "share-id"], "should be a uuid"));
  }
}

export function conformShapesParams(params: Dict): Dict {
  const problems: Problem[] = [];

  if (!isUuid(params["profile-id"])) problems.push(problem(["profile-id"], "should be a uuid"));

  const exports = params.exports;
  if (!Array.isArray(exports) || exports.length === 0) {
    problems.push(problem(["exports"], "should be a non-empty vector"));
  } else {
    exports.forEach((entry, index) => checkExportsEntry(entry, index, problems));
  }

  if (params.wait !== undefined && typeof params.wait !== "boolean") {
    problems.push(problem(["wait"], "should be a boolean"));
  }

  if (params.name !== undefined && typeof params.name !== "string") {
    problems.push(problem(["name"], "should be a string"));
  }

  if (params["is-wasm"] !== undefined && typeof params["is-wasm"] !== "boolean") {
    problems.push(problem(["is-wasm"], "should be a boolean"));
  }

  if (problems.length > 0) invalid(problems);

  return params;
}

// --- export preparation

export interface PreparedExport {
  "file-id": string;
  "page-id": string;
  "share-id"?: string;
  name: string;
  token?: string;
  type: ExportType;
  scale: number;
  objects: RenderObject[];
}

function exportType(value: string): ExportType {
  switch (value) {
    case "png":
    case "jpeg":
    case "webp":
    case "svg":
    case "pdf":
    case "zip":
      return value;
    default:
      return raise({
        type: "internal",
        code: "unknown-export-type",
        hint: `unknown export type: ${value}`,
      });
  }
}

function nextFileName(entry: Dict, type: ExportType, used: Set<string>): string {
  const name = String(entry.name ?? "");
  const suffix = entry.suffix === undefined || entry.suffix === null ? "" : String(entry.suffix);
  const extension = getExtension(type);

  for (let index = 0; ; index += 1) {
    const candidate = `${name}${suffix}${index > 0 ? `-${index + 1}` : ""}${extension}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function partEntryToObject(entry: Dict): RenderObject {
  return {
    id: String(entry["object-id"]),
    filename: String(entry.filename ?? ""),
    name: String(entry.name ?? ""),
    suffix: String(entry.suffix ?? ""),
  };
}

function buildRender(part: Dict[]): PreparedExport {
  const first = part[0];
  const prepared: PreparedExport = {
    "file-id": String(first["file-id"]),
    "page-id": String(first["page-id"]),
    name: String(first.name ?? ""),
    type: first.type as ExportType,
    scale: Number(first.scale),
    objects: part.map(partEntryToObject),
  };

  if (typeof first.token === "string") prepared.token = first.token;
  if (first["share-id"] !== undefined && first["share-id"] !== null) {
    prepared["share-id"] = String(first["share-id"]);
  }

  return prepared;
}

// Browser path renders one DOM page per partition of fifty objects; headless
// WASM takes the whole group in one render.
export function prepareExports(
  exports: readonly Dict[],
  token: string | undefined,
  isWasm: unknown,
): PreparedExport[] {
  const used = new Set<string>();
  const entries: Dict[] = exports.map((entry) => {
    const type = exportType(String(entry.type));
    return { ...entry, type, filename: nextFileName(entry, type, used), token };
  });

  const groups = new Map<string, Dict[]>();
  for (const entry of entries) {
    const key = `${String(entry.scale)}\u0000${String(entry.type)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [entry]);
    else group.push(entry);
  }

  const prepared: PreparedExport[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (deps.headless({ "is-wasm": isWasm === true, type: first.type as RenderType })) {
      prepared.push(buildRender(group));
    } else {
      for (let index = 0; index < group.length; index += DEFAULT_PARTITION_SIZE) {
        prepared.push(buildRender(group.slice(index, index + DEFAULT_PARTITION_SIZE)));
      }
    }
  }

  return prepared;
}

export function countObjects(exports: readonly { objects?: readonly unknown[] }[]): number {
  return exports.reduce((total, entry) => total + (entry.objects?.length ?? 0), 0);
}

// Whether any of `exports` renders headless, and so whether the job leases a
// render worker. Mirrors what `withScope` decides at run time.
export function headlessExports(exports: readonly PreparedExport[], isWasm: unknown): boolean {
  return exports.some((entry) => deps.headless({ "is-wasm": isWasm === true, type: entry.type }));
}

function renderParams(entry: PreparedExport, job: Job, isWasm: unknown, skipChildren?: unknown): RenderParams {
  const params: RenderParams = {
    ...entry,
    type: entry.type as RenderType,
    "is-wasm": isWasm === true,
    "job-id": String(job.id),
  };

  if (skipChildren !== undefined) params["skip-children"] = Boolean(skipChildren);
  return params;
}

// --- run

async function runSingle(
  job: Job,
  authToken: string | undefined,
  resource: ResourceHandle,
  options: { export: PreparedExport; isWasm: unknown; skipChildren: unknown },
): Promise<Resource> {
  deps.track(String(job.id), resource.path);
  deps.checkCancelled(job);

  const params = renderParams(options.export, job, options.isWasm, options.skipChildren);
  const moves: Array<Promise<void>> = [];

  const onObject: OnObject = (object) => {
    deps.track(String(job.id), object.path);
    // The render finished writing the file before it reports it, so the rename
    // can start at once. Collecting the promises keeps a failed rename from
    // being swallowed.
    if (object.path !== undefined) moves.push(deps.move(object.path, resource.path));
  };

  await deps.render(params, onObject);
  await Promise.all(moves);

  const uploaded = await deps.uploadResource(authToken, resource);
  const { path: _path, ...rest } = uploaded;
  return rest as unknown as Resource;
}

async function runMultiple(
  job: Job,
  authToken: string | undefined,
  resource: ResourceHandle,
  options: { exports: PreparedExport[]; isWasm: unknown },
): Promise<Resource> {
  let failure: unknown;

  const zip = deps.createZip({
    resource,
    onError: (cause) => {
      failure = cause;
    },
    onProgress: (progress) => {
      void deps.progress(job, progress.done);
    },
  });

  const params = options.exports.map((entry) => renderParams(entry, job, options.isWasm));

  deps.track(String(job.id), resource.path);

  await deps.withScope(params, async (renderOne) => {
    deps.checkCancelled(job);

    await Promise.all(
      params.map((entry) =>
        renderOne(entry, (object) => {
          deps.track(String(job.id), object.path);
          if (object.path !== undefined) {
            deps.addToZip(zip, object.path, String(object.filename ?? "").replace(SANITIZE, "_"));
          }
        }),
      ),
    );
  });

  if (failure !== undefined) throw failure;
  await deps.closeZip(zip);

  const uploaded = await deps.uploadResource(authToken, resource);
  const { path: _path, ...rest } = uploaded;
  return rest as unknown as Resource;
}

function resourceName(params: Dict, fallback: string): string {
  return typeof params.name === "string" ? params.name : fallback;
}

export function prepare(authToken: string | undefined, params: Dict): Prepared {
  const entries = params.exports as Dict[];
  const isWasm = params["is-wasm"];

  const exports = prepareExports(entries, authToken, isWasm);
  const headlessJob = headlessExports(exports, isWasm);
  const single = params["force-multiple"] !== true && exports.length === 1 && exports[0].objects.length === 1;

  if (single) {
    const entry = exports[0];
    const resource = deps.createResource(entry.type, resourceName(params, entry.name));

    return {
      resource,
      total: 1,
      headless: headlessJob,
      run: (job) =>
        runSingle(job, authToken, resource, {
          export: entry,
          isWasm,
          skipChildren: params["skip-children"],
        }),
    };
  }

  const resource = deps.createResource("zip", resourceName(params, exports[0].name));

  return {
    resource,
    total: countObjects(exports),
    headless: headlessJob,
    run: (job) => runMultiple(job, authToken, resource, { exports, isWasm }),
  };
}

export const exportShapes = {
  conform: conformShapesParams,
  prepare,
};
