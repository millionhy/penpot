// app.jobs.utils: temp file ownership for export jobs.
//
// Temp files used to be cleaned only by the per-file timer in app.util.shell,
// an hour after creation and lost entirely on restart. Here each job owns the
// paths it creates, so they are dropped as soon as it settles and whatever a
// crash left behind is cleaned at boot.

import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { get } from "../config.js";
import { createLogger, setLevel } from "../logging.js";
import { getTmpdir } from "../util/shell.js";

const log = createLogger("app.jobs.utils");
setLevel("app.jobs.utils", "debug");

const MANAGED_PREFIX = "penpot.";

const tracked = new Map<string, Set<string>>();

// Registers `filePath` as owned by `jobId`, so it is removed when the job
// settles.
export function track(jobId: string | undefined, filePath: string | undefined): string | undefined {
  if (jobId === undefined || filePath === undefined) return filePath;

  const key = String(jobId);
  let paths = tracked.get(key);
  if (paths === undefined) {
    paths = new Set();
    tracked.set(key, paths);
  }
  paths.add(filePath);
  return filePath;
}

async function removePath(filePath: string): Promise<void> {
  try {
    await rm(filePath, { recursive: true, force: true });
  } catch (cause) {
    log.warn({ hint: "unable to remove job temp file", path: filePath, cause });
  }
}

// Removes every file the job owns. Called once the job reached a terminal
// state and its result has already been uploaded, so nothing else reads them.
export async function release(jobId: string): Promise<void> {
  const key = String(jobId);
  const paths = tracked.get(key);
  tracked.delete(key);
  if (paths === undefined || paths.size === 0) return;

  await Promise.all(Array.from(paths, (filePath) => removePath(filePath)));
  log.debug({ hint: "released job temp files", "job-id": key, count: paths.size });
}

// Removes managed temp files older than the job TTL. They can only be
// leftovers of a previous process: every live one belongs to a job of this one.
export async function clean(): Promise<number> {
  const maxAge = 1000 * get("exporter-job-ttl", 3600);
  const now = Date.now();

  try {
    const entries = await readdir(getTmpdir());
    const results = await Promise.all(
      entries
        .filter((entry) => entry.startsWith(MANAGED_PREFIX))
        .map(async (entry) => {
          const filePath = path.join(getTmpdir(), entry);
          try {
            const info = await stat(filePath);
            if (now - info.mtimeMs <= maxAge) return 0;
            await removePath(filePath);
            return 1;
          } catch {
            return 0;
          }
        }),
    );

    const removed = results.reduce<number>((total, value) => total + value, 0);
    if (removed > 0) log.info({ hint: "removed orphaned export temp files", count: removed });
    return removed;
  } catch (cause) {
    log.warn({ hint: "temp file cleanup failed", cause });
    return 0;
  }
}

export function init(): Promise<number> {
  return clean();
}