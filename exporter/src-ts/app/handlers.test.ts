// app.handlers/on-error: the status each raised error turns into.

import { describe, expect, it } from "vitest";
import { createExchange, type Exchange } from "./exchange.js";
import { raise } from "./errors.js";
import { onError } from "./handlers.js";
import { decode } from "./transit.js";

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