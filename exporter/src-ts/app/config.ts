// app.config, Node side.
//
// The CLJS namespace reads PENPOT_* environment variables, applies the
// defaults, decodes the numeric knobs from their strings and validates the
// result before anything else boots. This port keeps that contract but loads
// lazily (`getConfig`), so a unit test can import a module that reads config
// without the process exiting on a missing key.

import { hkdfSync } from "node:crypto";
import { obfuscateString } from "./data.js";
import { parseFlags, type FlagSet } from "./flags.js";
import { createLogger, setLevel } from "./logging.js";
import { version } from "./version.js";

const log = createLogger("app.config");
setLevel("app.config", "info");

export interface Config {
  "secret-key": string;
  "public-uri": string;
  "internal-uri": string | undefined;
  "exporter-shared-key": string | undefined;
  host: string;
  tenant: string;
  flags: FlagSet;
  "redis-uri": string;
  tempdir: string;
  "http-server-port": number;
  "http-server-host": string;
  "browser-pool-max": number;
  "browser-pool-min": number;
  "exporter-max-concurrent-jobs": number;
  "exporter-max-jobs-per-profile": number;
  "exporter-queue-max": number;
  "exporter-job-ttl": number;
  "wasm-worker-pool-max": number;
  "wasm-worker-pool-min": number;
  "wasm-worker-idle-timeout": number;
  "wasm-worker-image-cache-size": number;
}

const DEFAULTS = {
  "public-uri": "http://localhost:3449",
  // internal-uri cannot be nil; it falls back to public-uri.
  tenant: "default",
  host: "localhost",
  "http-server-port": 6061,
  "http-server-host": "0.0.0.0",
  tempdir: "/tmp/penpot",
  "redis-uri": "redis://redis/0",
  "exporter-max-concurrent-jobs": 4,
  "exporter-max-jobs-per-profile": 2,
  "exporter-queue-max": 64,
  "exporter-job-ttl": 3600,
  "wasm-worker-pool-max": 2,
  "wasm-worker-pool-min": 1,
  "wasm-worker-idle-timeout": 300,
  "wasm-worker-image-cache-size": 128 * 1024 * 1024,
} as const;

const INT_KEYS = new Set([
  "http-server-port",
  "browser-pool-max",
  "browser-pool-min",
  "exporter-max-concurrent-jobs",
  "exporter-max-jobs-per-profile",
  "exporter-queue-max",
  "exporter-job-ttl",
  "wasm-worker-pool-max",
  "wasm-worker-pool-min",
  "wasm-worker-idle-timeout",
  "wasm-worker-image-cache-size",
]);

const STRING_KEYS = new Set([
  "secret-key",
  "public-uri",
  "internal-uri",
  "exporter-shared-key",
  "host",
  "tenant",
  "redis-uri",
  "tempdir",
  "http-server-host",
]);

export class ConfigError extends Error {
  readonly explain: string[];

  constructor(explain: string[]) {
    super(explain.join("\n"));
    this.name = "ConfigError";
    this.explain = explain;
  }
}

type Env = Record<string, string | undefined>;

// read-env: PENPOT_FOO_BAR -> "foo-bar".
export function readEnv(env: Env, prefix = "penpot"): Record<string, string> {
  const marker = `${prefix.toLowerCase()}_`;
  const out: Record<string, string> = {};

  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (!lower.startsWith(marker)) continue;
    const value = env[key];
    if (value === undefined) continue;
    out[lower.slice(marker.length).replace(/_/g, "-")] = value;
  }

  return out;
}

// The string transformer of the CLJS schema turns a numeric string into an
// int and rejects anything else; `parseInt` alone would accept "12abc".
function decodeInteger(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) return undefined;
  return Number.parseInt(text, 10);
}

// prepare-config: defaults + env, decoded and validated.
export function loadConfig(env: Env = process.env): Config {
  const raw: Record<string, unknown> = { ...DEFAULTS, ...readEnv(env) };
  const explain: string[] = [];

  const config: Record<string, unknown> = {};

  for (const key of STRING_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    config[key] = String(value);
  }

  for (const key of INT_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    const parsed = decodeInteger(value);
    if (parsed === undefined || parsed < 0) {
      explain.push(`${key}: should be a non-negative integer, got ${JSON.stringify(value)}`);
      continue;
    }
    config[key] = parsed;
  }

  if (!config["secret-key"]) explain.push("secret-key: should be a non-empty string");

  for (const key of ["public-uri", "internal-uri"] as const) {
    const value = config[key];
    if (value === undefined) continue;
    try {
      new URL(String(value));
    } catch {
      explain.push(`${key}: should be a valid uri, got ${JSON.stringify(value)}`);
    }
  }

  config.flags = parseFlags(raw.flags as string | undefined);

  if (explain.length > 0) throw new ConfigError(explain);

  return config as unknown as Config;
}

let current: Config | undefined;

export function getConfig(): Config {
  if (current !== undefined) return current;

  try {
    current = loadConfig(process.env);
  } catch (cause) {
    if (cause instanceof ConfigError) {
      console.error(cause.explain.join("\n"));
      process.exit(-1);
    }
    throw cause;
  }

  return current;
}

export function get<K extends keyof Config>(key: K): Config[K];
export function get<K extends keyof Config>(key: K, fallback: NonNullable<Config[K]>): NonNullable<Config[K]>;
export function get(key: keyof Config, fallback?: unknown): unknown {
  const value = getConfig()[key];
  return value === undefined ? fallback : value;
}

// Internal uri falls back to public-uri (get-internal-uri).
export function getInternalUri(): string {
  return getConfig()["internal-uri"] ?? getConfig()["public-uri"];
}

let cachedManagementKey: string | undefined;

// management-key: the explicit exporter-shared-key, or a HKDF derivation of
// the secret key (blake2b512, salt "exporter", 32 bytes, base64url).
export function managementKey(): string {
  if (cachedManagementKey !== undefined) return cachedManagementKey;

  const config = getConfig();
  const explicit = config["exporter-shared-key"];
  const key =
    explicit ??
    Buffer.from(
      new Uint8Array(hkdfSync("blake2b512", config["secret-key"], "exporter", "", 32)),
    ).toString("base64url");

  log.info({ hint: "exporter key initialized", key: obfuscateString(key) });
  cachedManagementKey = key;
  return key;
}

export { version };