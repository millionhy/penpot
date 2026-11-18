// app.jobs.store: the record round trip through redis, its TTL, the scan and
// the cancel topic.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.PENPOT_SECRET_KEY = "test-secret";

import type { Job } from "../jobs.js";
import { startRedis, type MockRedis } from "../../test/redis-server.js";
import type * as RedisModule from "../redis.js";
import type * as StoreModule from "./store.js";

const PROFILE = "11111111-1111-1111-1111-111111111111";
const JOB_ID = "22222222-2222-2222-2222-222222222222";

let server: MockRedis;
let redis: typeof RedisModule;
let store: typeof StoreModule;

beforeAll(async () => {
  server = await startRedis();
  process.env.PENPOT_REDIS_URI = `redis://127.0.0.1:${server.port}/0`;
  process.env.PENPOT_TENANT = "acme";
  redis = await import("../redis.js");
  store = await import("./store.js");
  redis.init();
});

afterAll(async () => {
  await redis.stop();
  await server.close();
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    "profile-id": PROFILE,
    cmd: "export-shapes",
    backend: "browser",
    state: "queued",
    done: 0,
    total: 2,
    name: "board",
    "resource-id": "33333333-3333-3333-3333-333333333333",
    "created-at": 1_700_000_000_000,
    ...overrides,
  };
}

describe("persist", () => {
  it("writes one blob under the job key", async () => {
    await store.persist(job({ state: "running", "started-at": 1_700_000_001_000 }));

    const hash = server.hashes.get(store.jobKey(JOB_ID));
    expect(hash?.size).toBe(1);
    expect(hash?.get("data")).toContain("export-shapes");
  });

  it("drops nil fields from the record", async () => {
    await store.persist(job({ filename: undefined }));

    const blob = server.hashes.get(store.jobKey(JOB_ID))?.get("data") ?? "";
    expect(blob).not.toContain("filename");
  });
});

describe("fetch", () => {
  it("reads the record back", async () => {
    await store.persist(job({ state: "ended", done: 2, filename: "board.png" }));

    expect(await store.fetch(JOB_ID)).toMatchObject({
      id: JOB_ID,
      "profile-id": PROFILE,
      state: "ended",
      done: 2,
      filename: "board.png",
    });
  });

  it("answers undefined for an unknown job", async () => {
    expect(await store.fetch("44444444-4444-4444-4444-444444444444")).toBeUndefined();
  });

  it("answers undefined when the blob does not decode", async () => {
    await redis.hset(store.jobKey("55555555-5555-5555-5555-555555555555"), { data: "not transit" });

    expect(await store.fetch("55555555-5555-5555-5555-555555555555")).toBeUndefined();
  });
});

describe("fetchAll", () => {
  it("returns every readable record and skips the broken one", async () => {
    await store.persist(job({ id: "66666666-6666-6666-6666-666666666666" }));

    const jobs = await store.fetchAll();
    const ids = jobs.map((item) => item.id);

    expect(ids).toContain(JOB_ID);
    expect(ids).toContain("66666666-6666-6666-6666-666666666666");
    expect(ids).not.toContain("55555555-5555-5555-5555-555555555555");
  });
});

describe("the cancel topic", () => {
  it("reaches the registered handler", async () => {
    const received: string[] = [];
    const unsubscribe = store.onCancelRequest((jobId) => received.push(jobId));

    // The subscriber connection opens asynchronously; give SUBSCRIBE time to
    // reach the server before publishing.
    await wait(50);
    store.requestCancel(JOB_ID);

    const deadline = Date.now() + 1000;
    while (received.length === 0 && Date.now() < deadline) await wait(10);

    expect(received).toEqual([JOB_ID]);
    unsubscribe();
  });
});