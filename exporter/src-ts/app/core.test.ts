import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExportService } from "./handlers/export.js";
import type { Handler } from "./exchange.js";
import type { JobHandlers } from "./router.js";
import { start, stop, type CoreDeps } from "./core.js";

interface Harness {
  deps: CoreDeps;
  calls: string[];
  posts: Array<Record<string, unknown>>;
  warns: Array<Record<string, unknown>>;
  captured: { legacy?: Handler; jobs?: JobHandlers };
}

function harness(overrides: Partial<CoreDeps> = {}): Harness {
  const calls: string[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const warns: Array<Record<string, unknown>> = [];
  const captured: Harness["captured"] = {};

  const service = {
    conformParams: (params: Record<string, unknown>) => params,
    createJob: async () => undefined,
    exportNow: async () => undefined,
  } as unknown as ExportService;

  const deps: CoreDeps = {
    isMainThread: true,
    log: {
      trace: () => undefined,
      debug: () => undefined,
      info: (props) => posts.push(props ?? {}),
      warn: (props) => warns.push(props ?? {}),
      error: () => undefined,
      fatal: () => undefined,
    },
    setupLogging: (entries) => calls.push(`setup:${JSON.stringify(entries)}`),
    config: {
      publicUri: "http://public.example",
      internalUri: "http://internal.example",
      version: { full: "1.2.3" },
      wasmDir: "resources/wasm",
      workerPoolMax: 3,
      imageCacheSize: 4096,
    },
    browser: {
      init: async () => {
        calls.push("browser.init");
      },
      stop: async () => {
        calls.push("browser.stop");
      },
    },
    redis: {
      init: () => calls.push("redis.init"),
      stop: async () => {
        calls.push("redis.stop");
      },
    },
    jobs: {
      init: async () => {
        calls.push("jobs.init");
        return 0;
      },
    },
    jobUtils: {
      init: async () => {
        calls.push("jobUtils.init");
        return 0;
      },
    },
    pool: {
      init: () => calls.push("pool.init"),
      stop: async () => {
        calls.push("pool.stop");
      },
    },
    worker: { main: () => calls.push("worker.main") },
    http: {
      init: async (legacy, jobs) => {
        calls.push("http.init");
        captured.legacy = legacy;
        captured.jobs = jobs;
        return undefined;
      },
      stop: async () => {
        calls.push("http.stop");
      },
    },
    createService: () => {
      calls.push("createService");
      return service;
    },
    ...overrides,
  };

  return { deps, calls, posts, warns, captured };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("core/start", () => {
  it("runs only the render worker off the main thread", async () => {
    const state = harness({ isMainThread: false });

    await start(state.deps);

    expect(state.calls).toEqual(["worker.main"]);
  });

  it("boots the server in the CLJS order", async () => {
    const state = harness();

    await start(state.deps);

    expect(state.calls).toEqual([
      "setup:{\"app\":\"info\"}",
      "createService",
      "browser.init",
      "redis.init",
      "jobs.init",
      "jobUtils.init",
      "pool.init",
      "http.init",
    ]);
  });

  it("logs the uris and the wasm pool settings", async () => {
    const state = harness();

    await start(state.deps);

    expect(state.posts[0]).toEqual({
      msg: "initializing",
      "public-uri": "http://public.example",
      "internal-uri": "http://internal.example",
      version: "1.2.3",
    });
    expect(state.posts[1]).toEqual({
      msg: "headless wasm export available",
      "wasm-dir": "resources/wasm",
      workers: 3,
      "image-cache-size": 4096,
    });
  });

  it("leaves the export service with the http handlers", async () => {
    const state = harness();

    await start(state.deps);

    expect(typeof state.captured.legacy).toBe("function");
    expect(typeof state.captured.jobs?.create).toBe("function");
    expect(typeof state.captured.jobs?.fetch).toBe("function");
    expect(typeof state.captured.jobs?.cancel).toBe("function");
  });

  it("does not build the service twice", async () => {
    const state = harness();

    await start(state.deps);

    expect(state.calls.filter((call) => call === "createService")).toHaveLength(1);
  });
});

describe("core/stop", () => {
  it("drains the pools in order and calls done", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const state = harness();
    const done = vi.fn();

    await stop(state.deps, done);

    expect(state.calls).toEqual(["browser.stop", "pool.stop", "redis.stop", "http.stop"]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("calls done at once off the main thread", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const state = harness({ isMainThread: false });
    const done = vi.fn();

    await stop(state.deps, done);

    expect(state.calls).toEqual([]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("logs a failing step and keeps unwinding", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const state = harness({
      browser: {
        init: async () => undefined,
        stop: async () => {
          throw new Error("browser is wedged");
        },
      },
    });

    await stop(state.deps);

    expect(state.warns[0]).toMatchObject({
      hint: "shutdown step did not finish cleanly",
      step: "browser-pool",
    });
    expect(state.calls).toEqual(["pool.stop", "redis.stop", "http.stop"]);
  });

  it("abandons a step that hangs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const state = harness({
      shutdownTimeoutMs: 5,
      browser: {
        init: async () => undefined,
        stop: () => new Promise<void>(() => undefined),
      },
    });

    await stop(state.deps);

    expect(state.warns[0]).toMatchObject({
      hint: "shutdown step did not finish cleanly",
      step: "browser-pool",
    });
    expect(state.calls).toEqual(["pool.stop", "redis.stop", "http.stop"]);
  });
});