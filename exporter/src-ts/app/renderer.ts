// app.renderer: the common renderer interface.
//
// One `render` call takes the params of a single render.html page and reports
// every finished object through `on-object` (it carries the temp file path).
// The type decides the backend: bitmap, pdf and svg go through playwright; a
// headless request goes to the wasm backend, which G2.5 registers here.
//
// `with-scope` matters for headless exports: a job leases one worker for the
// whole call instead of one per render. Browser exports keep rendering in
// parallel and only pay for a scope check.

import { raise } from "./errors.js";
import { createLogger } from "./logging.js";
import * as bitmap from "./renderer/bitmap.js";
import * as pdfRenderer from "./renderer/pdf.js";
import * as svg from "./renderer/svg.js";

const log = createLogger("app.renderer");

export type RenderType = "png" | "jpeg" | "webp" | "pdf" | "svg";

const RENDER_TYPES: ReadonlySet<string> = new Set(["png", "jpeg", "webp", "pdf", "svg"]);

export interface RenderObject {
  id: string;
  name: string;
  suffix: string;
  filename: string;
  path?: string;
  [key: string]: unknown;
}

export interface RenderParams {
  "file-id": string;
  "page-id": string;
  "share-id"?: string;
  scale: number;
  token?: string;
  type: RenderType;
  objects: RenderObject[];
  "is-wasm"?: boolean;
  "job-id"?: string;
  "skip-children"?: boolean;
  name?: string;
}

export type OnObject = (object: RenderObject) => void;

export type RenderFn = (params: RenderParams, onObject: OnObject) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// us/verify of ::render-params: required keys, the object collection and the
// optional flags. The CLJS spec raised an assertion, which `on-error` renders
// as a 400 with the explain text.
export function checkParams(params: unknown): asserts params is RenderParams {
  const problems: string[] = [];

  if (!isObject(params)) {
    raise({ type: "assertion", code: "assertion", hint: "params should be a map" });
  }

  for (const key of ["file-id", "page-id"]) {
    const value = params[key];
    if (typeof value !== "string" || !UUID.test(value)) problems.push(`${key} should be a uuid`);
  }

  if (typeof params.scale !== "number" || Number.isNaN(params.scale)) {
    problems.push("scale should be a number");
  }

  if (params.token !== undefined && typeof params.token !== "string") {
    problems.push("token should be a string");
  }

  if (typeof params.type !== "string" || !RENDER_TYPES.has(params.type)) {
    problems.push("type should be one of png, jpeg, webp, pdf or svg");
  }

  const objects = params.objects;
  if (!Array.isArray(objects) || objects.length === 0) {
    problems.push("objects should be a non-empty collection");
  } else {
    objects.forEach((object, index) => {
      if (!isObject(object)) {
        problems.push(`objects[${index}] should be a map`);
        return;
      }
      for (const key of ["id", "name", "suffix", "filename"]) {
        if (typeof object[key] !== "string") problems.push(`objects[${index}].${key} should be a string`);
      }
    });
  }

  if (params["is-wasm"] !== undefined && typeof params["is-wasm"] !== "boolean") {
    problems.push("is-wasm should be a boolean");
  }

  if (params["job-id"] !== undefined && typeof params["job-id"] !== "string") {
    problems.push("job-id should be a uuid");
  }

  if (problems.length > 0) {
    raise({ type: "assertion", code: "assertion", hint: problems.join("\n") });
  }
}

// Whether `params` renders with render-wasm rather than a browser. The type is
// accepted so callers can pass the whole render map, as the CLJS version did.
export function headless(params: { "is-wasm"?: boolean; type?: string }): boolean {
  return Boolean(params["is-wasm"]);
}

export interface HeadlessRenderer {
  render(params: RenderParams, onObject: OnObject): Promise<void>;
  withScope(jobId: string | undefined, f: (render: RenderFn) => Promise<void>): Promise<void>;
}

let headlessBackend: HeadlessRenderer | undefined;

// The wasm backend needs the worker pool, which is a later slice. Registering it
// here keeps the dispatch in one place, as `app.renderer` did with its require.
export function setHeadlessRenderer(backend: HeadlessRenderer | undefined): void {
  headlessBackend = backend;
}

function browserRender(params: RenderParams): RenderFn | undefined {
  switch (params.type) {
    case "png":
    case "jpeg":
    case "webp":
      return bitmap.render;
    case "pdf":
      return pdfRenderer.render;
    case "svg":
      return svg.render;
    default:
      return undefined;
  }
}

export async function render(params: RenderParams, onObject: OnObject): Promise<void> {
  checkParams(params);
  if (typeof onObject !== "function") {
    raise({ type: "assertion", code: "assertion", hint: "on-object should be a function" });
  }

  if (params["is-wasm"] !== undefined) {
    log.info({
      hint: "render",
      type: params.type,
      backend: headless(params) ? "wasm" : "browser",
    });
  }

  if (headless(params)) {
    if (headlessBackend === undefined) {
      raise({
        type: "internal",
        code: "headless-renderer-not-ready",
        hint: "the wasm renderer is not registered",
      });
    }
    return headlessBackend.render(params, onObject);
  }

  const renderer = browserRender(params);
  if (renderer === undefined) {
    raise({ type: "assertion", code: "assertion", hint: `unknown render type: ${params.type}` });
  }
  return renderer(params, onObject);
}

// Runs `f` with a render fn of the same signature as `render`. Headless
// exports share one worker for the whole call; the browser backend keeps
// rendering them in parallel.
export async function withScope(
  exports: readonly RenderParams[],
  f: (render: RenderFn) => Promise<void>,
): Promise<void> {
  if (!exports.some((params) => headless(params))) {
    return f(render);
  }

  if (headlessBackend === undefined) {
    raise({
      type: "internal",
      code: "headless-renderer-not-ready",
      hint: "the wasm renderer is not registered",
    });
  }

  const jobId = exports[0]?.["job-id"];
  return headlessBackend.withScope(jobId, (renderLeased) =>
    f(async (params, onObject) => {
      checkParams(params);
      if (typeof onObject !== "function") {
        raise({ type: "assertion", code: "assertion", hint: "on-object should be a function" });
      }
      if (headless(params)) return renderLeased(params, onObject);
      return render(params, onObject);
    }),
  );
}