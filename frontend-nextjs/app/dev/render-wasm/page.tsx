"use client";

// F6.4 development PoC: drive the compiled render-wasm pipeline from the
// Next.js shell (route B of the WASM integration: reuse public/js/shared.js
// instead of rewriting the serializer in TypeScript).
//
// The flow mirrors the compiled call chain one to one:
//   1. lib/render-wasm/bridge loads shared.js (globals + bridge registry).
//   2. bridge/ensureWasmModule derefs the wasm module delay
//      (app.render-wasm.api/module), the same way app.render-wasm/initialize
//      does, and polls the module-ready? predicate (internal_module._init is
//      callable), which is not exported itself.
//   3. lib/render-wasm/values fetches the view-only bundle as raw transit
//      text and decodes it with the compiled CLJS decoder: transit-js would
//      flatten keywords and uuids to plain strings, and the decoder owns the
//      penpot handlers. Pointer-map payloads (pages shipped as
//      get-file-fragment results) resolve through the same module.
//   4. The frame selrect seeds the canvas size and the viewbox; the GL
//      context is created on the DOM canvas via init-canvas-context.
//   5. initialize-viewport receives the decoded objects, the scale and the
//      {:background-opacity 0 :force-sync true :on-render fn} options verbatim
//      from render-to-canvas*. This shell keeps disable-request-render? at its
//      default false, so the on-render callback drives the normal
//      asynchronous pipeline with request-render("probe").
//
// Query parameters mirror the viewer route: file-id, page-id, frame-id,
// optional share-id and scale (defaults to fit-the-window, capped at 1).
//
// This is a diagnostic surface, not a product page.

import { useCallback, useEffect, useRef, useState } from "react";
import { ensureWasmModule, loadRenderer } from "@/lib/render-wasm/bridge";
import { KEY, arrayMap, call, get, keyword, sleep, uuid } from "@/lib/render-wasm/interop";
import { decodeBundleText, fetchBundleText, resolveBundlePointers } from "@/lib/render-wasm/values";
import { parseViewerQuery } from "@/lib/viewer";

// --- Helpers ----------------------------------------------------------------

async function waitForCanvasSize(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (canvas.clientWidth === width && canvas.clientHeight === height) return;
    await sleep(50);
  }
  throw new Error(
    `canvas did not reach its requested layout size (${width}x${height}); ` +
      "is it hidden or squeezed by a zero-width container?",
  );
}

// --- The flow ---------------------------------------------------------------

type Phase = "idle" | "loading" | "decoding" | "context" | "rendering" | "done" | "error";
type LogLevel = "info" | "ok" | "error";

interface LogLine {
  time: number;
  text: string;
  level: LogLevel;
}

interface RunHooks {
  canvas: HTMLCanvasElement;
  log: (text: string, level?: LogLevel) => void;
  setPhase: (phase: Phase) => void;
  setCanvasSize: (size: { w: number; h: number }) => void;
}

async function runFlow(hooks: RunHooks): Promise<void> {
  const { canvas, log, setPhase, setCanvasSize } = hooks;

  const search = new URLSearchParams(window.location.search);
  const query = parseViewerQuery(search);
  const { fileId, pageId, frameId, shareId } = query;
  if (fileId === null || pageId === null) {
    throw new Error("missing file-id and/or page-id in the URL");
  }
  if (frameId === null) {
    throw new Error("missing frame-id in the URL");
  }
  log(
    `params: file-id=${fileId} page-id=${pageId} frame-id=${frameId}` +
      (shareId !== null ? ` share-id=${shareId}` : ""),
  );

  // 1. main.js (the app.main entry chunk; imports ./shared.js itself): the
  // bridge sets its globals before the artifact evaluates. The first call
  // parses a large chunk, so it takes a moment.
  log("loading /js/main.js (entry chunk; pulls in shared.js)");
  const app = await loadRenderer();
  log("shared.js evaluated ($APP available)", "ok");

  // 2. Boot the wasm module through the bridge helper (the module delay deref
  // + the wasm/module-ready? poll now live in ensureWasmModule).
  const moduleState = await ensureWasmModule(app);
  log(`wasm module ${moduleState} (internal_module._init is callable)`, "ok");

  // 3. The view-only bundle as raw transit text through the TS transport's
  // raw leg (cmdRaw): the CLJS decoder owns the penpot handlers
  // (objects-map/v2, path-data...), so transit-js stays out of the way.
  const raw = await fetchBundleText({ fileId, shareId });
  log(`bundle received as raw transit: ${raw.length} chars`);

  // 4. Value bridge: decode with the compiled CLJS transit decoder and walk
  // the map with the compiled get/keyword/uuid helpers. Keywords intern
  // globally, so runtime-built keywords match the compiled cst constants.
  // Pointer-mapped values (pages shipped as fragments) resolve through
  // get-file-fragment, mirroring fetch-bundle in app.main.data.viewer.
  setPhase("decoding");
  const decoded = decodeBundleText(app, raw);
  const fileData = await resolveBundlePointers(app, decoded.fileData, { fileId, shareId });
  log("bundle decoded and pointer fragments resolved", "ok");
  const pagesIndex = get(app, fileData, keyword(app, "pages-index"));
  const page = get(app, pagesIndex, uuid(app, pageId));
  const objects = get(app, page, keyword(app, "objects"));
  if (objects === null || objects === undefined) {
    throw new Error("page has no :objects after pointer resolution");
  }
  const frame = get(app, objects, uuid(app, frameId));
  const selrect = get(app, frame, keyword(app, "selrect"));
  // Strict on purpose: a failed frame lookup yields null here, and a lenient
  // Number(null) === 0 would silently size the canvas 1x1 instead of failing.
  const asNumber = (value: unknown, label: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `frame selrect: ${label} is not a number (${JSON.stringify(value)}) — ` +
          "did the frame lookup fail?",
      );
    }
    return value;
  };
  const frameX = asNumber(get(app, selrect, keyword(app, "x")), "x");
  const frameY = asNumber(get(app, selrect, keyword(app, "y")), "y");
  const frameW = asNumber(get(app, selrect, keyword(app, "width")), "width");
  const frameH = asNumber(get(app, selrect, keyword(app, "height")), "height");
  log(`frame selrect: x=${frameX} y=${frameY} w=${frameW} h=${frameH}`, "ok");

  // 5. Size the canvas to frame * scale. The size is declarative state, so
  // poll the DOM until the layout reflects it: init-canvas-context reads
  // clientWidth/clientHeight to size the GL surface.
  const explicitScale = Number(search.get("scale"));
  const scale =
    Number.isFinite(explicitScale) && explicitScale > 0
      ? explicitScale
      : Math.min(1, (window.innerWidth - 64) / frameW, (window.innerHeight - 320) / frameH);
  const cssW = Math.max(1, Math.ceil(frameW * scale));
  const cssH = Math.max(1, Math.ceil(frameH * scale));
  log(`canvas css size ${cssW}x${cssH} (scale ${scale})`);
  setCanvasSize({ w: cssW, h: cssH });
  await waitForCanvasSize(canvas, cssW, cssH);

  // 6. GL context on the DOM canvas, the same call the workspace makes.
  setPhase("context");
  const initialized = call(app, KEY.initCanvasContext, canvas);
  if (initialized !== true) {
    throw new Error(`init_canvas_context returned ${String(initialized)} — module not ready?`);
  }
  log(
    `init_canvas_context = true (live=${String(call(app, KEY.wasmLive))}` +
      ` ready=${String(call(app, KEY.wasmReady))})`,
    "ok",
  );

  // 7. Viewport: objects + scale + vbox {:x :y} + the render-to-canvas*
  // option map. disable-request-render? stays at its default false.
  setPhase("rendering");
  const vbox = arrayMap(app, [
    [keyword(app, "x"), frameX],
    [keyword(app, "y"), frameY],
  ]);
  const onRender = (): void => {
    log("on-render: pending resources settled — rulers off + request-render('probe')");
    try {
      call(app, KEY.setRulersFrameVisible, false);
      call(app, KEY.setRulersVisible, false);
      call(app, KEY.requestRender, "probe");
    } catch (err) {
      log(`on-render error: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };
  const options = arrayMap(app, [
    [keyword(app, "background-opacity"), 0],
    [keyword(app, "force-sync"), true],
    [keyword(app, "on-render"), onRender],
  ]);
  log("initialize-viewport(objects, scale, vbox, {:background-opacity 0 :force-sync true :on-render fn})");
  call(app, KEY.initializeViewport, objects, scale, vbox, options);
  log("initialize-viewport returned; waiting for the render events", "ok");
}

// --- Page -------------------------------------------------------------------

function stamp(time: number): string {
  const d = new Date(time);
  const pad = (n: number, length = 2): string => String(n).padStart(length, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export default function RenderWasmDevPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const autoRanRef = useRef(false);
  const runningRef = useRef(false);
  const phaseRef = useRef<Phase>("idle");

  const [phase, setPhase] = useState<Phase>("idle");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capture, setCapture] = useState<string | null>(null);

  const log = useCallback((text: string, level: LogLevel = "info") => {
    setLines((prev) => [...prev, { time: Date.now(), text, level }]);
    const sink = level === "error" ? console.error : console.log;
    sink(`[render-wasm-poc] ${text}`);
  }, []);

  // init-canvas-context sets preserveDrawingBuffer (render_wasm/api.cljs), so
  // the back buffer survives the frame and toDataURL reads it at rest. The
  // image is kept in state, mirrored on window.__pocLastFrame for headless
  // readers, and logged by length only — the dataURL is far too big to log.
  const captureFrame = useCallback(
    (label: string) => {
      const canvas = canvasRef.current;
      if (canvas === null) return;
      try {
        const dataUrl = canvas.toDataURL("image/png");
        setCapture(dataUrl);
        (window as unknown as Record<string, unknown>).__pocLastFrame = dataUrl;
        log(`frame captured (${label}): ${dataUrl.length} chars`);
      } catch (err) {
        log(
          `frame capture failed (${label}): ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
    [log],
  );

  const setPhaseTracked = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  // Completion signals. The wasm side dispatches "penpot:wasm:render" at the
  // end of every render pass and "penpot:wasm:tiles-complete" from inside the
  // wasm binary once the tiles have rasterized.
  useEffect(() => {
    const onRenderEvent = (): void => {
      log("event: penpot:wasm:render (render pass completed)", "ok");
      if (phaseRef.current === "rendering") setPhaseTracked("done");
      setTimeout(() => captureFrame("wasm:render"), 500);
    };
    const onTilesEvent = (): void => {
      log("event: penpot:wasm:tiles-complete (tiles rasterized)", "ok");
      if (phaseRef.current === "rendering") setPhaseTracked("done");
      setTimeout(() => captureFrame("wasm:tiles-complete"), 500);
    };
    document.addEventListener("penpot:wasm:render", onRenderEvent);
    document.addEventListener("penpot:wasm:tiles-complete", onTilesEvent);
    return () => {
      document.removeEventListener("penpot:wasm:render", onRenderEvent);
      document.removeEventListener("penpot:wasm:tiles-complete", onTilesEvent);
    };
  }, [log, setPhaseTracked, captureFrame]);

  const run = useCallback(async () => {
    const canvas = canvasRef.current;
    if (canvas === null || runningRef.current) return;
    runningRef.current = true;
    setError(null);
    setLines([]);
    setCapture(null);
    setPhaseTracked("loading");
    log("run: start");
    try {
      await runFlow({ canvas, log, setPhase: setPhaseTracked, setCanvasSize });
      log("run: setup complete", "ok");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setPhaseTracked("error");
      log(`run failed: ${message}`, "error");
    } finally {
      runningRef.current = false;
    }
  }, [log, setPhaseTracked]);

  // Auto-run once on mount (the ref survives the StrictMode double effect).
  useEffect(() => {
    if (autoRanRef.current) return;
    autoRanRef.current = true;
    void run();
  }, [run]);

  const phaseColor =
    phase === "done" ? "#1a7f37" : phase === "error" ? "#b3261e" : phase === "idle" ? "#57606a" : "#8a5a00";

  return (
    <main style={{ padding: "24px 28px", fontFamily: "system-ui, sans-serif", color: "#1b1f24" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>
        F6.4 PoC — render-wasm in the Next.js shell
      </h1>
      <p style={{ margin: "0 0 4px", color: "#57606a", maxWidth: 860 }}>
        Loads <code>/js/shared.js</code> (the compiled CLJS frontend), boots the wasm renderer
        through its own module delay, fetches the view-only bundle as raw transit and renders
        the frame given by <code>frame-id</code> onto the canvas below.
      </p>
      <p style={{ margin: "0 0 16px", color: "#57606a", maxWidth: 860 }}>
        URL: <code>/dev/render-wasm?file-id=…&amp;page-id=…&amp;frame-id=…</code> (optional{" "}
        <code>share-id</code> for anonymous share links, <code>scale</code> to override the
        fit-the-window default).
      </p>
      <p style={{ margin: "0 0 8px" }}>
        phase: <strong style={{ color: phaseColor }}>{phase}</strong>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ marginLeft: 12, padding: "2px 10px" }}
        >
          Reload &amp; run again
        </button>
      </p>
      {error !== null ? (
        <pre
          style={{
            padding: "10px 12px",
            background: "#fdecea",
            border: "1px solid #f3b6b0",
            borderRadius: 6,
            whiteSpace: "pre-wrap",
            font: "12px/1.6 ui-monospace, Menlo, monospace",
          }}
        >
          {error}
        </pre>
      ) : null}
      <div
        style={{
          display: "inline-block",
          maxWidth: "100%",
          overflow: "auto",
          padding: 8,
          background: "#e8e8ef",
          borderRadius: 6,
          margin: "8px 0 16px",
        }}
      >
        <canvas
          ref={canvasRef}
          width={300}
          height={150}
          style={{
            display: "block",
            background: "#ffffff",
            width: canvasSize === null ? 320 : canvasSize.w,
            height: canvasSize === null ? 200 : canvasSize.h,
          }}
        />
      </div>
      {capture !== null ? (
        <div style={{ margin: "0 0 16px" }}>
          <p style={{ margin: "0 0 6px", color: "#57606a" }}>
            frame capture via canvas.toDataURL (identical pixels to the canvas above)
          </p>
          <img
            id="poc-frame-capture"
            src={capture}
            alt="captured render frame"
            style={{ maxWidth: "100%", border: "1px solid #d0d7de", borderRadius: 6 }}
          />
        </div>
      ) : null}
      <ol
        style={{
          margin: 0,
          padding: "10px 14px",
          background: "#111418",
          color: "#d5dbe3",
          borderRadius: 6,
          font: "12px/1.6 ui-monospace, Menlo, monospace",
          listStyle: "none",
          maxHeight: 340,
          overflow: "auto",
        }}
      >
        {lines.map((line, index) => (
          <li
            key={index}
            style={{
              color:
                line.level === "error" ? "#ff9d94" : line.level === "ok" ? "#7fd18a" : "#d5dbe3",
              whiteSpace: "pre-wrap",
            }}
          >
            {stamp(line.time)} {line.text}
          </li>
        ))}
      </ol>
    </main>
  );
}
