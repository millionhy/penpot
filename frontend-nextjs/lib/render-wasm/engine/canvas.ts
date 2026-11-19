// The canvas/GL lifetime of app.render-wasm.api (G4.2): init-canvas-context,
// resize-canvas!, resize-offscreen-canvas!, clear-canvas and the WebGL
// context-loss bookkeeping.
//
// The port keeps the same split as the compiled code: the module singleton
// and the readiness flags live in ./module, while this file owns the canvas,
// the emscripten GL context handle and the listeners. `initCanvasContext`
// is what turns `live()` on; `clearCanvas` is what turns it off.
//
// Deviations, all at the application boundary:
// - The snapshot listener, the page-transition overlay and the toasts of
//   context loss belong to the app shell, not the engine, so the engine
//   reports the two events through `onContextLost` / `onContextRestored`.
// - The engine also does not call `reload-renderer!` on restore: that is the
//   app's recovery path, and it re-enters `initCanvasContext` itself.
// - `_init` failures are not swallowed. A broken init is a renderer bug and
//   has to surface; the session stays registered so `clearCanvas` can still
//   release the GL context.

import { call } from "./call";
import {
  isContextInitialized,
  live,
  markContextInitialized,
  markContextLost,
  moduleReady,
  resetContextState,
  type RenderWasmModule,
} from "./module";
import { applyRouteParams, resizeViewbox, setRenderOptions, type RouteParams } from "./viewport";

// Must match `gpu_state::MAX_SURFACE_SIZE` on the Rust side. The artifact
// clamps the same way and re-syncs the effective dpr from the drawing
// buffer, so both sides have to agree or the Skia surface and the GL
// framebuffer end up different sizes.
export const MAX_SURFACE_SIZE = 8192;

// default-context-options of the compiled init.
export const CONTEXT_ATTRIBUTES: Readonly<WebGLContextAttributes> = {
  antialias: false,
  depth: true,
  stencil: true,
  alpha: true,
  preserveDrawingBuffer: true,
};

export type BrowserId = "firefox" | "chrome" | "safari" | "safari-16" | "safari-17" | "edge" | "unknown";

// serializers/translate-browser.
const BROWSER_CODES: Readonly<Record<BrowserId, number>> = {
  firefox: 0,
  chrome: 1,
  safari: 2,
  "safari-16": 2,
  "safari-17": 2,
  edge: 3,
  unknown: 4,
};

export function browserCode(browser: BrowserId | number = "unknown"): number {
  if (typeof browser === "number") return browser;
  return BROWSER_CODES[browser] ?? BROWSER_CODES.unknown;
}

// get-dpr: a route override wins over the live devicePixelRatio, and both
// have to be positive finite numbers. Browsers answer 0 or NaN in some
// embedding modes; the compiled code falls back to 1.0 there.
export function readDpr(override?: unknown, devicePixelRatio?: unknown): number {
  const fromOverride = numeric(override);
  if (fromOverride !== undefined) return fromOverride;

  const fromDevice = numeric(
    devicePixelRatio ?? (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio,
  );
  return fromDevice ?? 1;
}

function numeric(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

// clamp-physical-size: never zero, never above the surface cap. The scale is
// floored so the drawing buffer stays inside the cap even after rounding.
export function clampPhysicalSize(width: number, height: number): [number, number] {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const scale = Math.min(1, MAX_SURFACE_SIZE / w, MAX_SURFACE_SIZE / h);
  return [Math.max(1, Math.floor(scale * w)), Math.max(1, Math.floor(scale * h))];
}

export interface CanvasLike {
  width: number;
  height: number;
  clientWidth?: number;
  clientHeight?: number;
}

// canvas-css-size: DOM canvases report their layout size, OffscreenCanvas
// has none and falls back to the physical size divided by the dpr.
export function canvasCssSize(canvas: CanvasLike, dpr: number): [number, number] {
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (typeof cw === "number" && cw > 0 && typeof ch === "number" && ch > 0) {
    return [cw, ch];
  }
  return [canvas.width / dpr, canvas.height / dpr];
}

export interface CanvasGeometry {
  dpr: number;
  cssWidth: number;
  cssHeight: number;
  physicalWidth: number;
  physicalHeight: number;
}

export interface ResizeOptions {
  dpr?: unknown;
  // debug-flags of the renderer; 0 matches a build without debug flags.
  flags?: number;
}

// resize-canvas!: the canvas CSS size is the single source of truth, so the
// GL framebuffer and the Skia target surface cannot drift apart. A smaller
// Skia surface would be anchored to the bottom-left of the drawing buffer
// and leave an unpainted strip on the top and right edges.
export function resizeCanvas(
  module: RenderWasmModule,
  canvas: CanvasLike,
  options: ResizeOptions = {},
): CanvasGeometry | undefined {
  if (!live()) return undefined;

  const dpr = readDpr(options.dpr);
  const [rawCssWidth, rawCssHeight] = canvasCssSize(canvas, dpr);
  const cssWidth = Math.max(1, rawCssWidth);
  const cssHeight = Math.max(1, rawCssHeight);
  const [physicalWidth, physicalHeight] = clampPhysicalSize(
    Math.floor(cssWidth * dpr),
    Math.floor(cssHeight * dpr),
  );

  canvas.width = physicalWidth;
  canvas.height = physicalHeight;
  setRenderOptions(module, options.flags ?? 0, dpr);
  resizeViewbox(module, cssWidth, cssHeight);

  return { dpr, cssWidth, cssHeight, physicalWidth, physicalHeight };
}

// resize-offscreen-canvas!: the caller passes physical pixels. The viewbox
// takes the unclamped size divided by the dpr, exactly like the compiled
// body (the clamp only bounds `canvas.width/height`).
export function resizeOffscreenCanvas(
  module: RenderWasmModule,
  canvas: CanvasLike,
  physicalWidth: number,
  physicalHeight: number,
  options: ResizeOptions = {},
): boolean {
  if (!live()) return false;

  const dpr = readDpr(options.dpr);
  const [clampedWidth, clampedHeight] = clampPhysicalSize(physicalWidth, physicalHeight);
  canvas.width = clampedWidth;
  canvas.height = clampedHeight;
  setRenderOptions(module, options.flags ?? 0, dpr);
  resizeViewbox(module, physicalWidth / dpr, physicalHeight / dpr);
  return true;
}

// --- Emscripten GL

// The GL object the artifact installs on the module. Only the three calls
// the renderer uses are declared; the rest of the Emscripten GL API is not
// reached by the frontend.
export interface EmscriptenGL {
  registerContext(
    context: WebGLRenderingContext,
    attributes: { majorVersion: number },
  ): number;
  makeContextCurrent(handle: number | null): void;
  deleteContext(handle: number): void;
}

export interface CanvasContext {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  webgl: WebGLRenderingContext;
  gl: EmscriptenGL;
  handle: number;
  dpr: number;
  cssWidth: number;
  cssHeight: number;
}

export interface InitCanvasOptions {
  browser?: BrowserId | number;
  flags?: number;
  dpr?: unknown;
  params?: RouteParams;
  // override for the debug "force a failing getContext" switch
  contextId?: "webgl2" | "webgl";
  attributes?: WebGLContextAttributes;
  onContextLost?: (event: Event) => void;
  onContextRestored?: (event: Event) => void;
}

let current: CanvasContext | undefined;
let removeWatchers: (() => void) | undefined;

export function currentCanvasContext(): CanvasContext | undefined {
  return current;
}

// init-canvas-context. Returns the session, or undefined when the module is
// not booted or the browser refuses the context; the caller retries in that
// case (viewport-wasm.cljs try-init does the same).
export function initCanvasContext(
  module: RenderWasmModule,
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: InitCanvasOptions = {},
): CanvasContext | undefined {
  if (!moduleReady()) return undefined;

  const gl = module.GL as EmscriptenGL | undefined;
  if (gl === undefined) return undefined;

  const attributes = options.attributes ?? CONTEXT_ATTRIBUTES;
  const webgl = canvas.getContext(
    options.contextId ?? "webgl2",
    attributes as WebGLContextAttributes,
  ) as WebGLRenderingContext | null;
  if (webgl === null) return undefined;

  const dpr = readDpr(options.dpr);
  const [rawCssWidth, rawCssHeight] = canvasCssSize(canvas, dpr);
  const cssWidth = Math.max(1, rawCssWidth);
  const cssHeight = Math.max(1, rawCssHeight);
  const flags = options.flags ?? 0;

  const handle = gl.registerContext(webgl, { majorVersion: 2 });
  gl.makeContextCurrent(handle);

  current = { canvas, webgl, gl, handle, dpr, cssWidth, cssHeight };

  // Emscripten does not enable the extension itself; some drivers only
  // expose their renderer string after the call.
  webgl.getExtension("WEBGL_debug_renderer_info");

  call(module, "_init", cssWidth, cssHeight);
  call(module, "_set_render_options", flags, dpr);
  applyRouteParams(module, options.params);
  // After `_init`, so the artifact can key behaviour off the browser.
  call(module, "_set_browser", browserCode(options.browser));

  removeWatchers?.();
  removeWatchers = watchContextEvents(canvas, options);

  markContextLost(false);
  markContextInitialized(true);

  // DOM canvas: keep the drawing buffer in sync with the CSS size.
  // OffscreenCanvas has no layout size, so only the viewbox is synced.
  if (typeof (canvas as HTMLCanvasElement).clientWidth === "number" &&
      (canvas as HTMLCanvasElement).clientWidth > 0) {
    resizeCanvas(module, canvas, { dpr, flags });
  } else {
    resizeViewbox(module, cssWidth, cssHeight);
  }

  return current;
}

function watchContextEvents(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: InitCanvasOptions,
): (() => void) | undefined {
  const target = canvas as HTMLCanvasElement;
  if (typeof target.addEventListener !== "function") return undefined;

  const onLost = (event: Event): void => {
    event.preventDefault();
    markContextLost(true);
    options.onContextLost?.(event);
  };
  const onRestored = (event: Event): void => {
    event.preventDefault();
    options.onContextRestored?.(event);
  };

  target.addEventListener("webglcontextlost", onLost);
  target.addEventListener("webglcontextrestored", onRestored);

  return () => {
    target.removeEventListener("webglcontextlost", onLost);
    target.removeEventListener("webglcontextrestored", onRestored);
  };
}

// free-gpu-resources: deliberately not guarded by `live()`. After a restore
// the context is marked lost until re-init, but the browser context is
// usable again and the GPU objects have to be released before `_clean_up`.
export function freeGpuResources(module: RenderWasmModule): boolean {
  if (!isContextInitialized() || !moduleReady()) return false;
  call(module, "_free_gpu_resources");
  return true;
}

export interface ClearCanvasOptions {
  // false keeps the browser context resumable, for reload -> reinit flows
  // where immediate re-creation may fail while the context is lost.
  loseBrowserContext?: boolean;
  // `stop-progressive-render!` and the render flags the compiled body resets.
  onBeforeCleanup?: () => void;
}

// clear-canvas. Never throws: a hot reload can end up here with a module
// that is already half gone, and the compiled original only logs.
export function clearCanvas(
  module: RenderWasmModule | undefined,
  options: ClearCanvasOptions = {},
): boolean {
  const session = current;

  try {
    if (module !== undefined) freeGpuResources(module);

    markContextInitialized(false);
    options.onBeforeCleanup?.();

    removeWatchers?.();
    removeWatchers = undefined;

    if (module !== undefined && moduleReady()) {
      call(module, "_clean_up");
    }

    if (session !== undefined) {
      try {
        if (options.loseBrowserContext !== false) {
          session.webgl.getExtension("WEBGL_lose_context")?.loseContext();
        }
        session.gl.deleteContext(session.handle);
      } catch (cause) {
        console.error(cause);
      }
    }

    current = undefined;
    resetContextState();
    return true;
  } catch (cause) {
    console.error(cause);
    removeWatchers = undefined;
    current = undefined;
    resetContextState();
    return false;
  }
}