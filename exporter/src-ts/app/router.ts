// app.router: method + path dispatch.
//
// Requests arrive with whatever prefix the proxy in front uses (/api/export in
// devenv, / when talking to the process directly), so routes are matched on
// the remainder after that prefix.
//
// The CLJS namespace requires app.handlers.jobs directly; the TS handler takes
// the three job handlers as an argument instead, which keeps the dispatch table
// testable without redis behind it.

import { raise } from "./errors.js";
import type { Exchange, Handler } from "./exchange.js";

const mountPoint = "/api/export";

export interface JobHandlers {
  create: Handler;
  fetch: (exchange: Exchange, id: string) => Exchange | Promise<Exchange>;
  cancel: (exchange: Exchange, id: string) => Exchange | Promise<Exchange>;
}

// route-path: drop the mount prefix, the trailing slash and the empty string.
export function routePath(rawPath: string | undefined): string {
  let path = rawPath || "/";

  if (path.startsWith(mountPoint)) path = path.slice(mountPoint.length);

  path = path.replace(/\/+$/, "");

  return path === "" ? "/" : path;
}

// job-id: the remainder of a /jobs/<id> path, unless it is empty or still
// carries a slash (which means a deeper, unknown route).
export function jobId(path: string, prefix: string): string | undefined {
  const id = path.slice(prefix.length);
  if (id === "" || id.includes("/")) return undefined;
  return id;
}

export function createRouter(legacyHandler: Handler, jobs: JobHandlers): Handler {
  return (exchange: Exchange) => {
    const method = exchange.request.method;
    const path = routePath(exchange.request.path);

    if (method === "post" && path === "/") return legacyHandler(exchange);

    if (method === "post" && path === "/jobs") return jobs.create(exchange);

    if (method === "get" && path.startsWith("/jobs/")) {
      const id = jobId(path, "/jobs/");
      if (id !== undefined) return jobs.fetch(exchange, id);
      return raise({ type: "not-found", code: "object-not-found", hint: "unknown route" });
    }

    if (method === "delete" && path.startsWith("/jobs/")) {
      const id = jobId(path, "/jobs/");
      if (id !== undefined) return jobs.cancel(exchange, id);
      return raise({ type: "not-found", code: "object-not-found", hint: "unknown route" });
    }

    return raise({ type: "not-found", code: "route-not-found", hint: `no route for ${method} ${path}` });
  };
}