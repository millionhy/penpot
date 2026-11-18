// app.router: the dispatch table and its prefix handling.

import { describe, expect, it } from "vitest";
import type { Exchange, Handler } from "./exchange.js";
import { createExchange } from "./exchange.js";
import { errorData, type ErrorData } from "./errors.js";
import { createRouter, jobId, routePath, type JobHandlers } from "./router.js";

function exchange(method: string, path: string): Exchange {
  return createExchange({
    method,
    path,
    url: new URL(`http://localhost${path}`),
    headers: {},
    queryParams: {},
    params: {},
    cookies: new Map(),
  });
}

// The router may answer directly or hand back the promise of an async
// handler, which is the reason every call goes through await.
async function call(handler: Handler, ex: Exchange): Promise<Exchange> {
  return await handler(ex);
}

async function failure(handler: Handler, ex: Exchange): Promise<ErrorData> {
  try {
    await handler(ex);
  } catch (cause) {
    return errorData(cause);
  }
  throw new Error("expected the handler to raise");
}

function legacy(ex: Exchange): Exchange {
  ex.response.status = 200;
  ex.response.body = "legacy";
  return ex;
}

function jobs(): JobHandlers & { calls: string[] } {
  const calls: string[] = [];
  const record = (id?: string) => {
    calls.push(id === undefined ? "job" : `job:${id}`);
  };

  return {
    calls,
    create: (ex) => {
      record();
      return ex;
    },
    fetch: (ex, id) => {
      record(id);
      return ex;
    },
    cancel: (ex, id) => {
      record(id);
      return ex;
    },
  };
}

describe("routePath", () => {
  it("strips the mount point and the trailing slashes", () => {
    expect(routePath("/api/export")).toBe("/");
    expect(routePath("/api/export/")).toBe("/");
    expect(routePath("/api/export/jobs/")).toBe("/jobs");
    expect(routePath("/jobs")).toBe("/jobs");
    expect(routePath("")).toBe("/");
    expect(routePath(undefined)).toBe("/");
  });

  it("keeps an inner slash", () => {
    expect(routePath("/api/export/jobs/one/two")).toBe("/jobs/one/two");
  });
});

describe("jobId", () => {
  it("accepts one path segment only", () => {
    expect(jobId("/jobs/abc", "/jobs/")).toBe("abc");
    expect(jobId("/jobs/", "/jobs/")).toBeUndefined();
    expect(jobId("/jobs/a/b", "/jobs/")).toBeUndefined();
  });
});

describe("createRouter", () => {
  it("sends post / to the legacy handler", async () => {
    const handler = createRouter(legacy, jobs());
    expect((await call(handler, exchange("post", "/api/export"))).response.body).toBe("legacy");
    expect((await call(handler, exchange("post", "/"))).response.body).toBe("legacy");
  });

  it("routes the job endpoints", async () => {
    const table = jobs();
    const handler = createRouter(legacy, table);

    await call(handler, exchange("post", "/api/export/jobs"));
    await call(handler, exchange("get", "/api/export/jobs/abc"));
    await call(handler, exchange("delete", "/api/export/jobs/abc/"));

    expect(table.calls).toEqual(["job", "job:abc", "job:abc"]);
  });

  it("reports an unknown route", async () => {
    const handler = createRouter(legacy, jobs());
    const data = await failure(handler, exchange("put", "/api/export"));

    expect(data).toMatchObject({ type: "not-found", code: "route-not-found" });
    expect(data.hint).toBe("no route for put /");
  });

  it("reports a deeper job path as a missing object", async () => {
    const handler = createRouter(legacy, jobs());
    const data = await failure(handler, exchange("get", "/api/export/jobs/a/b"));

    expect(data).toMatchObject({ type: "not-found", code: "object-not-found" });
  });

  it("does not answer a bare /jobs with a fetch", async () => {
    const handler = createRouter(legacy, jobs());
    const data = await failure(handler, exchange("get", "/api/export/jobs"));

    expect(data.code).toBe("route-not-found");
  });
});