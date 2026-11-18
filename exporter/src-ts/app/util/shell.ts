// app.util.shell: temp files under the configured tempdir, the one-hour
// deletion timer and the external commands (ImageMagick, potrace, pdfunite).
//
// The timer is deliberately not unref'd, like the CLJS original: the exporter
// keeps running because of its http server, and a rule that a temp file lives
// for an hour should not depend on what else keeps the loop alive.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile as readFileP, rename, rm, stat as statP, writeFile as writeFileP } from "node:fs/promises";
import path from "node:path";
import { get } from "../config.js";
import { raise } from "../errors.js";
import { createLogger, setLevel } from "../logging.js";
import { next as nextUuid } from "../uuid.js";

const log = createLogger("app.util.shell");
setLevel("app.util.shell", "trace");

export const defaultDeletionDelay = 60 * 60;

let configuredTmpdir: string | undefined;

export function getTmpdir(): string {
  if (configuredTmpdir !== undefined) return configuredTmpdir;

  const dir = get("tempdir");
  // The typo is the CLJS log line, kept so existing filters still match.
  log.info({ hint: "tmptdir setup", path: dir });
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  configuredTmpdir = dir;
  return dir;
}

export function scheduleDeletion(filePath: string, delay = defaultDeletionDelay): string {
  const scheduledAt = new Date(Date.now() + delay * 1000);

  log.trace({
    hint: "schedule tempfile deletion",
    path: filePath,
    "scheduled-at": scheduledAt.toISOString(),
  });

  setTimeout(() => {
    try {
      if (existsSync(filePath)) {
        rmSync(filePath, { recursive: true });
        log.trace({ hint: "tempfile permanently deleted", path: filePath });
      }
    } catch (cause) {
      log.error(
        { hint: "error on deleting temporal file", path: filePath, cause },
        cause,
      );
    }
  }, delay * 1000);

  return filePath;
}

export interface TempfileOptions {
  prefix?: string;
  suffix?: string;
}

// tempfile: first free "penpot.<uuid>-<n><suffix>" under the tempdir.
export function tempfile(options: TempfileOptions = {}): string {
  const prefix = options.prefix ?? "penpot.";
  const suffix = options.suffix ?? ".tmp";
  const dir = getTmpdir();

  for (let index = 0; index < 1000; index += 1) {
    const candidate = path.join(dir, `${prefix}${nextUuid()}-${index}${suffix}`);
    if (!existsSync(candidate)) return scheduleDeletion(candidate);
  }

  return raise({
    type: "internal",
    code: "unable-to-locate-temporal-file",
    hint: "unable to find a tempfile candidate",
  });
}

export async function move(originPath: string, destPath: string): Promise<void> {
  await rename(originPath, destPath);
}

export interface FileStat {
  path: string;
  "created-at": number;
  size: number;
}

// stat: nil when the file is gone, like the CLJS tolerance for a missing path.
export async function stat(filePath: string): Promise<FileStat | null> {
  try {
    const data = await statP(filePath);
    return { path: filePath, "created-at": data.ctimeMs, size: data.size };
  } catch {
    return null;
  }
}

export async function rmdir(filePath: string): Promise<void> {
  await rm(filePath, { recursive: true, force: true });
}

export async function writeFile(filePath: string, content: string | Uint8Array): Promise<void> {
  await writeFileP(filePath, content);
}

export async function readFile(filePath: string): Promise<Buffer> {
  return readFileP(filePath);
}

// run-cmd!: stdout as a buffer; a non-zero exit rejects with the exec error.
export function runCmd(cmd: string, args: readonly string[]): Promise<Buffer> {
  log.trace({ fn: "run-cmd", cmd, args: [...args] });

  return new Promise((resolve, reject) => {
    execFile(cmd, [...args], { encoding: "buffer" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}