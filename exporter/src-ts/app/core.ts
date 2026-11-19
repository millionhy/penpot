// app.core: process entry point.
//
// Render workers run this same bundle, so the thread decides what gets booted:
// the http server and its pools, or one render worker.

import { isMainThread } from "node:worker_threads";

import * as browser from "./browser.js";
import { get, getInternalUri } from "./config.js";
import { createLegacyHandler } from "./handlers.js";
import { createExportCommands } from "./handlers/commands.js";
import { createExportService, type ExportService } from "./handlers/export.js";
import { createJobHandlers } from "./handlers/jobs.js";
import * as http from "./http.js";
import * as jobs from "./jobs.js";
import { createScheduler } from "./jobs/scheduler.js";
import * as jobUtils from "./jobs/utils.js";
import * as logging from "./logging.js";
import * as redis from "./redis.js";
import type { Handler } from "./exchange.js";
import type { JobHandlers } from "./router.js";
import { version } from "./version.js";
import { artifactDir } from "./wasm.js";
import * as pool from "./wasm/pool.js";
import { main as workerMain } from "./wasm/worker.js";
// Side effect: installs the wasm-backed renderer that headless exports call,
// the way `app.renderer` requires `app.renderer.wasm` in the CLJS tree.
import "./renderer/wasm.js";

// Draining a pool waits for every checked-out resource to come back, which an
// export in flight can hold for as long as its own timeout. On a hot reload
// that would block `start` from ever running again, leaving a drained pool that
// fails every later job.
const SHUTDOWN_STEP_TIMEOUT = 3000;

export interface CoreDeps {
  isMainThread: boolean;
  log: logging.Logger;
  setupLogging(entries: Record<string, logging.LogLevel>): void;
  config: {
    publicUri: string;
    internalUri: string;
    version: { full: string };
    wasmDir: string;
    workerPoolMax: number;
    imageCacheSize: number;
  };
  browser: { init(): Promise<void>; stop(): Promise<void> };
  redis: { init(): void; stop(): Promise<void> };
  jobs: { init(): Promise<number> };
  jobUtils: { init(): Promise<number> };
  pool: { init(): void; stop(): Promise<void> };
  worker: { main(): void };
  http: {
    init(legacy: Handler, handlers: JobHandlers): Promise<unknown>;
    stop(): Promise<void>;
  };
  // Built once per process: the scheduler owns the job queue, so a second one
  // would admit the same jobs twice.
  createService(): ExportService;
  shutdownTimeoutMs?: number;
}

function defaultDeps(): CoreDeps {
  return {
    isMainThread,
    log: logging.createLogger("app.core"),
    setupLogging: logging.setup,
    config: {
      publicUri: get("public-uri", "http://localhost:3449"),
      internalUri: getInternalUri(),
      version,
      wasmDir: artifactDir,
      workerPoolMax: get("wasm-worker-pool-max", 2),
      imageCacheSize: get("wasm-worker-image-cache-size", 128 * 1024 * 1024),
    },
    browser: { init: browser.init, stop: browser.stop },
    redis: { init: redis.init, stop: redis.stop },
    jobs: { init: jobs.init },
    jobUtils: { init: jobUtils.init },
    pool: { init: pool.init, stop: pool.stop },
    worker: { main: workerMain },
    http: { init: http.init, stop: http.stop },
    createService: () =>
      createExportService({
        commands: createExportCommands(),
        submit: createScheduler().submit,
      }),
  };
}

export async function start(deps: CoreDeps = defaultDeps()): Promise<void> {
  if (!deps.isMainThread) {
    deps.worker.main();
    return;
  }

  deps.setupLogging({ app: "info" });

  const service = deps.createService();

  deps.log.info({
    msg: "initializing",
    "public-uri": deps.config.publicUri,
    "internal-uri": deps.config.internalUri,
    version: deps.config.version.full,
  });
  deps.log.info({
    msg: "headless wasm export available",
    "wasm-dir": deps.config.wasmDir,
    workers: deps.config.workerPoolMax,
    "image-cache-size": deps.config.imageCacheSize,
  });

  await deps.browser.init();
  deps.redis.init();
  await deps.jobs.init();
  await deps.jobUtils.init();
  deps.pool.init();
  await deps.http.init(createLegacyHandler(service), createJobHandlers({ service }));
}

async function shutdownStep(
  label: string,
  step: () => Promise<void>,
  timeoutMs: number,
  log: logging.Logger,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    const result = await Promise.race([step().then(() => "done" as const), timeout]);
    if (result === "timeout") {
      log.warn({ hint: "shutdown step did not finish cleanly", step: label });
    }
  } catch (cause) {
    log.warn({ hint: "shutdown step did not finish cleanly", step: label, cause });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function stop(deps: CoreDeps = defaultDeps(), done?: () => void): Promise<void> {
  // An empty line for visual feedback of restart.
  console.log("");

  if (!deps.isMainThread) {
    // A render worker owns no server, pools or connections; nothing to unwind.
    done?.();
    return;
  }

  deps.log.info({ msg: "stopping" });

  const timeoutMs = deps.shutdownTimeoutMs ?? SHUTDOWN_STEP_TIMEOUT;
  await shutdownStep("browser-pool", () => deps.browser.stop(), timeoutMs, deps.log);
  await shutdownStep("wasm-worker-pool", () => deps.pool.stop(), timeoutMs, deps.log);
  await shutdownStep("redis", () => deps.redis.stop(), timeoutMs, deps.log);
  await shutdownStep("http", () => deps.http.stop(), timeoutMs, deps.log);
  done?.();
}

export const main = start;

// Signals are only delivered to the main thread, and `exit` in a worker would
// take down that worker rather than the process.
export function installProcessHandlers(deps: CoreDeps = defaultDeps()): void {
  process.on("uncaughtException", (cause) => {
    console.error(cause);
  });

  if (!deps.isMainThread) return;

  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}