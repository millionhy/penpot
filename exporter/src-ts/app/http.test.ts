// app.http: the adapter, the middleware chain and the server wiring, exercised
// over a real socket.

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Exchange, type Handler } from "./exchange.js";
import { raise } from "./errors.js";
import { createHandler, createHttpServer } from "./http.js";
import type { JobHandlers } from "./router.js";
import { decode, encode, keywordMap } from "./transit.js";

const legacy: Handler = (exchange: Exchange) => {
  exchange.response.body = {
    params: exchange.request.params as Record<string, unknown>,
    body: exchange.request.body,
    "auth-token": exchange.request.authToken,
  };
  return exchange;
};

const jobs: JobHandlers = {
  create: (exchange) => {
    exchange.response.status = 201;
    exchange.response.body = { job: "created" };
    return exchange;
  },
  fetch: (exchange, id) => {
    exchange.response.body = { id, "auth-token": exchange.request.authToken };
    return exchange;
  },
  cancel: (exchange, id) => {
    exchange.response.status = 202;
    exchange.response.body = { id, cancelled: true };
    return exchange;
  },
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createHttpServer(createHandler(legacy, jobs));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return decode<Record<string, unknown>>(await response.text());
}

// A throwaway server for the cases that need a different handler.
async function withServer<T>(handler: Handler, run: (origin: string) => Promise<T>): Promise<T> {
  const extra = createHttpServer(handler);
  await new Promise<void>((resolve) => extra.listen(0, "127.0.0.1", () => resolve()));
  const origin = `http://127.0.0.1:${(extra.address() as AddressInfo).port}`;

  try {
    return await run(origin);
  } finally {
    await new Promise<void>((resolve) => extra.close(() => resolve()));
  }
}

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/transit+json", ...headers },
    body,
  });
}

describe("the adapter", () => {
  it("decorates /readyz without touching the router", async () => {
    const response = await fetch(`${base}/readyz`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });

  it("answers 204 for an empty 200", async () => {
    const empty: Handler = (exchange) => {
      exchange.response.status = 200;
      return exchange;
    };

    await withServer(createHandler(empty, jobs), async (origin) => {
      const response = await post(`${origin}/api/export`, encode({}));

      expect(response.status).toBe(204);
      expect(response.headers.get("content-length")).toBe("0");
    });
  });

  it("merges the query params", async () => {
    const response = await post(`${base}/api/export?page-id=p&scale=2`, encode({}));

    expect(await readJson(response)).toMatchObject({ params: { "page-id": "p", scale: "2" } });
  });
});

describe("the body reader", () => {
  it("decodes a transit body and merges it over the query", async () => {
    const response = await fetch(`${base}/api/export?cmd=from-query&wait=true`, {
      method: "POST",
      headers: { "content-type": "application/transit+json" },
      body: encode(keywordMap({ cmd: "export-shapes", "profile-id": "p1" })),
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      params: { cmd: "export-shapes", wait: "true", "profile-id": "p1" },
    });
  });

  it("inflates a gzip body", async () => {
    const payload = encode(keywordMap({ cmd: "export-shapes" }));

    const response = await fetch(`${base}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/transit+json", "content-encoding": "gzip" },
      body: gzipSync(Buffer.from(payload, "utf8")),
    });

    expect(await readJson(response)).toMatchObject({ params: { cmd: "export-shapes" } });
  });

  it("keeps a non-transit body as text", async () => {
    const response = await fetch(`${base}/api/export`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });

    expect(await readJson(response)).toMatchObject({ body: "hello", params: {} });
  });
});

describe("the response format", () => {
  it("writes transit and its length", async () => {
    const posted = await fetch(`${base}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/transit+json" },
      body: encode(keywordMap({ cmd: "export-shapes" })),
    });
    const text = await posted.text();

    expect(posted.headers.get("content-type")).toBe("application/transit+json");
    expect(posted.headers.get("content-length")).toBe(String(Buffer.byteLength(text, "utf8")));
  });

  it("keeps a string body alone", async () => {
    const response = await fetch(`${base}/readyz`);

    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe("OK");
  });
});

describe("the cookie reader", () => {
  it("hands the auth token to the handler", async () => {
    const response = await fetch(`${base}/api/export/jobs/abc`, {
      headers: { cookie: "other=1; auth-token=tok%201" },
    });

    expect(await readJson(response)).toEqual({ id: "abc", "auth-token": "tok 1" });
  });
});

describe("the routes", () => {
  it("serves the job endpoints", async () => {
    const created = await fetch(`${base}/api/export/jobs`, {
      method: "POST",
      headers: { "content-type": "application/transit+json" },
      body: encode({}),
    });
    expect(created.status).toBe(201);

    const cancelled = await fetch(`${base}/api/export/jobs/abc`, { method: "DELETE" });
    expect(cancelled.status).toBe(202);
    expect(await readJson(cancelled)).toEqual({ id: "abc", cancelled: true });
  });

  it("answers 404 for an unknown route", async () => {
    const response = await fetch(`${base}/api/export/jobs/abc/def`);

    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({ type: "not-found", code: "object-not-found" });
  });

  it("maps a raised error to its status", async () => {
    const failing: Handler = () =>
      raise({ type: "authentication", code: "authentication-required", hint: "no valid session" });

    await withServer(createHandler(failing, jobs), async (origin) => {
      const response = await post(`${origin}/api/export`, encode({}));

      expect(response.status).toBe(401);
      expect(await readJson(response)).toMatchObject({ type: "authentication" });
    });
  });
});