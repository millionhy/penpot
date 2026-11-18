// app.handlers.jobs: the REST surface -- session ownership, the create answer
// and the cancel round trip.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.PENPOT_SECRET_KEY = "test-secret";
process.env.PENPOT_INTERNAL_URI = "http://backend:6060";

import { encode, keywordMap } from "../transit.js";
import { errorData } from "../errors.js";
import { createExchange, type Exchange } from "../exchange.js";
import type { Job } from "../jobs.js";
import { next as nextUuid, zero } from "../uuid.js";

vi.mock("../jobs.js", () => ({
  lookup: vi.fn(() => undefined),
  fetch: vi.fn(),
  cancel: vi.fn(async () => undefined),
}));

import * as jobs from "../jobs.js";
import { createJobHandlers } from "./jobs.js";
import type { CreatedExport, ExportService } from "./export.js";

const PROFILE = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    "profile-id": PROFILE,
    cmd: "export-shapes",
    backend: "browser",
    state: "queued",
    done: 0,
    total: 2,
    name: "board",
    "resource-id": "44444444-4444-4444-4444-444444444444",
    "created-at": 1_700_000_000_000,
    ...overrides,
  };
}

function exchange(overrides: Partial<Exchange["request"]> = {}): Exchange {
  return createExchange({
    method: "post",
    path: "/api/export/jobs",
    url: new URL("http://localhost/api/export/jobs"),
    headers: {},
    queryParams: {},
    params: { cmd: "export-shapes" },
    cookies: new Map(),
    ...overrides,
  });
}

function created(jobRecord = job()): CreatedExport {
  return {
    job: jobRecord,
    resource: {
      id: "44444444-4444-4444-4444-444444444444",
      name: "board",
      filename: "board.png",
      mtype: "image/png",
      path: "/tmp/penpot.resource",
    },
    pending: Promise.resolve(undefined),
  };
}

function service(createdExport: CreatedExport): ExportService {
  return {
    conformParams: (params) => params,
    createJob: async () => createdExport,
    exportNow: async () => createdExport,
  };
}

function sessionAs(profileId: string): void {
  vi.stubGlobal("fetch", async () => ({
    status: 200,
    text: async () => encode(keywordMap({ id: profileId })),
  }));
}

beforeEach(() => {
  vi.mocked(jobs.fetch).mockReset();
  vi.mocked(jobs.cancel).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("create", () => {
  it("answers with the record and the resource names", async () => {
    sessionAs(PROFILE);
    const token = nextUuid();
    const record = job();
    const handlers = createJobHandlers({ service: service(created(record)) });

    const result = await handlers.create(exchange({ authToken: token }));

    expect(result.response.body).toMatchObject({
      id: record.id,
      state: "queued",
      filename: "board.png",
      mtype: "image/png",
    });
  });

  it("rejects an anonymous caller", async () => {
    sessionAs(zero);
    const handlers = createJobHandlers({ service: service(created()) });

    await expect(handlers.create(exchange({ authToken: nextUuid() }))).rejects.toMatchObject({
      data: { type: "authentication", code: "authentication-required" },
    });
  });

  it("takes the owner from the session, not from the params", async () => {
    sessionAs(PROFILE);
    const record = job();
    const seen: Array<Record<string, unknown>> = [];
    const withSpy: ExportService = {
      conformParams: (params) => {
        seen.push(params);
        return params;
      },
      createJob: async () => created(record),
      exportNow: async () => created(record),
    };

    await createJobHandlers({ service: withSpy }).create(exchange({ authToken: nextUuid() }));

    expect(seen[0]["profile-id"]).toBe(PROFILE);
  });
});

describe("fetch", () => {
  it("answers with the owned record", async () => {
    sessionAs(PROFILE);
    const record = job({ state: "running" });
    vi.mocked(jobs.fetch).mockResolvedValue(record);
    const handlers = createJobHandlers({ service: service(created()) });

    const result = await handlers.fetch(exchange({ authToken: nextUuid() }), record.id);

    expect(result.response.body).toMatchObject({ id: record.id, state: "running" });
  });

  it("hides a record owned by someone else", async () => {
    sessionAs(OTHER);
    vi.mocked(jobs.fetch).mockResolvedValue(job());
    const handlers = createJobHandlers({ service: service(created()) });

    await expect(handlers.fetch(exchange({ authToken: nextUuid() }), "whatever")).rejects.toMatchObject({
      data: { type: "not-found", code: "object-not-found" },
    });
  });

  it("hides a missing record", async () => {
    sessionAs(PROFILE);
    vi.mocked(jobs.fetch).mockResolvedValue(undefined);
    const handlers = createJobHandlers({ service: service(created()) });

    await expect(handlers.fetch(exchange({ authToken: nextUuid() }), "whatever")).rejects.toMatchObject({
      data: { code: "object-not-found" },
    });
  });
});

describe("cancel", () => {
  it("cancels and answers with the settled record", async () => {
    sessionAs(PROFILE);
    const before = job({ state: "running" });
    const after = job({ state: "cancelled" });
    vi.mocked(jobs.fetch).mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const handlers = createJobHandlers({ service: service(created()) });

    const result = await handlers.cancel(exchange({ authToken: nextUuid() }), before.id);

    expect(jobs.cancel).toHaveBeenCalledWith(before.id);
    expect(result.response.body).toMatchObject({ state: "cancelled" });
  });

  it("answers 404 when the record disappears during the cancel", async () => {
    sessionAs(PROFILE);
    vi.mocked(jobs.fetch).mockResolvedValueOnce(job({ state: "running" })).mockResolvedValueOnce(undefined);
    const handlers = createJobHandlers({ service: service(created()) });

    try {
      await handlers.cancel(exchange({ authToken: nextUuid() }), "whatever");
      throw new Error("expected a rejection");
    } catch (cause) {
      expect(errorData(cause)).toMatchObject({ type: "not-found", code: "object-not-found" });
    }
  });
});