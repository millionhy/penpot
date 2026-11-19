// app.handlers.export-frames: params validation, preparation and the PDF
// join/upload pipeline.

import { afterEach, describe, expect, it } from "vitest";

import { errorData } from "../errors.js";
import type { Job } from "../jobs.js";
import type { RenderParams } from "../renderer.js";
import type { FileStat } from "../util/shell.js";
import type { ResourceHandle } from "./export.js";
import {
  conformFramesParams,
  prepare,
  resetDeps,
  setDeps,
  type ExportFramesDeps,
} from "./export-frames.js";

const FILE = "11111111-1111-1111-1111-111111111111";
const PAGE = "22222222-2222-2222-2222-222222222222";
const OBJECT_A = "33333333-3333-3333-3333-333333333333";
const OBJECT_B = "44444444-4444-4444-4444-444444444444";

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "file-id": FILE,
    "page-id": PAGE,
    "object-id": OBJECT_A,
    name: "Frame A",
    ...overrides,
  };
}

function params(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { cmd: "export-frames", exports: [entry()], ...overrides };
}

function jobRecord(): Job {
  return {
    id: "job-1",
    "profile-id": "55555555-5555-5555-5555-555555555555",
    cmd: "export-frames",
    backend: "wasm",
    state: "running",
    done: 0,
    total: 1,
    name: "Board",
    "resource-id": "resource-1",
    "created-at": 0,
  };
}

interface Harness {
  rendered: RenderParams[];
  commands: Array<[string, string[]]>;
  moves: Array<[string, string]>;
  tracked: Array<[string, string | undefined]>;
  progress: number[];
  uploaded: boolean;
  stat: FileStat | null;
}

function harness(overrides: Partial<Harness> = {}): Harness {
  return {
    rendered: [],
    commands: [],
    moves: [],
    tracked: [],
    progress: [],
    uploaded: false,
    stat: { path: "/tmp/Board", "created-at": 12, size: 42 },
    ...overrides,
  };
}

function install(state: Harness, extra: Partial<ExportFramesDeps> = {}): void {
  setDeps({
    createResource: (type, name) =>
      ({
        id: "resource-1",
        name,
        path: `/tmp/${name}`,
        filename: `${name}.${type}`,
        mtype: "application/pdf",
      }) as ResourceHandle,
    uploadResource: async (_token, resource) => {
      state.uploaded = true;
      return { ...resource, uri: "http://assets/Board.pdf", size: 42 };
    },
    render: async (renderParams, report) => {
      state.rendered.push(renderParams);
      for (const object of renderParams.objects) {
        report({
          id: object.id,
          name: object.name,
          suffix: object.suffix,
          filename: object.filename,
          path: `/tmp/render-${object.id}`,
        });
      }
    },
    withScope: async (_exports, f) =>
      f(async (renderParams, report) => {
        state.rendered.push(renderParams);
        for (const object of renderParams.objects) {
          report({
            id: object.id,
            name: object.name,
            suffix: object.suffix,
            filename: object.filename,
            path: `/tmp/render-${object.id}`,
          });
        }
      }),
    track: (jobId, filePath) => {
      state.tracked.push([String(jobId), filePath]);
      return filePath;
    },
    move: async (origin, dest) => {
      state.moves.push([origin, dest]);
    },
    runCmd: async (cmd, args) => {
      state.commands.push([cmd, [...args]]);
      return Buffer.alloc(0);
    },
    tempfile: (options = {}) => `/tmp/${options.prefix ?? ""}out${options.suffix ?? ""}`,
    stat: async () => state.stat,
    progress: async (_job, done) => {
      state.progress.push(done);
      return undefined;
    },
    checkCancelled: () => undefined,
    ...extra,
  });
}

afterEach(() => {
  resetDeps();
});

describe("conformFramesParams", () => {
  it("accepts frame exports", () => {
    expect(conformFramesParams(params({ name: "bundle" }))).toMatchObject({ cmd: "export-frames" });
  });

  it("rejects a missing file id", () => {
    try {
      conformFramesParams(params({ exports: [entry({ "file-id": undefined })] }));
      throw new Error("expected a rejection");
    } catch (cause) {
      expect(errorData(cause).problems).toContainEqual({
        path: ["exports", 0, "file-id"],
        pred: "should be a uuid",
      });
    }
  });

  it("rejects a nameless frame", () => {
    try {
      conformFramesParams(params({ exports: [entry({ name: 5 })] }));
      throw new Error("expected a rejection");
    } catch (cause) {
      expect(errorData(cause).problems).toContainEqual({
        path: ["exports", 0, "name"],
        pred: "should be a string",
      });
    }
  });
});

describe("prepare", () => {
  it("renders every frame as a pdf page", () => {
    const state = harness();
    install(state);

    const prepared = prepare(undefined, params({ exports: [entry(), entry({ "object-id": OBJECT_B, name: "Frame B" })] }));

    expect(prepared.resource).toMatchObject({ name: "Frame A", filename: "Frame A.pdf" });
    expect(prepared.total).toBe(2);
    expect(prepared.headless).toBe(false);
  });

  it("uses the requested name and honours is-wasm", () => {
    const state = harness();
    install(state);

    const prepared = prepare(undefined, params({ name: "bundle", "is-wasm": true }));

    expect(prepared.resource.filename).toBe("bundle.pdf");
    expect(prepared.headless).toBe(true);
  });
});

describe("run", () => {
  it("renders, joins, renames and uploads the pdf", async () => {
    const state = harness();
    install(state);
    const prepared = prepare(undefined, params({ "is-wasm": true }));

    const result = await prepared.run(jobRecord());

    expect(state.rendered).toHaveLength(1);
    expect(state.rendered[0]).toMatchObject({ type: "pdf", scale: 1, "is-wasm": true, "job-id": "job-1" });
    expect(state.rendered[0].objects[0]).toMatchObject({ id: OBJECT_A, suffix: "" });
    expect(state.progress).toEqual([1]);
    expect(state.commands).toEqual([
      ["pdfunite", [`/tmp/render-${OBJECT_A}`, `/tmp/penpot.pdfunite.${FILE}.out.pdf`]],
    ]);
    expect(state.moves).toEqual([[`/tmp/penpot.pdfunite.${FILE}.out.pdf`, prepared.resource.path]]);
    expect(state.uploaded).toBe(true);
    expect(result).toMatchObject({ uri: "http://assets/Board.pdf", size: 42 });
    expect(result).not.toHaveProperty("path");
  });

  it("renders every frame and joins all pages", async () => {
    const state = harness();
    install(state);
    const prepared = prepare(undefined, params({ exports: [entry(), entry({ "object-id": OBJECT_B })] }));

    await prepared.run(jobRecord());

    expect(state.commands[0][1]).toEqual([
      `/tmp/render-${OBJECT_A}`,
      `/tmp/render-${OBJECT_B}`,
      `/tmp/penpot.pdfunite.${FILE}.out.pdf`,
    ]);
  });

  it("keeps the resource when the file stat is gone", async () => {
    const state = harness({ stat: null });
    install(state);
    const prepared = prepare(undefined, params());

    const result = await prepared.run(jobRecord());

    expect(result).toMatchObject({ uri: "http://assets/Board.pdf", size: 42 });
  });

  it("does not join pages when a render fails", async () => {
    const state = harness();
    install(state, {
      withScope: async () => {
        throw new Error("renderer crashed");
      },
    });
    const prepared = prepare(undefined, params());

    await expect(prepared.run(jobRecord())).rejects.toThrow(/renderer crashed/);
    expect(state.commands).toHaveLength(0);
    expect(state.uploaded).toBe(false);
  });
});
