// app.jobs.scheduler: admission control for export jobs.
//
// Limits concurrent jobs and rejects work rather than allowing an unbounded
// backlog. Queue order is FIFO, except jobs whose profile is already at its cap
// are skipped, as are headless jobs once every render worker is busy.

import { get } from "../config.js";
import { raise } from "../errors.js";
import { createLogger, setLevel } from "../logging.js";
import * as jobs from "../jobs.js";
import type { Job, Resource } from "../jobs.js";
import * as jobUtils from "./utils.js";

const log = createLogger("app.jobs.scheduler");
setLevel("app.jobs.scheduler", "debug");

interface RunningInfo {
  "profile-id": string;
  headless: boolean;
}

interface QueueEntry {
  job: Job;
  resolve: (value: Settled) => void;
  reject: (cause: unknown) => void;
}

export type Settled = Resource | Job | undefined;

interface State {
  running: Map<string, RunningInfo>;
  queue: QueueEntry[];
}

export interface SchedulerOptions {
  // The wasm pool owns the capacity; it is read on every decision because the
  // pool can still be starting up when the first jobs arrive.
  capacity: () => number;
}

export interface Scheduler {
  submit(job: Job): Promise<Settled>;
  dropQueued(jobId: string): void;
  state(): State;
}

function maxConcurrent(): number {
  return get("exporter-max-concurrent-jobs", 4);
}

function maxPerProfile(): number {
  return get("exporter-max-jobs-per-profile", 2);
}

function maxQueued(): number {
  return get("exporter-queue-max", 64);
}

function headless(job: Job): boolean {
  return job.backend === "wasm";
}

function runningFor(state: State, profileId: string): number {
  return Array.from(state.running.values()).filter((info) => info["profile-id"] === profileId).length;
}

function runningHeadless(state: State): number {
  return Array.from(state.running.values()).filter((info) => info.headless).length;
}

function eligible(state: State, job: Job, capacity: number): boolean {
  return (
    state.running.size < maxConcurrent() &&
    runningFor(state, job["profile-id"]) < maxPerProfile() &&
    // A headless job holds one render worker for its whole run, so admitting
    // more of them than there are workers would only move the wait inside the
    // pool, with the job already reporting itself as running.
    (!headless(job) || runningHeadless(state) < capacity)
  );
}

function takeEligible(state: State, capacity: number): { state: State; entry: QueueEntry } | undefined {
  const index = state.queue.findIndex((entry) => eligible(state, entry.job, capacity));
  if (index < 0) return undefined;

  return {
    state: { ...state, queue: [...state.queue.slice(0, index), ...state.queue.slice(index + 1)] },
    entry: state.queue[index],
  };
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const state: State = { running: new Map(), queue: [] };

  function finish(jobId: string): void {
    state.running.delete(String(jobId));
    jobs.release(jobId);
    void jobUtils.release(jobId);
    pump();
  }

  async function execute(job: Job): Promise<Settled> {
    state.running.set(String(job.id), {
      "profile-id": job["profile-id"],
      headless: headless(job),
    });

    if (jobs.cancelled(job.id)) {
      finish(job.id);
      return job;
    }

    const run = jobs.runFn(job.id);
    if (run === undefined) {
      finish(job.id);
      return job;
    }

    try {
      const current = await jobs.start(job);
      return await run(current ?? job);
    } finally {
      finish(job.id);
    }
  }

  // Removes a queued job and settles its promise, freeing its queue slot on
  // cancellation.
  function dropQueued(jobId: string): void {
    const index = state.queue.findIndex((entry) => String(entry.job.id) === String(jobId));
    if (index < 0) return;

    const [entry] = state.queue.splice(index, 1);
    jobs.release(jobId);
    void jobUtils.release(jobId);
    entry.resolve(undefined);
  }

  function pump(): void {
    for (;;) {
      const taken = takeEligible(state, options.capacity());
      if (taken === undefined) return;

      state.queue = taken.state.queue;
      const { job, resolve, reject } = taken.entry;
      execute(job).then(resolve, reject);
    }
  }

  // Registers `job` for execution. Returns a promise of the job's result, which
  // resolves when the export actually finishes; callers that only need the
  // handle can ignore it. Raises when the exporter is saturated.
  function submit(job: Job): Promise<Settled> {
    if (eligible(state, job, options.capacity())) return execute(job);

    if (state.queue.length >= maxQueued()) {
      return raise({ type: "validation", code: "queue-full", hint: "too many queued export jobs" });
    }

    return new Promise<Settled>((resolve, reject) => {
      state.queue.push({ job, resolve, reject });
      jobs.onCancel(job.id, () => dropQueued(job.id));
      log.debug({ hint: "export job queued", "job-id": String(job.id) });
    });
  }

  return {
    submit,
    dropQueued,
    state: () => state,
  };
}