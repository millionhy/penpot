// app.jobs: export job model and lifecycle.
//
// The record is persisted in redis (app/jobs/store.ts); the runtime bits that
// cannot be serialized -- cancel callbacks, the cancel signal shared with a
// render worker, the throttling bookkeeping -- stay in this process, keyed by
// job id.
//
// Every state change also publishes the same `:export-update` message the
// exporter has always published, so websocket clients keep working unchanged.

import { errorMessage, raise } from "./errors.js";
import { createLogger, setLevel } from "./logging.js";
import { publish, tenantKey } from "./redis.js";
import { encode, keywordMap } from "./transit.js";
import { next as nextUuid } from "./uuid.js";
import * as store from "./jobs/store.js";

const log = createLogger("app.jobs");
setLevel("app.jobs", "debug");

// A large export reports progress per object; persisting each one would be
// hundreds of writes for information nobody reads at that resolution.
const PROGRESS_THROTTLE_MS = 250;

const TERMINAL_STATES = new Set(["ended", "error", "cancelled"]);

export interface Resource {
  uri: string;
  filename: string;
  mtype: string;
  size?: number;
  path?: string;
  [key: string]: unknown;
}

export interface Job {
  id: string;
  "profile-id": string;
  cmd: string;
  backend: string;
  state: string;
  done: number;
  total: number;
  name: string;
  "resource-id": string;
  "created-at": number;
  "started-at"?: number;
  "ended-at"?: number;
  "resource-uri"?: string;
  filename?: string;
  mtype?: string;
  size?: number;
  error?: string;
  interrupted?: boolean;
  [key: string]: unknown;
}

interface Runtime {
  job: Job;
  run: (job: Job) => Promise<Resource>;
  cancelled: boolean;
  cancelSignal?: Int32Array;
  cancelFns?: Array<() => void>;
  lastProgressMs?: number;
}

export interface CreateJobOptions {
  "profile-id": string;
  cmd: string;
  backend: string;
  total: number;
  name: string;
  "resource-id": string;
}

const registry = new Map<string, Runtime>();

function nowMs(): number {
  return Date.now();
}

function runtime(jobId: string): Runtime | undefined {
  return registry.get(String(jobId));
}

// The live record of a job running in this process, or undefined.
export function lookup(jobId: string): Job | undefined {
  return runtime(jobId)?.job;
}

// The job record from the shared store.
export function fetch(jobId: string): Promise<Job | undefined> {
  return store.fetch(jobId);
}

// Builds a queued job and persists it. `run` performs the export; the caller
// decides when to run it.
export async function create(options: CreateJobOptions, run: (job: Job) => Promise<Resource>): Promise<Job> {
  const job: Job = {
    id: nextUuid(),
    "profile-id": options["profile-id"],
    cmd: options.cmd,
    backend: options.backend,
    state: "queued",
    done: 0,
    total: options.total,
    name: options.name,
    "resource-id": options["resource-id"],
    "created-at": nowMs(),
  };

  registry.set(job.id, { job, run, cancelled: false });
  await store.persist(job);
  return job;
}

export function runFn(jobId: string): ((job: Job) => Promise<Resource>) | undefined {
  return runtime(jobId)?.run;
}

export function cancelled(jobId: string): boolean {
  return runtime(jobId)?.cancelled === true;
}

export function terminal(job: Job): boolean {
  return TERMINAL_STATES.has(job.state);
}

// Raises when the job has been cancelled. Called as each render's turn comes
// up, so a cancellation stops the ones that have not started yet.
export function checkCancelled(job: Job): void {
  if (cancelled(job.id)) {
    raise({ type: "internal", code: "job-cancelled", hint: "export job was cancelled" });
  }
}

// Int32Array over a SharedArrayBuffer, readable from a worker thread: 0 while
// the job is live, 1 once it has been cancelled. Undefined once the job has
// been released -- writing the signal back would leave an entry for a settled
// job in the registry that nothing would ever remove.
export function cancelSignal(jobId: string): Int32Array | undefined {
  const key = String(jobId);
  const rt = registry.get(key);
  if (rt === undefined) return undefined;
  if (rt.cancelSignal !== undefined) return rt.cancelSignal;

  const signal = new Int32Array(new SharedArrayBuffer(4));
  rt.cancelSignal = signal;
  if (rt.cancelled) Atomics.store(signal, 0, 1);
  return signal;
}

// Registers a callback used to abort the job's in-flight work (terminating a
// render worker). A job fans out over several renders, so callbacks accumulate.
// One registered for a job that already settled is dropped: keeping it would
// revive that job's registry entry for good.
export function onCancel(jobId: string, fn: () => void): void {
  const rt = runtime(jobId);
  if (rt === undefined) return;
  rt.cancelFns ??= [];
  rt.cancelFns.push(fn);
}

// Drops the runtime entry once the job settled. The persisted record stays
// until its TTL.
export function release(jobId: string): void {
  registry.delete(String(jobId));
}

// The job as the lifecycle last left it, or undefined once it settled. Callers
// hold the snapshot handed to them when their work started; writing that back
// would resurrect a failed export as running and drop the error with it.
function live(job: Job): Job | undefined {
  const current = runtime(job.id)?.job;
  if (current === undefined || terminal(current)) return undefined;
  return current;
}

function publishUpdate(job: Job): void {
  const payload = keywordMap({
    type: "export-update",
    "job-id": job.id,
    "resource-id": job["resource-id"],
    status: job.state,
    done: job.done,
    total: job.total,
    name: job.name,
    filename: job.filename,
    mtype: job.mtype,
    "resource-uri": job["resource-uri"],
    cause: job.error,
  });

  publish(tenantKey(job["profile-id"]), encode(payload));
}

function storeJob(job: Job): Job {
  const rt = runtime(job.id);
  if (rt !== undefined) rt.job = job;
  return job;
}

async function persistAndPublish(job: Job): Promise<Job> {
  storeJob(job);
  publishUpdate(job);
  return store.persist(job);
}

// Moves the job on. The first terminal state wins: anything arriving after it
// is dropped, so a late failure cannot overwrite a cancellation, nor a
// straggler overwrite either.
export async function transition(job: Job, data: Partial<Job>): Promise<Job | undefined> {
  const current = live(job);
  if (current === undefined) return undefined;
  return persistAndPublish({ ...current, ...data });
}

export async function start(job: Job): Promise<Job | undefined> {
  return transition(job, { state: "running", "started-at": nowMs() });
}

// Reports `done` objects completed. Writes are throttled, so the caller need
// not care how often it calls this.
export async function progress(job: Job, done: number): Promise<Job | undefined> {
  const current = live(job);
  if (current === undefined) return undefined;

  const rt = runtime(job.id);
  const now = nowMs();
  const next: Job = { ...current, done };
  const write = now - (rt?.lastProgressMs ?? 0) >= PROGRESS_THROTTLE_MS;

  storeJob(next);
  if (!write) return next;

  if (rt !== undefined) rt.lastProgressMs = now;
  return persistAndPublish(next);
}

export async function complete(job: Job, resource: Resource): Promise<Job | undefined> {
  return transition(job, {
    state: "ended",
    "ended-at": nowMs(),
    done: job.total,
    "resource-uri": resource.uri,
    filename: resource.filename,
    mtype: resource.mtype,
    size: resource.size,
  });
}

export async function fail(job: Job, cause: unknown): Promise<Job | undefined> {
  log.error({ hint: "export job failed", "job-id": String(job.id), cause });
  return transition(job, {
    state: "error",
    "ended-at": nowMs(),
    error: errorMessage(cause),
  });
}

async function cancelLocal(jobId: string): Promise<Job | undefined> {
  const key = String(jobId);
  const rt = registry.get(key);
  const job = rt?.job;

  if (rt === undefined || job === undefined || terminal(job)) return job;

  rt.cancelled = true;
  if (rt.cancelSignal !== undefined) Atomics.store(rt.cancelSignal, 0, 1);

  // Recorded before the callbacks run, not after: one of them
  // (scheduler.dropQueued) releases the job, and transition on a released job
  // is a no-op, so a queued job would keep claiming to be queued in the store
  // and never publish its cancelled update.
  const result = transition(job, { state: "cancelled", "ended-at": nowMs() });

  for (const fn of rt.cancelFns ?? []) {
    try {
      fn();
    } catch (cause) {
      log.warn({ hint: "error on job cancel callback", "job-id": key, cause });
    }
  }

  return result;
}

// Cancels a job. One this process does not own is broadcast over the cancel
// topic, so whoever runs it acts on it. Idempotent.
export async function cancel(jobId: string): Promise<Job | undefined> {
  if (runtime(jobId) !== undefined) return cancelLocal(jobId);

  const job = await fetch(jobId);
  if (job === undefined || terminal(job)) return job;

  store.requestCancel(job.id);
  return job;
}

// Marks every job left mid-flight by a previous process as cancelled.
//
// A queue and its running jobs live in the memory of the process that owns
// them, so nothing in flight when it died can be resumed; without this the
// record would keep claiming to be running until its TTL expires.
//
// NOTE: the store cannot tell whose jobs are whose, so with more than one
// exporter behind a load balancer this would also cancel a sibling's running
// jobs. Single-instance deployments only.
export async function cleanAbandoned(): Promise<number> {
  try {
    const jobs = await store.fetchAll();
    const abandoned = jobs.filter((job) => !terminal(job));
    if (abandoned.length === 0) return 0;

    log.warn({ hint: "cancelling jobs abandoned by a previous process", count: abandoned.length });
    await Promise.all(
      abandoned.map((job) =>
        store.persist({ ...job, state: "cancelled", interrupted: true, "ended-at": nowMs() }),
      ),
    );
    return abandoned.length;
  } catch (cause) {
    log.warn({ hint: "unable to clean abandoned jobs", cause });
    return 0;
  }
}

export function init(): Promise<number> {
  store.onCancelRequest((jobId) => {
    if (runtime(jobId) !== undefined) {
      log.info({ hint: "remote cancel request", "job-id": jobId });
      void cancelLocal(jobId);
    }
  });

  return cleanAbandoned();
}