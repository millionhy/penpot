// app.jobs.scheduler: the admission rules -- concurrency, per-profile caps,
// the headless worker cap, the bounded queue and the cancel of a queued job.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.PENPOT_SECRET_KEY = "test-secret";
process.env.PENPOT_EXPORTER_MAX_CONCURRENT_JOBS = "2";
process.env.PENPOT_EXPORTER_MAX_JOBS_PER_PROFILE = "2";
process.env.PENPOT_EXPORTER_QUEUE_MAX = "1";

import type { Job, Resource } from "../jobs.js";
import * as jobs from "../jobs.js";
import * as pool from "../wasm/pool.js";
import { createScheduler, type Scheduler } from "./scheduler.js";

vi.mock("../wasm/pool.js", () => ({ capacity: vi.fn(() => 0) }));

const PROFILE = "11111111-1111-1111-1111-111111111111";

function deferred(): { promise: Promise<Resource>; resolve: (value: Resource) => void } {
  let resolve!: (value: Resource) => void;
  const promise = new Promise<Resource>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function resource(name: string): Resource {
  return { uri: `http://assets/${name}.png`, filename: `${name}.png`, mtype: "image/png" };
}

interface PendingJob {
  job: Job;
  finish: () => void;
}

async function create(name: string, backend = "browser"): Promise<PendingJob> {
  const gate = deferred();
  const job = await jobs.create(
    {
      "profile-id": PROFILE,
      cmd: "export-shapes",
      backend,
      total: 1,
      name,
      "resource-id": `resource-${name}`,
    },
    () => gate.promise,
  );

  return {
    job,
    finish: () => gate.resolve(resource(name)),
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let scheduler: Scheduler;
let capacity: number;

beforeAll(() => {
  // Persisting without a redis connection is the intended fallback, but the
  // warnings would drown the test output.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);

  capacity = 1;
  scheduler = createScheduler({ capacity: () => capacity });
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("default capacity", () => {
  it("reads the wasm worker pool cap", async () => {
    vi.mocked(pool.capacity).mockReturnValue(0);

    const standalone = createScheduler();
    const blocked = await create("pool-blocked", "wasm");
    const pending = standalone.submit(blocked.job);

    expect(pool.capacity).toHaveBeenCalled();
    expect(standalone.state().running.size).toBe(0);
    expect(standalone.state().queue).toHaveLength(1);

    standalone.dropQueued(blocked.job.id);
    expect(await pending).toBeUndefined();
  });
});

describe("submit", () => {
  it("runs what fits and queues the rest", async () => {
    const first = await create("first");
    const second = await create("second");
    const third = await create("third");

    const pendingFirst = scheduler.submit(first.job);
    const pendingSecond = scheduler.submit(second.job);
    const pendingThird = scheduler.submit(third.job);

    expect(scheduler.state().running.size).toBe(2);
    expect(scheduler.state().queue).toHaveLength(1);
    expect(jobs.lookup(third.job.id)?.state).toBe("queued");

    first.finish();
    await pendingFirst;
    await wait(10);

    // The slot the first job freed goes to the queued one.
    expect(scheduler.state().running.size).toBe(2);
    expect(scheduler.state().queue).toHaveLength(0);
    expect(jobs.lookup(third.job.id)?.state).toBe("running");

    second.finish();
    third.finish();
    await Promise.all([pendingSecond, pendingThird]);

    expect(scheduler.state().running.size).toBe(0);
  });

  it("rejects when the queue is full", async () => {
    const first = await create("a");
    const second = await create("b");
    const queued = await create("c");
    const rejected = await create("d");

    const pendingFirst = scheduler.submit(first.job);
    const pendingSecond = scheduler.submit(second.job);
    const pendingQueued = scheduler.submit(queued.job);

    expect(() => scheduler.submit(rejected.job)).toThrow(/too many queued/);

    first.finish();
    second.finish();
    queued.finish();
    await Promise.all([pendingFirst, pendingSecond, pendingQueued]);
  });

  it("keeps headless jobs out while every worker is busy", async () => {
    capacity = 0;
    const blocked = await create("blocked", "wasm");
    const pendingBlocked = scheduler.submit(blocked.job);

    expect(scheduler.state().queue).toHaveLength(1);
    expect(scheduler.state().running.size).toBe(0);

    scheduler.dropQueued(blocked.job.id);
    expect(await pendingBlocked).toBeUndefined();
    expect(scheduler.state().queue).toHaveLength(0);

    // With a worker back, the same job is admitted.
    capacity = 1;
    const allowed = await create("allowed", "wasm");
    const pendingAllowed = scheduler.submit(allowed.job);

    allowed.finish();
    expect(await pendingAllowed).toMatchObject({ filename: "allowed.png" });
  });

  it("drops a queued job when it is cancelled", async () => {
    capacity = 1;
    const first = await create("e");
    const second = await create("f");
    const queued = await create("g");

    const pendingFirst = scheduler.submit(first.job);
    const pendingSecond = scheduler.submit(second.job);
    const pendingQueued = scheduler.submit(queued.job);

    expect(scheduler.state().queue).toHaveLength(1);

    await jobs.cancel(queued.job.id);
    await pendingQueued;

    expect(scheduler.state().queue).toHaveLength(0);
    expect(jobs.lookup(queued.job.id)).toBeUndefined();

    first.finish();
    second.finish();
    await Promise.all([pendingFirst, pendingSecond]);
  });
});