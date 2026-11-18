// app.common.logging, Node side: the same key/value records the CLJS exporter
// writes (hint="welcome to penpot", module="exporter"...) so operators keep
// grepping the same strings.
//
// Records are formatted lazily by level; the CLJS build keeps a per-namespace
// threshold map with a parent fallback, which is what `setLevel` fills. The
// default threshold (100) matches the CLJS root logger: nothing logs until a
// module raises it, exactly like `(l/set-level! :info)` in the originals.

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogProps = Record<string, unknown>;

export interface Logger {
  trace(props?: LogProps, cause?: unknown): void;
  debug(props?: LogProps, cause?: unknown): void;
  info(props?: LogProps, cause?: unknown): void;
  warn(props?: LogProps, cause?: unknown): void;
  error(props?: LogProps, cause?: unknown): void;
  fatal(props?: LogProps, cause?: unknown): void;
}

const LEVEL_INT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 50,
};

const LEVEL_NAME: Record<LogLevel, string> = {
  trace: "TRC",
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
  fatal: "ERR",
};

// Mirrors the CLJS logger map (loggers), cached the same way.
const thresholds = new Map<string, number>();

export function setLevel(logger: string, level: LogLevel): void {
  thresholds.set(logger, LEVEL_INT[level]);
}

export function setup(entries: Record<string, LogLevel>): void {
  for (const [logger, level] of Object.entries(entries)) setLevel(logger, level);
}

function thresholdFor(logger: string): number {
  const known = thresholds.get(logger);
  if (known !== undefined) return known;

  let current = logger;
  for (;;) {
    const dot = current.lastIndexOf(".");
    const parent = dot > 0 ? current.slice(0, dot) : "";
    const value = thresholds.get(parent);
    if (value !== undefined) {
      thresholds.set(logger, value);
      return value;
    }
    if (parent === "") {
      thresholds.set(logger, 100);
      return 100;
    }
    current = parent;
  }
}

export function enabled(logger: string, level: LogLevel): boolean {
  return LEVEL_INT[level] >= thresholdFor(logger);
}

function pad(value: number, size: number): string {
  return String(value).padStart(size, "0");
}

function prStr(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "nil";
  if (value === undefined) return "nil";
  if (value instanceof Date) return `#inst "${value.toISOString()}"`;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(prStr).join(" ")}]`;
  if (value instanceof Error) return value.message;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// build-message: ordered key=value pairs joined with ", ".
export function formatProps(props: LogProps): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    parts.push(`${key}=${prStr(value)}`);
  }
  return parts.join(", ");
}

function timestamp(now: Date): string {
  return `${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}:${pad(now.getSeconds(), 2)}.${pad(
    now.getMilliseconds(),
    3,
  )}`;
}

function emit(logger: string, level: LogLevel, props: LogProps, cause: unknown): void {
  if (!enabled(logger, level)) return;

  const header = `${LEVEL_NAME[level]} ${timestamp(new Date())} [${logger}]`;
  const message = formatProps(props);
  const text = message.length > 0 ? `${header} ${message}` : header;

  const sink = level === "warn" ? console.warn : level === "info" || level === "debug" || level === "trace" ? console.log : console.error;
  sink(text);
  if (cause !== undefined && cause !== null) {
    if (cause instanceof Error) sink(cause.stack ?? cause.message);
    else sink(prStr(cause));
  }
}

export function createLogger(logger: string): Logger {
  const log = (level: LogLevel) => (props: LogProps = {}, cause?: unknown) =>
    emit(logger, level, props, cause);

  return {
    trace: log("trace"),
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    fatal: log("fatal"),
  };
}

// Every ported namespace keeps the CLJS logger name so the existing log
// filters and dashboards keep working.
export const log = createLogger("app");