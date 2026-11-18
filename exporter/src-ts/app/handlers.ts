// app.handlers: the error mapper and the legacy export entry point.
//
// Every handler in the exporter raises `AppError`s carrying type/code/hint and
// the router sits behind this mapper, so a failure keeps the status the old
// CLJS service answered with.

import { resolveProfileId } from "./auth.js";
import { withoutNils } from "./data.js";
import { errorMessage, isAppError, type ErrorData } from "./errors.js";
import type { Exchange, Handler } from "./exchange.js";
import type { ExportService } from "./handlers/export.js";
import { createLogger, setLevel } from "./logging.js";
import { encodeVerbose, keywordMap } from "./transit.js";

const log = createLogger("app.handlers");
setLevel("app.handlers", "debug");

// The only validation code that means "too much work right now".
const QUEUE_FULL_CODES = new Set(["queue-full"]);

// pretty-explain: clojure.spec renders an expound report; the port renders the
// collected problems, one per line, which is what the hint alone does not say.
// The exact text is not reproduced because nothing parses it.
export function prettyExplain(data: ErrorData): string | undefined {
  const problems = data.problems;
  if (!Array.isArray(problems) || problems.length === 0) return undefined;

  return problems
    .slice(0, 10)
    .map((problem: { path?: Array<string | number>; pred?: string }) => {
      const path = Array.isArray(problem.path) && problem.path.length > 0 ? problem.path.join("/") : "<value>";
      return `${path} ${problem.pred ?? "failed"}`;
    })
    .join("\n");
}

function reply(exchange: Exchange, status: number, data: Record<string, unknown>): Exchange {
  return {
    ...exchange,
    response: {
      status,
      headers: { "content-type": "application/transit+json" },
      body: encodeVerbose(keywordMap(data)),
    },
  };
}

export function onError(cause: unknown, exchange: Exchange): Exchange {
  const data = isAppError(cause) ? cause.data : {};
  const type = data.type;
  const code = data.code;
  const hint = errorMessage(cause) ?? "";

  if (type === "validation" && code !== undefined && QUEUE_FULL_CODES.has(code)) {
    log.warn({ hint: "rejecting export request", code });
    return reply(exchange, 429, { type: "validation", code, hint });
  }

  if (type === "authentication") {
    return reply(exchange, 401, { type: "authentication", code, hint });
  }

  if (type === "validation" || type === "assertion") {
    const explain = prettyExplain(data);
    const { problems: _problems, ...rest } = data;
    return reply(exchange, 400, { ...rest, explain, type: "validation" });
  }

  if (type === "not-found") {
    return reply(exchange, 404, data);
  }

  if (type === "internal" && code === "browser-not-ready") {
    return reply(exchange, 503, { type: "server-error", code: "internal", hint, data });
  }

  log.error({ hint: "unexpected internal error", cause });
  return reply(
    exchange,
    500,
    withoutNils({ type: "server-error", code, hint, data: isAppError(cause) ? data : undefined }),
  );
}

// The original `POST /api/export` entry point, and the one the browser backend
// still goes through. The export runs as soon as it is asked for, and the
// contract is unchanged: `:wait` answers with the finished resource, otherwise
// with the resource handle while the work runs.
export function createLegacyHandler(service: ExportService): Handler {
  return async (exchange) => {
    const params = service.conformParams(exchange.request.params);
    log.debug({ hint: "process-request", cmd: params.cmd });

    // The session wins when there is one; the body value stays the fallback so
    // nothing that used to work stops working.
    const profileId = await resolveProfileId(exchange.request.authToken);
    const effective = profileId === undefined ? params : { ...params, "profile-id": profileId };

    const created = await service.exportNow(exchange.request.authToken, effective);

    if (params.wait === true) {
      const resource = await created.pending;
      return { ...exchange, response: { ...exchange.response, body: resource } };
    }

    void created.pending.catch(() => undefined);
    const { path: _path, ...handle } = created.resource;
    return { ...exchange, response: { ...exchange.response, body: handle } };
  };
}