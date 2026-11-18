// app.handlers.export: params validation, job creation and the two ways to
// start the work.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.PENPOT_SECRET_KEY = "test-secret";

import { errorData } from "../errors.js";
import type { Job, Resource } from "../jobs.js";
import * as jobs from "../jobs.js";
import type { ExportCommand, ExportService, Settled } from "./export.js";
import { conformParams, createExportService } from "./export.js";

const PROFILE = "11111111-1111-1111-1111-111111111111";
const RESOURCE: Resource = {
  uri: "http://assets/board.png",
  filename: "board.png",
  mtype: "image/png",
  size: 12,
};

function command(overrides: Partial<ExportCommand> = {}): ExportCommand {
  return {
    conform: (params) => params,
    prepare: (_authToken, params) => ({
      resource: {
        id: "resource-1",
        name: String(params.name ?? "board"),
        filename: "board.png",
        mtype: "image/png",
        path: "/tmp/penpot.resource",
      },
      total: 2,
      headless: params["is-wasm"] === true,
      run: async () => RESOURCE,
    }),
    ...overrides,
  };
}

function service(submit: (job: Job) => Promise<Settled>): ExportService {
  return createExportService({ commands: { "export-shapes": command() }, submit });
}

function params(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cmd: "export-shapes",
    "profile-id": PROFILE,
    exports: [],
    ...extra,
  };
}

beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("conformParams", () => {
  it("accepts the envelope and hands it to the command", () => {
    const commands = { "export-shapes": command() };

    expect(conformParams(commands, params({ wait: true }))).toMatchObject({
      cmd: "export-shapes",
      wait: true,
    });
  });

  it("rejects a missing command", () => {
    try {
      conformParams({}, { "profile-id": PROFILE });
      throw new Error("expected a rejection");
    } catch (cause) {
      expect(errorData(cause)).toMatchObject({ type: "validation", code: "spec-validation" });
      expect(errorData(cause).problems).toContainEqual({ path: ["cmd"], pred: "should be a keyword" });
    }
  });

  it("rejects a non-boolean wait", () => {
    try {
      conformParams({ "export-shapes": command() }, params({ wait: "true" }));
      throw new Error("expected a rejection");
    } catch (cause) {
      expect(errorData(cause).problems).toContainEqual({ path: ["wait"], pred: "should be a boolean" });
    }
  });

  it("rejects an unknown command", () => {
    try {
      conformParams({}, params({ cmd: "export-nothing" }));
      throw new Error("expected a rejection");
    } catch (cause) {
      expect(errorData(cause)).toMatchObject({ type: "validation", code: "spec-validation" });
      expect(errorData(cause).problems).toContainEqual({
        path: ["cmd"],
        pred: "unknown export command: export-nothing",
      });
    }
  });
});

describe("createJob", () => {
  it("records the job and hands it to the scheduler", async () => {
    const submitted: Job[] = [];
    const created = await service(async (job) => {
      submitted.push(job);
      return undefined;
    }).createJob(undefined, params());

    expect(created.job).toMatchObject({
      "profile-id": PROFILE,
      cmd: "export-shapes",
      backend: "browser",
      total: 2,
      name: "board",
      "resource-id": "resource-1",
      state: "queued",
    });
    expect(submitted.map((job) => job.id)).toEqual([created.job.id]);
    expect(created.resource.filename).toBe("board.png");
    jobs.release(created.job.id);
  });

  it("marks is-wasm work as headless", async () => {
    const created = await service(async () => undefined).createJob(undefined, params({ "is-wasm": true }));

    expect(created.job.backend).toBe("wasm");
    jobs.release(created.job.id);
  });

  it("fails the record when the scheduler rejects the job", async () => {
    // The scheduler refuses a full queue synchronously, before any job starts.
    const serviceWithFullQueue = service(() => {
      throw new Error("too many queued export jobs");
    });

    await expect(serviceWithFullQueue.createJob(undefined, params())).rejects.toThrow(/too many queued/);
  });
});

describe("exportNow", () => {
  it("runs at once and answers with the finished resource", async () => {
    const serviceNow = service(async () => undefined);
    const created = await serviceNow.exportNow(undefined, params());

    expect(await created.pending).toEqual(RESOURCE);
  });

  it("rejects with the render failure", async () => {
    const failing = createExportService({
      commands: {
        "export-shapes": command({
          prepare: () => ({
            resource: {
              id: "resource-1",
              name: "board",
              filename: "board.png",
              mtype: "image/png",
              path: "/tmp/penpot.resource",
            },
            total: 1,
            headless: false,
            run: async () => {
              throw new Error("renderer crashed");
            },
          }),
        }),
      },
      submit: async () => undefined,
    });

    const created = await failing.exportNow(undefined, params());

    await expect(created.pending).rejects.toThrow(/renderer crashed/);
  });
});