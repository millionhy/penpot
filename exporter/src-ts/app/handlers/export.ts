// app.handlers.export: job creation for both entry points.
//
// `createJob` hands the work to the scheduler and returns at once; `exportNow`
// starts it immediately, which is what keeps browser exports behaving exactly
// as they did before there were jobs. Both share the same record, progress and
// failure handling.
//
// The command table is injected: each command owns its own params validation
// and its own `prepare`, so this module stays free of renderer knowledge.

import { raise } from "../errors.js";
import * as jobs from "../jobs.js";
import type { Job, Resource } from "../jobs.js";
import * as jobUtils from "../jobs/utils.js";

// The handle a command builds before the render starts: name, filename and
// mtype are known, the file is not.
export interface ResourceHandle {
  id: string;
  name: string;
  filename: string;
  mtype: string;
  path: string;
  [key: string]: unknown;
}

export interface Prepared {
  resource: ResourceHandle;
  total: number;
  headless: boolean;
  run: (job: Job) => Promise<Resource>;
}

export interface ExportCommand {
  // Throws a validation error carrying `problems` when the params do not fit.
  conform(params: Record<string, unknown>): Record<string, unknown>;
  prepare(authToken: string | undefined, params: Record<string, unknown>): Prepared;
}

export type Settled = Resource | Job | undefined;

export interface CreatedExport {
  job: Job;
  resource: ResourceHandle;
  pending: Promise<Settled>;
}

export interface ExportService {
  conformParams(params: Record<string, unknown>): Record<string, unknown>;
  createJob(authToken: string | undefined, params: Record<string, unknown>): Promise<CreatedExport>;
  exportNow(authToken: string | undefined, params: Record<string, unknown>): Promise<CreatedExport>;
}

export interface ExportServiceOptions {
  commands: Record<string, ExportCommand>;
  // scheduler.submit: resolves when the export actually finishes.
  submit: (job: Job) => Promise<Settled>;
}

function problem(path: string, pred: string): { path: string[]; pred: string } {
  return { path: [path], pred };
}

// conform-params: the shared envelope, then the command's own spec.
export function conformParams(
  commands: Record<string, ExportCommand>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const problems: Array<{ path: string[]; pred: string }> = [];

  if (typeof params.cmd !== "string" || params.cmd === "") {
    problems.push(problem("cmd", "should be a keyword"));
  }

  const wait = params.wait;
  if (wait !== undefined && typeof wait !== "boolean") {
    problems.push(problem("wait", "should be a boolean"));
  }

  if (problems.length > 0) {
    raise({ type: "validation", code: "spec-validation", hint: "invalid params", problems });
  }

  const command = commands[params.cmd as string];
  if (command === undefined) {
    raise({
      type: "validation",
      code: "spec-validation",
      hint: "invalid params",
      problems: [problem("cmd", `unknown export command: ${String(params.cmd)}`)],
    });
  }

  return command.conform(params);
}

// The record as the lifecycle last left it, or the snapshot when the job has
// already settled and its runtime entry is gone.
function current(job: Job): Job {
  return jobs.lookup(String(job.id)) ?? job;
}

async function runAndTrack(job: Job, run: (job: Job) => Promise<Resource>): Promise<Resource> {
  try {
    const resource = await run(job);
    await jobs.complete(current(job), resource);
    return resource;
  } catch (cause) {
    if (jobs.cancelled(String(job.id))) throw cause;
    await jobs.fail(current(job), cause);
    throw cause;
  }
}

// Runs the job as soon as it is created, outside the scheduler.
async function runNow(job: Job): Promise<Settled> {
  try {
    const started = await jobs.start(job);
    const run = jobs.runFn(String(job.id));
    if (run === undefined) return job;
    return await run(started ?? job);
  } finally {
    jobs.release(String(job.id));
    await jobUtils.release(String(job.id));
  }
}

export function createExportService(options: ExportServiceOptions): ExportService {
  async function create(
    authToken: string | undefined,
    params: Record<string, unknown>,
    start: (job: Job) => Promise<Settled>,
  ): Promise<CreatedExport> {
    const command = options.commands[params.cmd as string];
    if (command === undefined) {
      return raise({
        type: "validation",
        code: "spec-validation",
        hint: "invalid params",
        problems: [problem("cmd", `unknown export command: ${String(params.cmd)}`)],
      });
    }

    const { resource, total, headless, run } = command.prepare(authToken, params);

    const job = await jobs.create(
      {
        "profile-id": String(params["profile-id"]),
        cmd: String(params.cmd),
        // Backend used for admission and cancel UI: headless WASM when
        // `is-wasm` is set, otherwise browser.
        backend: headless ? "wasm" : "browser",
        total,
        name: resource.name,
        "resource-id": resource.id,
      },
      (job) => runAndTrack(job, run),
    );

    try {
      return { job, resource, pending: start(job) };
    } catch (cause) {
      await jobs.fail(job, cause);
      jobs.release(String(job.id));
      throw cause;
    }
  }

  return {
    conformParams: (params) => conformParams(options.commands, params),
    createJob: (authToken, params) => create(authToken, params, options.submit),
    exportNow: (authToken, params) => create(authToken, params, runNow),
  };
}