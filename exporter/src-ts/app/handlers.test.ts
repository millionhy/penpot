// app.handlers/on-error: the status each raised error turns into.

import { describe, expect, it } from "vitest";

process.env.PENPOT_SECRET_KEY = "test-secret";
process.env.PENPOT_INTERNAL_URI = "http://backend:6060";

import { createExchange, type Exchange } from "./exchange.js";
import { raise } from "./errors.js";
import { createLegacyHandler, onError } from "./handlers.js";
import { conformParams, type CreatedExport, type ExportCommand, type ExportService } from "./handlers/export.js";
import { decode, encode, keywordMap } from "./transit.js";
import { next as nextUuid, zero } from "./uuid.js";

function exchange(): Exchange {
  return createExchange({
    method: "post",
    path: "/api/export",
    url: new URL("http://localhost/api/export"),
    headers: {},
    queryParams: {},
    params: {},
    cookies: new Map(),
  });
}

function mapped(cause: unknown) {
  const result = onError(cause, exchange());
  return {
    status: result.response.status,
    headers: result.response.headers,
    body: decode<Record<string, unknown>>(String(result.response.body)),
  };
}

function raised(data: Parameters<typeof raise>[0]): unknown {
  try {
    raise(data);
  } catch (cause) {
    return cause;
  }
  throw new Error("raise did not throw");
}

describe("onError", () => {
  it("answers 429 for a full queue", () => {
    const { status, headers, body } = mapped(raised({ type: "validation", code: "queue-full", hint: "queue is full" }));

    expect(status).toBe(429);
    expect(headers["content-type"]).toBe("application/transit+json");
    expect(body).toEqual({ type: "validation", code: "queue-full", hint: "queue is full" });
  });

  it("answers 401 for a missing session", () => {
    const { status, body } = mapped(
      raised({ type: "authentication", code: "authentication-required", hint: "no valid session" }),
    );

    expect(status).toBe(401);
    expect(body).toEqual({ type: "authentication", code: "authentication-required", hint: "no valid session" });
  });

  it("answers 400 with the explain for a validation error", () => {
    const { status, body } = mapped(
      raised({
        type: "validation",
        code: "spec-validation",
        hint: "invalid params",
        problems: [
          { path: ["exports"], pred: "should be present" },
          { path: ["profile-id"], pred: "should be a string" },
        ],
      }),
    );

    expect(status).toBe(400);
    expect(body.type).toBe("validation");
    expect(body.explain).toBe("exports should be present\nprofile-id should be a string");
    expect(body.problems).toBeUndefined();
  });

  it("turns an assertion into a validation body", () => {
    const { status, body } = mapped(raised({ type: "assertion", code: "assertion", hint: "boom" }));

    expect(status).toBe(400);
    expect(body).toEqual({ type: "validation", code: "assertion", hint: "boom" });
  });

  it("answers 404 with the error data", () => {
    const { status, body } = mapped(raised({ type: "not-found", code: "route-not-found", hint: "no route" }));

    expect(status).toBe(404);
    expect(body).toEqual({ type: "not-found", code: "route-not-found", hint: "no route" });
  });

  it("answers 503 when the browser is not ready", () => {
    const { status, body } = mapped(raised({ type: "internal", code: "browser-not-ready", hint: "booting" }));

    expect(status).toBe(503);
    expect(body).toMatchObject({ type: "server-error", code: "internal", hint: "booting" });
    expect(body.data).toMatchObject({ type: "internal", code: "browser-not-ready" });
  });

  it("answers 500 and keeps the error data", () => {
    const { status, body } = mapped(raised({ type: "internal", code: "boom", hint: "something broke" }));

    expect(status).toBe(500);
    expect(body).toMatchObject({ type: "server-error", code: "boom", hint: "something broke" });
    expect(body.data).toMatchObject({ type: "internal", code: "boom" });
  });

  it("answers 500 without data for a plain exception", () => {
    const { status, body } = mapped(new Error("plain failure"));

    expect(status).toBe(500);
    expect(body).toEqual({ type: "server-error", hint: "plain failure" });
  });
});

const PROFILE = "11111111-1111-1111-1111-111111111111";

function createdExport(): CreatedExport {
  return {
    job: {
      id: "22222222-2222-2222-2222-222222222222",
      "profile-id": PROFILE,
      cmd: "export-shapes",
      backend: "browser",
      state: "queued",
      done: 0,
      total: 1,
      name: "board",
      "resource-id": "33333333-3333-3333-3333-333333333333",
      "created-at": 1_700_000_000_000,
    },
    resource: {
      id: "33333333-3333-3333-3333-333333333333",
      name: "board",
      filename: "board.png",
      mtype: "image/png",
      path: "/tmp/penpot.resource",
    },
    pending: Promise.resolve({
      uri: "http://assets/board.png",
      filename: "board.png",
      mtype: "image/png",
      size: 12,
    }),
  };
}

const COMMANDS: Record<string, ExportCommand> = {
  "export-shapes": {
    conform: (params) => params,
    prepare: () => {
      throw new Error("not used by the legacy handler tests");
    },
  },
};

// The real envelope validation, with a stand-in for the job machinery: these
// tests only care about what the handler passes down and what it answers.
function legacyService(seen: Array<Record<string, unknown>>): ExportService {
  return {
    conformParams: (params) => conformParams(COMMANDS, params),
    createJob: async () => createdExport(),
    exportNow: async (_token, params) => {
      seen.push(params);
      return createdExport();
    },
  };
}

function exportRequest(params: Record<string, unknown>, authToken?: string): Exchange {
  return createExchange({
    method: "post",
    path: "/api/export",
    url: new URL("http://localhost/api/export"),
    headers: {},
    queryParams: {},
    params,
    cookies: new Map(),
    authToken,
  });
}

function sessionAs(profileId: string): void {
  globalThis.fetch = (async () => ({
    status: 200,
    text: async () => encode(keywordMap({ id: profileId })),
  })) as unknown as typeof fetch;
}

describe("the legacy export handler", () => {
  it("answers at once with the resource handle", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const handler = createLegacyHandler(legacyService(seen));

    const result = await handler(exportRequest({ cmd: "export-shapes", "profile-id": PROFILE }));

    expect(result.response.body).toEqual({
      id: "33333333-3333-3333-3333-333333333333",
      name: "board",
      filename: "board.png",
      mtype: "image/png",
    });
  });

  it("waits for the finished resource when asked to", async () => {
    const handler = createLegacyHandler(legacyService([]));

    const result = await handler(
      exportRequest({ cmd: "export-shapes", "profile-id": PROFILE, wait: true }),
    );

    expect(result.response.body).toEqual({
      uri: "http://assets/board.png",
      filename: "board.png",
      mtype: "image/png",
      size: 12,
    });
  });

  it("lets the session own the job when there is one", async () => {
    sessionAs(PROFILE);
    const seen: Array<Record<string, unknown>> = [];
    const handler = createLegacyHandler(legacyService(seen));

    await handler(exportRequest({ cmd: "export-shapes", "profile-id": "body-value" }, nextUuid()));

    expect(seen[0]["profile-id"]).toBe(PROFILE);
  });

  it("keeps the body profile when the session is anonymous", async () => {
    sessionAs(zero);
    const seen: Array<Record<string, unknown>> = [];
    const handler = createLegacyHandler(legacyService(seen));

    await handler(exportRequest({ cmd: "export-shapes", "profile-id": "body-value" }, nextUuid()));

    expect(seen[0]["profile-id"]).toBe("body-value");
  });

  it("applies the same validation as the job endpoint", async () => {
    const handler = createLegacyHandler(legacyService([]));

    await expect(handler(exportRequest({ cmd: "export-shapes" }))).resolves.toBeDefined();
    await expect(
      handler(exportRequest({ cmd: "export-shapes", "profile-id": PROFILE, wait: "yes" })),
    ).rejects.toMatchObject({ data: { type: "validation" } });
  });
});