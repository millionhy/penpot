// app.handlers.export-shapes: params validation, preparation and the two run
// shapes (single file, zip).

import { afterEach, describe, expect, it } from "vitest";

import { errorData } from "../errors.js";
import type { Job } from "../jobs.js";
import type { RenderParams } from "../renderer.js";
import { get, getExtension, type ExportType } from "../util/mime.js";
import type { ResourceHandle } from "./export.js";
import {
  conformShapesParams,
  countObjects,
  DEFAULT_PARTITION_SIZE,
  prepare,
  prepareExports,
  resetDeps,
  setDeps,
  type ExportShapesDeps,
} from "./export-shapes.js";
import type * as resources from "./resources.js";

const FILE = "11111111-1111-1111-1111-111111111111";
const PAGE = "22222222-2222-2222-2222-222222222222";
const OBJECT = "33333333-3333-3333-3333-333333333333";
const PROFILE = "44444444-4444-4444-4444-444444444444";

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "file-id": FILE,
    "page-id": PAGE,
    "object-id": OBJECT,
    name: "Board",
    suffix: "",
    scale: 2,
    type: "png",
    filename: "Board.png",
    ...overrides,
  };
}

function params(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cmd: "export-shapes",
    "profile-id": PROFILE,
    exports: [entry()],
    ...overrides,
  };
}

function jobRecord(id = "job-1"): Job {
  return {
    id,
    "profile-id": PROFILE,
    cmd: "export-shapes",
    backend: "browser",
    state: "running",
    done: 0,
    total: 1,
    name: "Board",
    "resource-id": "resource-1",
    "created-at": 0,
  };
}

function resourceFor(type: ExportType, name: string): ResourceHandle {
  return {
    id: "resource-1",
    name,
    path: `/tmp/${name}`,
    filename: `${name}${getExtension(type)}`,
    mtype: get(type),
  };
}

interface Harness {
  rendered: RenderParams[];
  moves: Array<[string, string]>;
  tracked: Array<[string, string | undefined]>;
  progress: number[];
  added: Array<[string, string]>;
  closed: boolean;
  onError?: (cause: unknown) => void;
  onProgress?: (progress: { done: number; filename: string }) => void;
}

function harness(overrides: Partial<Harness> = {}): Harness {
  return {
    rendered: [],
    moves: [],
    tracked: [],
    progress: [],
    added: [],
    closed: false,
    ...overrides,
  };
}

function install(state: Harness, extra: Partial<ExportShapesDeps> = {}): void {
  setDeps({
    createResource: (type, name) => resourceFor(type, name),
    createZip: (options) => {
      state.onError = options.onError;
      state.onProgress = options.onProgress;
      const zip = {
        on: () => zip,
        pipe: () => undefined,
        file: () => undefined,
        finalize: () => undefined,
      };
      return zip as unknown as ReturnType<typeof resources.createZip>;
    },
    addToZip: (_zip, filePath, name) => state.added.push([filePath, name]),
    closeZip: async () => {
      state.closed = true;
    },
    uploadResource: async (_token, resource) => ({
      ...resource,
      uri: `http://assets/${resource.filename}`,
      size: 7,
    }),
    track: (jobId, filePath) => {
      state.tracked.push([String(jobId), filePath]);
      return filePath;
    },
    move: async (origin, dest) => {
      state.moves.push([origin, dest]);
    },
    progress: async (_job, done) => {
      state.progress.push(done);
      return undefined;
    },
    checkCancelled: () => undefined,
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
    ...extra,
  });
}

afterEach(() => {
  resetDeps();
});

describe("conformShapesParams", () => {
  it("accepts a full export", () => {
    expect(conformShapesParams(params({ wait: true }))).toMatchObject({
      cmd: "export-shapes",
      "profile-id": PROFILE,
      wait: true,
    });
  });

  it("rejects a missing profile", () => {
    try {
      conformShapesParams(params({ "profile-id": undefined }));
      throw new Error("expected a rejection");
    } catch (cause) {
      expect(errorData(cause)).toMatchObject({ type: "validation", code: "spec-validation" });
      expect(errorData(cause).problems).toContainEqual({ path: ["profile-id"], pred: "should be a uuid" });
    }
  });

  it("rejects an empty export collection", () => {
    try {
      conformShapesParams(params({ exports: [] }));
      throw new Error("expected a rejection");
    } catch (cause) {
      expect(errorData(cause).problems).toContainEqual({
        path: ["exports"],
        pred: "should be a non-empty vector",
      });
    }
  });

  it("names the offending entry and key", () => {
    try {
      conformShapesParams(params({ exports: [entry({ "object-id": "nope", scale: "2" })] }));
      throw new Error("expected a rejection");
    } catch (cause) {
      expect(errorData(cause).problems).toContainEqual({
        path: ["exports", 0, "object-id"],
        pred: "should be a uuid",
      });
      expect(errorData(cause).problems).toContainEqual({
        path: ["exports", 0, "scale"],
        pred: "should be a number",
      });
    }
  });

  it("rejects non boolean flags", () => {
    try {
      conformShapesParams(params({ "is-wasm": "yes", wait: 1 }));
      throw new Error("expected a rejection");
    } catch (cause) {
      expect(errorData(cause).problems).toContainEqual({ path: ["wait"], pred: "should be a boolean" });
      expect(errorData(cause).problems).toContainEqual({ path: ["is-wasm"], pred: "should be a boolean" });
    }
  });
});

describe("prepareExports", () => {
  it("names files and avoids duplicates", () => {
    const exports = prepareExports(
      [entry(), entry({ suffix: "@2x" }), entry()],
      "token",
      false,
    );

    expect(exports).toHaveLength(1);
    expect(exports[0].objects.map((object) => object.filename)).toEqual([
      "Board.png",
      "Board@2x.png",
      "Board-2.png",
    ]);
    expect(exports[0].token).toBe("token");
  });

  it("groups by scale and type", () => {
    const exports = prepareExports(
      [entry(), entry({ type: "jpeg" }), entry({ scale: 1 })],
      undefined,
      false,
    );

    expect(exports.map((item) => [item.type, item.scale])).toEqual([
      ["png", 2],
      ["jpeg", 2],
      ["png", 1],
    ]);
  });

  it("partitions browser renders by fifty objects", () => {
    const exports = prepareExports(
      Array.from({ length: DEFAULT_PARTITION_SIZE + 1 }, () => entry()),
      undefined,
      false,
    );

    expect(exports.map((item) => item.objects.length)).toEqual([DEFAULT_PARTITION_SIZE, 1]);
  });

  it("keeps a headless group in one render", () => {
    const exports = prepareExports(
      Array.from({ length: DEFAULT_PARTITION_SIZE + 1 }, () => entry()),
      undefined,
      true,
    );

    expect(exports).toHaveLength(1);
    expect(exports[0].objects).toHaveLength(DEFAULT_PARTITION_SIZE + 1);
  });
});

describe("prepare", () => {
  it("builds one resource for a single object", () => {
    const state = harness();
    install(state);

    const prepared = prepare(undefined, params());

    expect(prepared.resource).toMatchObject({
      name: "Board",
      filename: "Board.png",
      mtype: "image/png",
    });
    expect(prepared.total).toBe(1);
    expect(prepared.headless).toBe(false);
  });

  it("builds a zip for several objects", () => {
    const state = harness();
    install(state);

    const prepared = prepare(undefined, params({ exports: [entry(), entry()], name: "bundle" }));

    expect(prepared.resource).toMatchObject({ name: "bundle", filename: "bundle.zip" });
    expect(prepared.total).toBe(2);
  });

  it("honours force-multiple for a single object", () => {
    const state = harness();
    install(state);

    const prepared = prepare(undefined, params({ "force-multiple": true }));

    expect(prepared.resource.filename).toBe("Board.zip");
  });

  it("reports headless when is-wasm is set", () => {
    const state = harness();
    install(state);

    expect(prepare(undefined, params({ "is-wasm": true })).headless).toBe(true);
  });
});

describe("run", () => {
  it("renders, renames and uploads a single file", async () => {
    const state = harness();
    install(state);
    const prepared = prepare(undefined, params({ "is-wasm": true, "skip-children": true }));

    const result = await prepared.run(jobRecord());

    expect(state.rendered).toHaveLength(1);
    expect(state.rendered[0]).toMatchObject({
      type: "png",
      "is-wasm": true,
      "job-id": "job-1",
      "skip-children": true,
    });
    expect(state.moves).toEqual([["/tmp/render-" + OBJECT, prepared.resource.path]]);
    expect(result).toMatchObject({ uri: "http://assets/Board.png", size: 7 });
    expect(result).not.toHaveProperty("path");
    expect(state.tracked).toContainEqual(["job-1", prepared.resource.path]);
  });

  it("zips every rendered file with a sanitized name", async () => {
    const state = harness();
    install(state);
    const prepared = prepare(undefined, params({ exports: [entry(), entry({ name: "A/B" })] }));

    await prepared.run(jobRecord());

    expect(state.rendered).toHaveLength(1);
    expect(state.rendered[0].objects).toHaveLength(2);
    expect(state.added).toEqual([
      ["/tmp/render-" + OBJECT, "Board.png"],
      ["/tmp/render-" + OBJECT, "A_B.png"],
    ]);
    expect(state.closed).toBe(true);
  });

  it("fails before closing the zip when a file could not be appended", async () => {
    const state = harness();
    install(state);
    const prepared = prepare(undefined, params({ exports: [entry(), entry()] }));

    // The archiver reports the failure asynchronously, while the renders are
    // still running.
    const zipState = state;
    install(state, {
      withScope: async (_exports, f) =>
        f(async (renderParams, report) => {
          zipState.onError?.(new Error("disk full"));
          report({
            id: renderParams.objects[0].id,
            name: "Board",
            suffix: "",
            filename: "Board.png",
            path: "/tmp/render-board",
          });
        }),
    });

    await expect(prepared.run(jobRecord())).rejects.toThrow(/disk full/);
    expect(state.closed).toBe(false);
  });

  it("stops before rendering when the job was cancelled", async () => {
    const state = harness();
    install(state, {
      checkCancelled: () => {
        throw new Error("cancelled");
      },
    });
    const prepared = prepare(undefined, params());

    await expect(prepared.run(jobRecord())).rejects.toThrow(/cancelled/);
    expect(state.rendered).toHaveLength(0);
  });
});

describe("countObjects", () => {
  it("adds the objects of every export", () => {
    expect(countObjects([{ objects: [1, 2] }, { objects: [] }, {}])).toBe(2);
  });
});
