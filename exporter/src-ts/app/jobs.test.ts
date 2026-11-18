// app.jobs: the lifecycle rules -- the first terminal state wins, progress is
// throttled, a cancel reaches the callbacks and the workers.

import { describe, expect, it } from "vitest";

process.env.PENPOT_SECRET_KEY = "test-secret";

import * as jobs from "./jobs.js";
import type { Job, Resource } from "./jobs.js";

function options(overrides: Partial<jobs.CreateJobOptions> = {}): jobs.CreateJobOptions {
  return {
    "profile-id": "11111111-1111-1111-1111-111111111111",
    cmd: "export-shapes",
    backend: "browser",
    total: 2,
    name: "board",
    "resource-id": "22222222-2222-2222-2222-222222222222",
    ...overrides,
  };
}

function resource(): Resource {
  return { uri: "http://assets/board.png", filename: "board.png", mtype: "image/png", size: 10 };
}

async function create(overrides: Partial<jobs.CreateJobOptions> = {}): Promise<Job> {
  return jobs.create(options(overrides), async () => resource());
}

describe("create", () => {
  it("persists a queued job with its runtime entry", async () => {
    const job = await create();

    expect(job).toMatchObject({ state: "queued", done: 0, total: 2, name: "board" });
    expect(jobs.lookup(job.id)).toEqual(job);
    expect(jobs.runFn(job.id)).toBeTypeOf("function");
    expect(jobs.cancelled(job.id)).toBe(false);
    expect(jobs.terminal(job)).toBe(false);
  });
});

describe("the transitions", () => {
  it("moves through running to ended", async () => {
    const job = await create();

    await jobs.start(job);
    expect(jobs.lookup(job.id)?.state).toBe("running");
    expect(jobs.lookup(job.id)?.["started-at"]).toBeTypeOf("number");

    const ended = await jobs.complete(job, resource());
    expect(ended).toMatchObject({
      state: "ended",
      done: 2,
      filename: "board.png",
      mtype: "image/png",
      "resource-uri": "http://assets/board.png",
    });
    expect(jobs.lookup(job.id)?.state).toBe("ended");
  });

  it("keeps the first terminal state", async () => {
    const job = await create();
    await jobs.start(job);
    await jobs.complete(job, resource());

    expect(await jobs.fail(job, new Error("too late"))).toBeUndefined();
    expect(await jobs.start(job)).toBeUndefined();
    expect(jobs.lookup(job.id)?.state).toBe("ended");
  });

  it("records the failure message", async () => {
    const job = await create();
    await jobs.start(job);

    const failed = await jobs.fail(job, new Error("renderer crashed"));
    expect(failed).toMatchObject({ state: "error", error: "renderer crashed" });
  });

  it("ignores a transition for a released job", async () => {
    const job = await create();
    jobs.release(job.id);

    expect(await jobs.start(job)).toBeUndefined();
    expect(jobs.lookup(job.id)).toBeUndefined();
  });
});

describe("progress", () => {
  it("updates the live record and returns it", async () => {
    const job = await create();
    await jobs.start(job);

    expect(await jobs.progress(job, 1)).toMatchObject({ state: "running", done: 1 });
    expect(await jobs.progress(job, 2)).toMatchObject({ state: "running", done: 2 });
    expect(jobs.lookup(job.id)?.done).toBe(2);
  });

  it("ignores a settled job", async () => {
    const job = await create();
    await jobs.start(job);
    await jobs.complete(job, resource());

    expect(await jobs.progress(job, 99)).toBeUndefined();
  });
});

describe("cancel", () => {
  it("marks the job and fires the registered callbacks", async () => {
    const job = await create();
    await jobs.start(job);

    let fired = 0;
    jobs.onCancel(job.id, () => {
      fired += 1;
    });
    jobs.onCancel(job.id, () => {
      fired += 1;
    });

    const cancelled = await jobs.cancel(job.id);
    expect(cancelled).toMatchObject({ state: "cancelled" });
    expect(fired).toBe(2);
    expect(jobs.cancelled(job.id)).toBe(true);
  });

  it("wakes a worker through the shared signal", async () => {
    const job = await create();
    const signal = jobs.cancelSignal(job.id);

    expect(signal).toBeInstanceOf(Int32Array);
    expect(Atomics.load(signal as Int32Array, 0)).toBe(0);

    await jobs.cancel(job.id);
    expect(Atomics.load(signal as Int32Array, 0)).toBe(1);
  });

  it("is a no-op for a settled job", async () => {
    const job = await create();
    await jobs.start(job);
    await jobs.complete(job, resource());

    let fired = 0;
    jobs.onCancel(job.id, () => {
      fired += 1;
    });

    expect(await jobs.cancel(job.id)).toMatchObject({ state: "ended" });
    expect(fired).toBe(0);
  });

  it("answers undefined for an unknown job", async () => {
    expect(await jobs.cancel("33333333-3333-3333-3333-333333333333")).toBeUndefined();
  });
});

describe("release", () => {
  it("drops the runtime entry and keeps no signal", async () => {
    const job = await create();

    jobs.release(job.id);
    expect(jobs.lookup(job.id)).toBeUndefined();
    expect(jobs.cancelSignal(job.id)).toBeUndefined();
  });
});

describe("checkCancelled", () => {
  it("raises for a cancelled job", async () => {
    const job = await create();
    await jobs.cancel(job.id);

    expect(() => jobs.checkCancelled(job)).toThrow(/cancelled/);
  });

  it("passes for a live job", async () => {
    const job = await create();

    expect(() => jobs.checkCancelled(job)).not.toThrow();
  });
});

describe("init", () => {
  it("cleans abandoned jobs, which is nothing without a store", async () => {
    expect(await jobs.init()).toBe(0);
  });
});