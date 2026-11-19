// app.handlers.export-frames: the `export-frames` command.
//
// Every frame exports as one PDF page; the pages are joined with `pdfunite`
// after all renders finish and the result is uploaded as one resource.
//
// Mirrors `exporter/src/app/handlers/export_frames.cljs`. Renderer, resource,
// shell and job helpers are injectable for the same reason as export-shapes.

import { raise } from "../errors.js";
import * as jobs from "../jobs.js";
import type { Job, Resource } from "../jobs.js";
import * as jobUtils from "../jobs/utils.js";
import { render, withScope } from "../renderer.js";
import type { OnObject, RenderParams, RenderType } from "../renderer.js";
import { move, runCmd, stat as statPath, tempfile, type FileStat } from "../util/shell.js";
import type { Prepared, ResourceHandle } from "./export.js";
import * as shapes from "./export-shapes.js";
import * as resources from "./resources.js";

type Dict = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- injectable collaborators

export interface ExportFramesDeps {
  createResource: typeof resources.create;
  uploadResource: typeof resources.uploadResource;
  render: typeof render;
  withScope: typeof withScope;
  track: typeof jobUtils.track;
  move: typeof move;
  runCmd: typeof runCmd;
  tempfile: typeof tempfile;
  stat: typeof statPath;
  progress: typeof jobs.progress;
  checkCancelled: typeof jobs.checkCancelled;
}

const defaultDeps: ExportFramesDeps = {
  createResource: resources.create,
  uploadResource: resources.uploadResource,
  render,
  withScope,
  track: jobUtils.track,
  move,
  runCmd,
  tempfile,
  stat: statPath,
  progress: jobs.progress,
  checkCancelled: jobs.checkCancelled,
};

let deps: ExportFramesDeps = defaultDeps;

export function setDeps(next?: Partial<ExportFramesDeps>): void {
  deps = { ...defaultDeps, ...next };
}

export function resetDeps(): void {
  deps = defaultDeps;
}

// --- params validation

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

function checkExportsEntry(entry: unknown, index: number, problems: Problem[]): void {
  if (!isRecord(entry)) {
    problems.push(problem(["exports", index], "should be a map"));
    return;
  }

  for (const key of ["file-id", "page-id", "object-id"]) {
    if (!isUuid(entry[key])) problems.push(problem(["exports", index, key], "should be a uuid"));
  }

  if (typeof entry.name !== "string") {
    problems.push(problem(["exports", index, "name"], "should be a string"));
  }
}

export function conformFramesParams(params: Dict): Dict {
  const problems: Problem[] = [];

  const exports = params.exports;
  if (!Array.isArray(exports) || exports.length === 0) {
    problems.push(problem(["exports"], "should be a non-empty vector"));
  } else {
    exports.forEach((entry, index) => checkExportsEntry(entry, index, problems));
  }

  if (params.name !== undefined && typeof params.name !== "string") {
    problems.push(problem(["name"], "should be a string"));
  }

  if (params["is-wasm"] !== undefined && typeof params["is-wasm"] !== "boolean") {
    problems.push(problem(["is-wasm"], "should be a boolean"));
  }

  if (problems.length > 0) {
    return raise({ type: "validation", code: "spec-validation", hint: "invalid params", problems });
  }

  return params;
}

// --- run

async function joinPdf(job: Job, fileId: string, paths: readonly string[]): Promise<string> {
  const prefix = `penpot.pdfunite.${fileId}.`;
  const output = deps.track(String(job.id), deps.tempfile({ prefix, suffix: ".pdf" }));
  if (output === undefined) {
    return raise({
      type: "internal",
      code: "unable-to-locate-temporal-file",
      hint: "unable to find a tempfile candidate",
    });
  }

  await deps.runCmd("pdfunite", [...paths, output]);
  return output;
}

async function runExport(
  job: Job,
  authToken: string | undefined,
  resource: ResourceHandle,
  options: { exports: shapes.PreparedExport[]; isWasm: unknown; fileId: string },
): Promise<Resource> {
  const rendered: string[] = [];

  const onObject: OnObject = (object) => {
    deps.track(String(job.id), object.path);
    if (object.path !== undefined) rendered.push(object.path);
    void deps.progress(job, rendered.length);
  };

  const params = options.exports.map(
    (entry): RenderParams => ({
      ...entry,
      type: entry.type as RenderType,
      "is-wasm": options.isWasm === true,
      "job-id": String(job.id),
    }),
  );

  deps.track(String(job.id), resource.path);

  await deps.withScope(params, async (renderOne) => {
    deps.checkCancelled(job);
    await Promise.all(params.map((entry) => renderOne(entry, onObject)));
  });

  const joined = await joinPdf(job, options.fileId, rendered);
  await deps.move(joined, resource.path);

  const uploaded = await deps.uploadResource(authToken, resource);
  const info: FileStat | null = await deps.stat(resource.path);
  const merged = info === null ? uploaded : { ...uploaded, ...info };
  const { path: _path, ...rest } = merged;
  return rest as unknown as Resource;
}

function resourceName(params: Dict, fallback: string): string {
  return typeof params.name === "string" ? params.name : fallback;
}

export function prepare(authToken: string | undefined, params: Dict): Prepared {
  const entries = (params.exports as Dict[]).map((entry) => ({
    ...entry,
    type: "pdf",
    scale: 1,
    suffix: "",
  }));

  const isWasm = params["is-wasm"];
  const exports = shapes.prepareExports(entries, authToken, isWasm);
  const resource = deps.createResource("pdf", resourceName(params, exports[0].name));

  return {
    resource,
    total: shapes.countObjects(exports),
    headless: shapes.headlessExports(exports, isWasm),
    run: (job) =>
      runExport(job, authToken, resource, {
        exports,
        isWasm,
        fileId: exports[0]["file-id"],
      }),
  };
}

export const exportFrames = {
  conform: conformFramesParams,
  prepare,
};
