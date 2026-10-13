"use client";

// Viewer page (F6.2/F6.3, frame rendering F6.4): the shell port of
// app.main.ui.viewer. It loads the view-only bundle (lib/viewer.ts), keeps
// the viewer-local slice (zoom, zoom-type, fullscreen, thumbnails) and
// renders the header, the frame pagination, the thumbnails panel, the
// render-wasm frame viewport (components/viewer-wasm-viewport) and the
// open overlays (components/viewer-overlay).
//
// Deviations from the CLJS original, documented:
// - The viewer is a public route (anonymous share-link visitors are the
//   point of it), so the page is not wrapped in AuthGuard; the bundle
//   carries the permissions the backend resolved for the session.
// - The bundle is fetched once per file; the CLJS initialize re-runs on a
//   page-id change, re-downloading the whole bundle.
// - bundle-fetched normalization mirrors the frame into the URL with a
//   replace, guarded by a ref so a back-button visit is not re-normalized;
//   the CLJS pushes an entry from every load.
// - zoom-to-fit / zoom-to-fill compute against the rendered frame
//   (displayIndex) instead of the raw URL index, which handles the
//   untracked case of a page opened without an index parameter.
// - A missing page or a fetch failure renders the empty state; the
//   ex/raise :not-found exception page is not ported yet (F6.6).
// - The renderer decodes its own copy of the bundle (lib/render-wasm):
//   transit-js normalizes keywords and uuids to plain strings and the
//   compiled payload readers cannot look those up, so the shell and the
//   renderer fetch and decode separately for now (a recorded F6 debt).
// - The viewport sizes from the padded bounds the renderer reports
//   (calculate-size over gsb/get-object-bounds); the frame selrect stands
//   in until the first report.
// - The shortcut matcher (hooks/use-shortcuts ::viewer) re-binds when its
//   handlers change, where the CLJS binds once per group and its events
//   read the store; the wheel listener binds once while a frame renders.
// - The hotspot actions (F6.5) apply the shapes.cljs emissions here: a
//   navigate resolves the destination frame on the current page and falls
//   back to index 0 (go-to-frame's (or index 0)), prev-screen is
//   rt/nav-back-local behind the same-origin referrer guard, and open-url
//   opens a new tab (dom/open-new-window). The overlay actions drive the
//   open-overlay list (lib/viewer-overlays); the navigation events (prev /
//   next / thumbnail pick / navigate / go-to-section) clear the list like
//   the CLJS. go-to-page clears it too, where the CLJS leaves entries that
//   no longer resolve. preserve-scroll is a no-op because the section does
//   not scroll.
// - The WAAPI animations (f65f) follow the :viewer-animations map of
//   data/viewer.cljs: a navigation with an animation holds the frame being
//   left, and the origin viewport renders below the current one until the
//   rewind clears it. Both frames must have painted (their bounds arrive
//   from the blit viewports), where the CLJS starts from the decoded page
//   synchronously; a close overlay keeps its entry until the rewind
//   finishes, and a toggle close inverts the animation. A navigation whose
//   origin frame cannot resolve drops the pending entry instead of
//   dereferencing a missing viewport like the CLJS would.
// - Three registered shortcuts stay unbound (select-all, open-inspect,
//   open-comments) so their native browser keys keep working; see
//   lib/viewer-shortcuts.
// - toggle-theme persists through update-profile without the analytics
//   origin marker, like the dashboard provider.

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useNotifications } from "@/components/notifications";
import { QueryParams } from "@/components/query-params";
import { ViewerHeader, type SitemapPage } from "@/components/viewer-header";
import { ViewerOverlay } from "@/components/viewer-overlay";
import { ViewerPagination } from "@/components/viewer-pagination";
import { ViewerThumbnails } from "@/components/viewer-thumbnails";
import { ViewerWasmViewport, type ViewerWasmBounds } from "@/components/viewer-wasm-viewport";
import { dashboardHref, workspaceHref } from "@/lib/dashboard";
import { nextTheme } from "@/lib/dashboard-shortcuts-runtime";
import { useDocumentTitle } from "@/lib/dom";
import { tr } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { profileUpdateParams, updateProfile } from "@/lib/settings";
import { createShortcutMatcher, customShortcutsFromProfile, isMacos } from "@/lib/shortcuts";
import {
  animatePlans,
  findGoToFrame,
  planCloseOverlay,
  planGoToFrame,
  planOpenOverlay,
  type OverlayAnimationEntry,
  type ViewerAnimationEntry,
  type ViewerAnimations,
} from "@/lib/viewer-animations";
import {
  invertDirection,
  type OverlaySpec,
  type ViewerAction,
} from "@/lib/viewer-interactions";
import { closeOverlay, openOverlay } from "@/lib/viewer-overlays";
import {
  autoFrameIndex,
  buildViewerPages,
  canSelectNext,
  canSelectPrev,
  decreaseZoom,
  fetchViewerBundle,
  fillZoom,
  fitZoom,
  frameIndexById,
  increaseZoom,
  pageFlows,
  parseViewerQuery,
  resolveInteractionsMode,
  shouldUpdateZoomQuery,
  showInteractionsFor,
  viewerHref,
  viewerQueryToHrefParams,
  type InteractionsMode,
  type ViewerBundle,
  type ViewerFlow,
  type ViewerPage,
  type ViewerQueryParams,
  type ViewportSize,
} from "@/lib/viewer";
import { type ViewerShortcutActions } from "@/lib/viewer-shortcuts";
import {
  buildViewerBindings,
  dispatchViewerKeydown,
  isWheelZoomMod,
  viewerShortcutTarget,
  wheelZoomDirection,
} from "@/lib/viewer-shortcuts-runtime";

type ZoomType = "fit" | "fill";

// rt/nav: building the same URL again is skipped instead of pushing a
// duplicate history entry. The comparison ignores the parameter order.
function sameSearch(href: string): boolean {
  if (typeof window === "undefined") return false;
  const normalize = (search: string) => {
    const params = new URLSearchParams(search);
    return [...params.entries()]
      .map(([key, value]) => key + "=" + value)
      .sort()
      .join("&");
  };
  const current = window.location.search.replace(/^\?/, "");
  const next = href.split("?")[1] ?? "";
  return normalize(current) === normalize(next);
}

// loader* with overlay (ds/product/loader): the pen logo with the pencil
// line animating over it, while the bundle loads.
function ViewerLoader() {
  return (
    <div className="pp-viewer-loader">
      <div className="pp-loader-content">
        <svg
          viewBox="0 0 677.34762 182.15429"
          role="status"
          width={100}
          height={27}
          className="pp-loader"
        >
          <title>{tr("labels.loading")}</title>
          <g>
            <path d="M128.273 0l-3.9 2.77L0 91.078l128.273 91.076 549.075-.006V.008L128.273 0zm20.852 30l498.223.006V152.15l-498.223.007V30zm-25 9.74v102.678l-49.033-34.813-.578-32.64 49.61-35.225z" />
            <path
              className="pp-loader-line"
              d="M134.482 157.147v25l518.57.008.002-25-518.572-.008z"
            />
          </g>
        </svg>
      </div>
    </div>
  );
}

// The full-page message of the states that never reach the viewer layout
// (no file-id in the URL, a failed bundle fetch).
function ViewerMessage({ message }: { message: string }) {
  return (
    <div className="pp-viewer-message">
      <section className="pp-empty-state">
        <span>{message}</span>
      </section>
    </div>
  );
}

function ViewerRoute({ params }: { params: URLSearchParams }) {
  const query = parseViewerQuery(params);

  if (query.fileId === null) {
    return <ViewerMessage message={tr("errors.generic")} />;
  }

  // The key remounts the viewer-local state when the file changes.
  return <ViewerContent key={query.fileId} fileId={query.fileId} query={query} />;
}

function ViewerContent({ fileId, query }: { fileId: string; query: ViewerQueryParams }) {
  const router = useRouter();
  const { profile, refresh } = useSession();
  const notifications = useNotifications();

  const [data, setData] = useState<ViewerBundle | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [zoomType, setZoomType] = useState<ZoomType | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showThumbnails, setShowThumbnails] = useState(false);
  // The padded frame bounds the renderer reports; null until the first
  // report and after a frame change (see the reset effect below). The
  // wrapper sizes from them, with the selrect as the stand-in.
  const [wasmBounds, setWasmBounds] = useState<ViewerWasmBounds | null>(null);
  // dv/open-overlay / toggle-overlay / close-overlay: the open overlay
  // frames, in open order (the later entries stack above).
  const [overlays, setOverlays] = useState<OverlaySpec[]>([]);
  // :viewer-animations: the pending navigation / overlay WAAPI animations,
  // one per frame id (lib/viewer-animations).
  const [animations, setAnimations] = useState<ViewerAnimations>({});
  // The padded bounds of the origin viewport of a navigation animation; the
  // selrect stands in until its first report (see handleOrigBounds).
  const [origBounds, setOrigBounds] = useState<ViewerWasmBounds | null>(null);
  // ref:viewer-show-interactions: the hotspot highlight. dv/set-interactions-
  // mode mirrors the picked mode into it (:show keeps it on), and
  // dv/flash-interactions lights it for 500 ms from a window click while
  // the mode is show-on-click (flash-done turns it off).
  const [showInteractions, setShowInteractions] = useState(false);

  // The measured #viewer-section size: the zoom math input. A ref, not
  // state, because a resize only refreshes it (the recompute hangs off
  // zoom-type changes, like the CLJS set-viewport-size).
  const viewportSizeRef = useRef<ViewportSize | null>(null);
  // bundle-fetched normalizes once per file; a back-button visit of an
  // older URL must not be re-normalized. The mark doubles as the flows
  // menu gate: the menu reads the shown frame once, at mount.
  const [normalizedFileId, setNormalizedFileId] = useState<string | null>(null);

  // The containers the animations move (viewer-wrapper refs) and the open
  // overlay list as the action handlers see it (the CLJS handlers read the
  // store at event time).
  const currentViewportRef = useRef<HTMLDivElement | null>(null);
  const origViewportRef = useRef<HTMLDivElement | null>(null);
  const overlaysRef = useRef<OverlaySpec[]>(overlays);
  useEffect(() => {
    overlaysRef.current = overlays;
  });
  // The entries already playing, so a bounds or overlay change does not
  // restart a run in flight.
  const startedGoToFrameRef = useRef<ViewerAnimationEntry | null>(null);
  const startedOverlaysRef = useRef(new Set<OverlayAnimationEntry>());
  // The flash-interactions timer: a new flash restarts the 500 ms run
  // (the CLJS take-until over the flash stream); only a new flash cancels
  // it, so a mode change leaves a pending flash alone, like the original.
  const flashTimerRef = useRef<number | null>(null);

  // check-platform? :macos resolves after mount so the server render stays
  // stable, like the dashboard provider.
  const [macos, setMacos] = useState(false);
  useEffect(() => {
    setMacos(isMacos());
  }, []);

  const customShortcuts = useMemo(() => customShortcutsFromProfile(profile), [profile]);

  const shareId = query.shareId;

  // fetch-bundle of initialize: the view-only bundle for the file.
  useEffect(() => {
    let live = true;
    setData(null);
    setLoadError(false);
    fetchViewerBundle({ fileId, shareId })
      .then((bundle) => {
        if (live) setData(bundle);
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [fileId, shareId]);

  // initialize sets the window name for inter-tab navigation: opening the
  // same file again focuses the existing tab.
  useEffect(() => {
    window.name = "viewer-" + fileId;
  }, [fileId]);

  const pages = useMemo<Record<string, ViewerPage>>(() => {
    if (data === null) return {};
    return buildViewerPages(data.file);
  }, [data]);

  const pageList = useMemo<SitemapPage[]>(() => {
    if (data === null) return [];
    const ids = data.file.data.pages ?? [];
    return ids.map((id) => ({ id, name: pages[id]?.name ?? "" }));
  }, [data, pages]);

  // (or page-id (-> file :data :pages first)): the display-only fallback.
  const pageId = query.pageId ?? pageList[0]?.id ?? null;
  const page: ViewerPage | undefined = pageId !== null ? pages[pageId] : undefined;

  const frames = useMemo(() => page?.frames ?? [], [page]);
  // The flows of the page for the flows menu of the header.
  const flows = useMemo(() => (page !== undefined ? pageFlows(page) : []), [page]);
  // The menu mounts only once the normalization has landed (the CLJS
  // (when index ...) gate): its current-flow state reads the shown frame
  // exactly once, and the pre-normalization index can point elsewhere.
  const menuFlows = normalizedFileId === fileId ? flows : [];
  // The interactions menu entry: the URL parameter picks it, an invalid or
  // absent value falls back to the default (resolveInteractionsMode).
  const interactionsMode: InteractionsMode = resolveInteractionsMode(query.interactionsMode);
  // refs/viewer-overlays as the viewport math consumes it (the frame ids).
  const overlaysIds = useMemo(() => overlays.map((overlay) => overlay.frameId), [overlays]);
  const displayIndex = query.index ?? (page !== undefined ? autoFrameIndex(page) : 0);
  const frame = displayIndex >= 0 && displayIndex < frames.length ? frames[displayIndex] : undefined;

  // The navigation animation in flight and the frame it left: the origin
  // viewport renders below the current one while the entry is pending
  // (viewer.cljs orig-frame).
  const goToFrame = findGoToFrame(animations);
  const origFrame =
    goToFrame !== null ? frames.find((f) => f.id === goToFrame.origFrameId) : undefined;

  // The padded bounds the blit viewports report, zoomed; the selrects stand
  // in until the first report. The wrapper reserves the larger of the two
  // during a navigation (calculate-wrapper).
  const frameWidth = (wasmBounds?.baseWidth ?? frame?.selrect?.width ?? 0) * zoom;
  const frameHeight = (wasmBounds?.baseHeight ?? frame?.selrect?.height ?? 0) * zoom;
  const origWidth = (origBounds?.baseWidth ?? origFrame?.selrect?.width ?? 0) * zoom;
  const origHeight = (origBounds?.baseHeight ?? origFrame?.selrect?.height ?? 0) * zoom;
  const wrapperWidth = origFrame !== undefined ? Math.max(frameWidth, origWidth) : frameWidth;
  const wrapperHeight = origFrame !== undefined ? Math.max(frameHeight, origHeight) : frameHeight;

  // Drop the reported bounds when the frame changes: they describe the
  // previous frame, and the wrapper would size from stale numbers while
  // the next one decodes.
  useEffect(() => {
    setWasmBounds(null);
  }, [frame?.id]);

  // Same for the origin bounds of a navigation animation.
  useEffect(() => {
    setOrigBounds(null);
  }, [origFrame?.id]);

  const permissions = (data?.permissions ?? {}) as Record<string, unknown>;
  const inTeam = permissions["in-team"] === true;

  useDocumentTitle(data === null ? "" : "\u25b6 " + tr("title.viewer", data.file.name));

  // bundle-fetched: pick the frame from frame-id / index / the first flow
  // and mirror it into the URL. The href rebuilds the full param set, so
  // frame-id stays until a navigation drops it, like the CLJS assoc. The
  // file is marked normalized only from a render whose query carries the
  // resolved index: the flows menu mounts on that mark, so its one-shot
  // current-flow state never reads a pre-normalization frame.
  useEffect(() => {
    if (data === null || normalizedFileId === fileId) return;

    const base = viewerQueryToHrefParams(query);
    if (base !== null) {
      let targetIndex: number;
      if (query.frameId !== null) {
        targetIndex = frameIndexById(frames, query.frameId);
      } else if (query.index !== null) {
        targetIndex = query.index;
      } else {
        targetIndex = page !== undefined ? autoFrameIndex(page) : 0;
      }
      if (query.index !== targetIndex) {
        const href = viewerHref({ ...base, index: targetIndex });
        if (!sameSearch(href)) {
          router.replace(href);
          return;
        }
      }
    }

    setNormalizedFileId(fileId);
  }, [data, fileId, query, frames, page, router, normalizedFileId]);

  // viewer-content*: a section that is not allowed (the shell renders only
  // interactions) falls back to interactions.
  useEffect(() => {
    if (query.section === null || query.section === "interactions") return;
    const base = viewerQueryToHrefParams(query);
    if (base === null) return;
    const href = viewerHref({ ...base, section: "interactions" });
    if (sameSearch(href)) return;
    router.replace(href);
  }, [query, router]);

  // set-up-new-size: measure the viewer section once it is mounted and on
  // every window resize.
  useEffect(() => {
    if (data === null) return;
    const measure = () => {
      const element = document.getElementById("viewer-section");
      if (element === null) return;
      viewportSizeRef.current = { width: element.clientWidth, height: element.clientHeight };
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [data]);

  // The URL seeds the zoom style; fit / fill survive a reload.
  useEffect(() => {
    setZoomType(query.zoom === "fit" || query.zoom === "fill" ? query.zoom : null);
  }, [query.zoom]);

  const computeZoom = useCallback(
    (type: ZoomType): number | null => {
      const viewport = viewportSizeRef.current;
      const rect =
        displayIndex >= 0 && displayIndex < frames.length ? frames[displayIndex]?.selrect : undefined;
      if (viewport === null || rect === undefined) return null;
      return type === "fit" ? fitZoom(viewport, rect) : fillZoom(viewport, rect);
    },
    [frames, displayIndex],
  );

  // zoom-to-fit / zoom-to-fill recompute on every zoom-type and frame
  // change, against the current viewport (the measurement effect above
  // runs first on the same commit).
  useEffect(() => {
    if (zoomType === null) return;
    const next = computeZoom(zoomType);
    if (next === null) return;
    setZoom(next);
  }, [zoomType, computeZoom]);

  // update-zoom-querystring: fit / fill mirror into the URL (a replace);
  // the manual steps (reset, +, -) drop the style and leave the URL alone.
  useEffect(() => {
    if (data === null || zoomType === null) return;
    if (!shouldUpdateZoomQuery(query.zoom, zoomType)) return;
    const base = viewerQueryToHrefParams(query);
    if (base === null) return;
    const href = viewerHref({ ...base, zoom: zoomType });
    if (sameSearch(href)) return;
    router.replace(href);
  }, [data, zoomType, query, router]);

  // toggle-fullscreen: DOM fullscreen follows the local flag; entering
  // clears the forced visibility first, like the CLJS layout effect.
  useEffect(() => {
    const element = document.getElementById("viewer-layout");
    if (element === null) return;
    const domFullscreen = document.fullscreenElement !== null;
    if (fullscreen === domFullscreen) return;
    if (fullscreen) {
      element.setAttribute("data-force-visible", "false");
      void element.requestFullscreen().catch(() => undefined);
    } else {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, [fullscreen]);

  // on-exit-fullscreen: Esc leaves DOM fullscreen directly; mirror it back.
  useEffect(() => {
    const onFullscreenChange = () => {
      if (document.fullscreenElement === null) setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    };
  }, []);

  const navigate = useCallback(
    (href: string) => {
      if (sameSearch(href)) return;
      router.push(href);
    },
    [router],
  );

  // select-prev-frame / select-next-frame / select-first-frame: the
  // navigation rebuilds the full param set (frame-id included, like the
  // CLJS assoc) and the bounds guard the neighbours. The prev / next events
  // also drop the pending animations and overlays; select-first-frame
  // leaves both alone, like the CLJS. The callbacks feed the shortcut
  // matcher below, so they carry their state as dependencies.
  const handlePrev = useCallback(() => {
    if (!canSelectPrev(displayIndex)) return;
    setOverlays([]);
    setAnimations({});
    const base = viewerQueryToHrefParams(query);
    if (base === null) return;
    navigate(viewerHref({ ...base, index: displayIndex - 1 }));
  }, [displayIndex, query, navigate]);

  const handleNext = useCallback(() => {
    if (!canSelectNext(displayIndex, frames.length)) return;
    setOverlays([]);
    setAnimations({});
    const base = viewerQueryToHrefParams(query);
    if (base === null) return;
    navigate(viewerHref({ ...base, index: displayIndex + 1 }));
  }, [displayIndex, frames.length, query, navigate]);

  const handleFirst = () => {
    const base = viewerQueryToHrefParams(query);
    if (base === null) return;
    navigate(viewerHref({ ...base, index: 0 }));
  };

  // go-to-page: index 0 on the target page. The open overlays belong to
  // the leaving page and drop (a deviation: the CLJS leaves the entries,
  // which then resolve to nothing).
  const handleGoToPage = (id: string) => {
    setOverlays([]);
    const base = viewerQueryToHrefParams(query);
    if (base === null) return;
    navigate(viewerHref({ ...base, pageId: id, index: 0 }));
  };

  const handleGoToInteractions = useCallback(() => {
    setOverlays([]);
    const base = viewerQueryToHrefParams(query);
    if (base === null) return;
    navigate(viewerHref({ ...base, section: "interactions" }));
  }, [query, navigate]);

  // The flows menu pick: dv/go-to-frame (:starting-frame flow), which
  // clears the open overlays and resolves the index with the (or index 0)
  // fallback (frameIndexById lands on 0 for a frame that is not on the
  // page).
  const handleSelectFlow = useCallback(
    (flow: ViewerFlow) => {
      const base = viewerQueryToHrefParams(query);
      if (base === null) return;
      setOverlays([]);
      navigate(viewerHref({ ...base, index: frameIndexById(frames, flow["starting-frame"]) }));
    },
    [query, frames, navigate],
  );

  // dv/flash-interactions: a window click in the show-on-click mode lights
  // the hotspots for 500 ms. A click on a hotspot still reaches the
  // listener: the shapes.cljs handlers stop the pointer events only, and
  // the browser dispatches the click separately.
  const flashInteractions = useCallback(() => {
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    setShowInteractions(true);
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      setShowInteractions(false);
    }, 500);
  }, []);

  useEffect(() => {
    if (interactionsMode !== "show-on-click") return;
    const onClick = () => flashInteractions();
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [interactionsMode, flashInteractions]);

  // Leaving the viewer drops a pending flash with it.
  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  // The interactions menu pick: dv/set-interactions-mode mirrors the mode
  // into the URL (a push, like the CLJS rt/nav) and sets the hotspot
  // highlight through showInteractionsFor (:show keeps it on, the others
  // clear it). The menu entry derives from the parameter, so it follows.
  const handleSelectInteractionsMode = useCallback(
    (mode: InteractionsMode) => {
      const base = viewerQueryToHrefParams(query);
      if (base === null) return;
      setShowInteractions(showInteractionsFor(mode));
      navigate(viewerHref({ ...base, interactionsMode: mode }));
    },
    [query, navigate],
  );

  // go-to-dashboard / go-to-workspace.
  const handleGoToDashboard = () => {
    if (data === null) return;
    router.push(dashboardHref("dashboard-recent", { teamId: data.project["team-id"] }));
  };

  const handleGoToWorkspace = useCallback(() => {
    if (data === null) return;
    window.open(
      workspaceHref({
        teamId: data.project["team-id"],
        fileId: data.file.id,
        pageId: page?.id ?? null,
      }),
      "workspace-" + data.file.id,
    );
  }, [data, page]);

  // increase-zoom / decrease-zoom / reset-zoom drop the zoom style without
  // touching the URL, like the CLJS events.
  const handleIncreaseZoom = useCallback(() => {
    setZoomType(null);
    setZoom((value) => increaseZoom(value));
  }, []);

  const handleDecreaseZoom = useCallback(() => {
    setZoomType(null);
    setZoom((value) => decreaseZoom(value));
  }, []);

  const handleResetZoom = useCallback(() => {
    setZoomType(null);
    setZoom(1);
  }, []);

  const handleZoomType = useCallback(
    (type: ZoomType) => {
      setZoomType(type);
      const next = computeZoom(type);
      if (next !== null) setZoom(next);
    },
    [computeZoom],
  );

  const toggleFullscreen = useCallback(() => {
    setFullscreen((value) => !value);
  }, []);

  const toggleThumbnails = () => {
    setShowThumbnails((value) => !value);
  };

  const closeThumbnails = () => {
    if (showThumbnails) setShowThumbnails(false);
  };

  // The renderer reports the frame's padded bounds once the bundle is
  // decoded; it also reports null when a render fails.
  const handleWasmBounds = useCallback((bounds: ViewerWasmBounds | null) => {
    setWasmBounds(bounds);
  }, []);

  const handleOrigBounds = useCallback((bounds: ViewerWasmBounds | null) => {
    setOrigBounds(bounds);
  }, []);

  // The go-to-frame animation (the viewer.cljs effect): started once both
  // the current and the origin viewports have reported bounds (both frames
  // painted), then the plans move the containers; the finish clears the
  // entry (dv/complete-animation).
  useEffect(() => {
    if (goToFrame === null) {
      startedGoToFrameRef.current = null;
      return;
    }
    if (startedGoToFrameRef.current === goToFrame) return;
    if (origFrame === undefined) {
      // The origin frame left the page (a cross-page jump mid-animation);
      // drop the entry instead of dereferencing a missing viewport.
      setAnimations({});
      return;
    }
    if (wasmBounds === null || origBounds === null) return;
    const currentViewport = currentViewportRef.current;
    const origViewport = origViewportRef.current;
    if (currentViewport === null || origViewport === null) return;
    startedGoToFrameRef.current = goToFrame;
    const currentSize = {
      width: wasmBounds.baseWidth * zoom,
      height: wasmBounds.baseHeight * zoom,
    };
    const origSize = {
      width: origBounds.baseWidth * zoom,
      height: origBounds.baseHeight * zoom,
    };
    const wrapperSize = {
      width: Math.max(currentSize.width, origSize.width),
      height: Math.max(currentSize.height, origSize.height),
    };
    const plans = planGoToFrame(goToFrame.animation, currentSize, origSize, wrapperSize);
    animatePlans({ current: currentViewport, orig: origViewport }, plans, () =>
      setAnimations({}),
    );
  }, [goToFrame, origFrame, wasmBounds, origBounds, zoom]);

  // The overlay animations (the viewer.cljs effect): every pending open /
  // close-overlay entry animates its rendered container; a finished close
  // also drops the overlay (data/viewer.cljs close-overlay*). The entries
  // already playing keep running across overlay / zoom changes.
  useEffect(() => {
    const pending = Object.values(animations).filter((entry) => entry.kind !== "go-to-frame");
    for (const started of [...startedOverlaysRef.current]) {
      if (!pending.includes(started)) startedOverlaysRef.current.delete(started);
    }
    for (const entry of pending) {
      if (startedOverlaysRef.current.has(entry)) continue;
      const element = document.getElementById("overlay-" + entry.overlayFrameId);
      if (element === null) continue;
      const overlay = overlaysRef.current.find((o) => o.frameId === entry.overlayFrameId);
      if (overlay === undefined) continue;
      startedOverlaysRef.current.add(entry);
      // The overlay size is measured on the rendered container (its
      // reported padded bounds, or the selrect stand-in).
      const rect = element.getBoundingClientRect();
      const overlaySize = { width: rect.width, height: rect.height };
      const overlayPosition = {
        x: overlay.position.x * zoom,
        y: overlay.position.y * zoom,
      };
      const wrapperSize = { width: wrapperWidth, height: wrapperHeight };
      const plans =
        entry.kind === "open-overlay"
          ? planOpenOverlay(entry.animation, overlaySize, overlayPosition, wrapperSize)
          : planCloseOverlay(entry.animation, overlaySize, overlayPosition, wrapperSize);
      const overlayFrameId = entry.overlayFrameId;
      animatePlans({ overlay: element }, plans, () => {
        setAnimations({});
        if (entry.kind === "close-overlay") {
          setOverlays((current) => closeOverlay(current, overlayFrameId));
        }
      });
    }
  }, [animations, zoom, wrapperWidth, wrapperHeight]);

  // click-on-screen: a click on the section itself toggles the forced
  // visibility of the controls. The attribute is flipped imperatively, so
  // it survives until the show-thumbnails state writes the attribute again
  // (the same transient behaviour as the CLJS dom/set-data!).
  const onClickScreen = (event: MouseEvent<HTMLElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target === null || target.dataset.viewerSection === undefined) return;
    const layout = document.getElementById("viewer-layout");
    if (layout === null) return;
    layout.dataset.forceVisible = layout.dataset.forceVisible === "true" ? "false" : "true";
  };

  // go-to-frame-by-index: the thumbnails panel picks a frame; the full
  // param set is rebuilt and sameSearch guards the no-op.
  const handleSelectIndex = useCallback(
    (targetIndex: number) => {
      setOverlays([]);
      const base = viewerQueryToHrefParams(query);
      if (base === null) return;
      navigate(viewerHref({ ...base, index: targetIndex }));
    },
    [query, navigate],
  );

  // The hotspot actions of the wasm viewport (the st/emit! calls of
  // shapes.cljs activate-interaction / deactivate-interaction). The
  // overlay branches drive the open list (dv/open-overlay and friends via
  // lib/viewer-overlays); with an animation the entry records the WAAPI
  // rewind (data/viewer.cljs): a close defers its removal to the finished
  // animation and a toggle close inverts the animation. The prev-screen
  // guard mirrors rt/nav-back-local: only a same-origin (or absent)
  // referrer allows history.back(). The open-url window matches
  // dom/open-new-window's default "_blank" + noopener,noreferrer.
  const handleViewerAction = useCallback(
    (action: ViewerAction) => {
      switch (action.kind) {
        case "navigate": {
          const base = viewerQueryToHrefParams(query);
          if (base === null) return;
          const index = frameIndexById(frames, action.frameId);
          setOverlays([]);
          // go-to-frame keys the entry by the frame being left, the index
          // of the query before the navigation (data/viewer.cljs).
          if (action.animation !== undefined && frame !== undefined) {
            const animation = action.animation;
            const origFrameId = frame.id;
            setAnimations((current) => ({
              ...current,
              [origFrameId]: { kind: "go-to-frame", origFrameId, animation },
            }));
          }
          navigate(viewerHref({ ...base, index: index >= 0 ? index : 0 }));
          return;
        }
        case "open-overlay": {
          // The functional update keeps every action of one pointer event
          // (a shape can carry several interactions); the ref only decides
          // whether an animation is worth recording (an already open frame
          // is a no-op in the CLJS).
          const overlay = action.overlay;
          setOverlays((current) => openOverlay(current, overlay));
          if (
            overlay.animation !== undefined &&
            !overlaysRef.current.some((o) => o.frameId === overlay.frameId)
          ) {
            const animation = overlay.animation;
            const overlayFrameId = overlay.frameId;
            setAnimations((current) => ({
              ...current,
              [overlayFrameId]: { kind: "open-overlay", overlayFrameId, animation },
            }));
          }
          return;
        }
        case "toggle-overlay": {
          const overlay = action.overlay;
          const wasOpen = overlaysRef.current.some((o) => o.frameId === overlay.frameId);
          if (!wasOpen) {
            setOverlays((current) => openOverlay(current, overlay));
            if (overlay.animation !== undefined) {
              const animation = overlay.animation;
              const overlayFrameId = overlay.frameId;
              setAnimations((current) => ({
                ...current,
                [overlayFrameId]: { kind: "open-overlay", overlayFrameId, animation },
              }));
            }
          } else {
            // The toggle close inverts the animation of the interaction
            // (the rewind of the open); without one the overlay drops at
            // once (data/viewer.cljs toggle-overlay).
            const inverted = invertDirection(overlay.animation);
            if (inverted === undefined) {
              setOverlays((current) => closeOverlay(current, overlay.frameId));
            } else {
              const animation = inverted;
              const overlayFrameId = overlay.frameId;
              setAnimations((current) => ({
                ...current,
                [overlayFrameId]: { kind: "close-overlay", overlayFrameId, animation },
              }));
            }
          }
          return;
        }
        case "close-overlay": {
          // An animated close holds the overlay until the rewind finishes
          // (data/viewer.cljs close-overlay*); without one the removal is
          // immediate.
          if (action.animation !== undefined) {
            const animation = action.animation;
            const overlayFrameId = action.frameId;
            setAnimations((current) => ({
              ...current,
              [overlayFrameId]: { kind: "close-overlay", overlayFrameId, animation },
            }));
          } else {
            setOverlays((current) => closeOverlay(current, action.frameId));
          }
          return;
        }
        case "prev-screen": {
          const referrer = document.referrer;
          let sameOrigin = true;
          if (referrer !== "") {
            try {
              sameOrigin = new URL(referrer).host === window.location.host;
            } catch {
              sameOrigin = false;
            }
          }
          if (sameOrigin) router.back();
          return;
        }
        case "open-url": {
          window.open(action.url, "_blank", "noopener,noreferrer");
          return;
        }
        default:
          return;
      }
    },
    [query, frames, frame, navigate, router],
  );

  // toggle-zoom-style: fit -> fill, anything else -> fit.
  const handleToggleZoomStyle = useCallback(() => {
    handleZoomType(zoomType === "fit" ? "fill" : "fit");
  }, [zoomType, handleZoomType]);

  // du/toggle-theme through update-profile, like the dashboard provider.
  const handleToggleTheme = useCallback(() => {
    const next = nextTheme(profile?.theme);
    void updateProfile(profileUpdateParams({ fullname: profile?.fullname ?? "", theme: next }))
      .then(() => refresh())
      .catch(() => notifications.error(tr("generic.error")));
  }, [profile, refresh, notifications]);

  // hooks/use-shortcuts ::viewer behind a keydown matcher, active once the
  // bundle is loaded (viewer-content*). The actions memo carries the
  // handlers above, which are callbacks, so the matcher only re-binds when
  // one of them changes.
  const ready = data !== null;
  const shortcutActions = useMemo<ViewerShortcutActions>(
    () => ({
      increaseZoom: handleIncreaseZoom,
      decreaseZoom: handleDecreaseZoom,
      resetZoom: handleResetZoom,
      toggleZoomStyle: handleToggleZoomStyle,
      toggleFullscreen,
      prevFrame: handlePrev,
      nextFrame: handleNext,
      toggleTheme: handleToggleTheme,
      goToInteractions: handleGoToInteractions,
      goToWorkspace: handleGoToWorkspace,
    }),
    [
      handleIncreaseZoom,
      handleDecreaseZoom,
      handleResetZoom,
      handleToggleZoomStyle,
      toggleFullscreen,
      handlePrev,
      handleNext,
      handleToggleTheme,
      handleGoToInteractions,
      handleGoToWorkspace,
    ],
  );

  useEffect(() => {
    if (!ready) return;
    const matcher = createShortcutMatcher(
      buildViewerBindings(macos, customShortcuts, shortcutActions),
    );
    const onKeyDown = (event: KeyboardEvent) => {
      const fired = dispatchViewerKeydown(matcher, event, macos, viewerShortcutTarget(event));
      if (fired) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      matcher.dispose();
    };
  }, [ready, macos, customShortcuts, shortcutActions]);

  // interactions.cljs viewport* on-mouse-wheel: a window-level listener
  // while a frame renders; mod+wheel zooms and cancels the browser gesture
  // (passive:false).
  const viewportActive = ready && frame !== undefined;
  useEffect(() => {
    if (!viewportActive) return;
    const onWheel = (event: WheelEvent) => {
      if (!isWheelZoomMod(macos, event)) return;
      event.preventDefault();
      if (wheelZoomDirection(event.deltaY, event.deltaX) === "decrease") {
        handleDecreaseZoom();
      } else {
        handleIncreaseZoom();
      }
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [viewportActive, macos, handleDecreaseZoom, handleIncreaseZoom]);

  if (data === null) {
    return loadError ? <ViewerMessage message={tr("errors.generic")} /> : <ViewerLoader />;
  }

  let content: ReactNode;
  if (page === undefined || frames.length === 0) {
    content = (
      <section className="pp-empty-state">
        <span>{tr("viewer.empty-state")}</span>
      </section>
    );
  } else if (frame === undefined) {
    content = (
      <section className="pp-empty-state">
        {query.index !== null ? <span>{tr("viewer.frame-not-found")}</span> : null}
      </section>
    );
  } else {
    content = (
      <>
        <ViewerPagination
          index={displayIndex}
          numFrames={frames.length}
          onPrev={handlePrev}
          onNext={handleNext}
          onFirst={handleFirst}
        />
        <div className="pp-viewer-wrapper" style={{ width: wrapperWidth, height: wrapperHeight }}>
          <div className="pp-viewer-clipper">
            {origFrame !== undefined ? (
              // The origin viewport of a navigation animation: the frame
              // being left, below the current one (viewer-wrapper).
              <div
                className="pp-viewport-container"
                ref={origViewportRef}
                style={{ width: origWidth, height: origHeight, position: "relative" }}
              >
                <ViewerWasmViewport
                  fileId={fileId}
                  shareId={shareId}
                  pageId={page.id}
                  frameId={origFrame.id}
                  frameName={origFrame.name ?? ""}
                  zoom={zoom}
                  onBounds={handleOrigBounds}
                  showInteractions={showInteractions}
                  overlaysIds={overlaysIds}
                  onAction={handleViewerAction}
                />
              </div>
            ) : null}
            <div
              className="pp-viewport-container"
              ref={currentViewportRef}
              style={{ width: frameWidth, height: frameHeight, position: "relative" }}
            >
              <ViewerWasmViewport
                fileId={fileId}
                shareId={shareId}
                pageId={page.id}
                frameId={frame.id}
                frameName={frame.name ?? ""}
                zoom={zoom}
                onBounds={handleWasmBounds}
                showInteractions={showInteractions}
                overlaysIds={overlaysIds}
                onAction={handleViewerAction}
              />
              {overlays.map((overlay) => {
                const overlayFrame = page.allFrames.find((f) => f.id === overlay.frameId);
                if (overlayFrame === undefined) return null;
                return (
                  <ViewerOverlay
                    key={overlay.frameId}
                    overlay={overlay}
                    fileId={fileId}
                    shareId={shareId}
                    pageId={page.id}
                    baseFrameId={frame.id}
                    frameName={overlayFrame.name ?? ""}
                    frameSelrect={overlayFrame.selrect}
                    zoom={zoom}
                    wrapperWidth={frameWidth}
                    wrapperHeight={frameHeight}
                    showInteractions={showInteractions}
                    overlaysIds={overlaysIds}
                    onAction={handleViewerAction}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <div
      id="viewer-layout"
      className={showThumbnails ? "pp-viewer-layout pp-force-visible" : "pp-viewer-layout"}
      data-fullscreen={fullscreen}
      data-force-visible={showThumbnails}
    >
      <div className="pp-viewer-content">
        <button
          type="button"
          className={showThumbnails ? "pp-thumbnails-close" : "pp-thumbnails-close pp-invisible"}
          onClick={closeThumbnails}
        />
        {/* The panel stays mounted and hides itself, like the CLJS. */}
        {/* pageId: a bitmap implies a frame, so the empty fallback never
            renders one (see ThumbnailBitmap). */}
        <ViewerThumbnails
          frames={frames}
          index={displayIndex}
          show={showThumbnails}
          onSelect={handleSelectIndex}
          onClose={closeThumbnails}
          fileId={fileId}
          shareId={shareId}
          pageId={page?.id ?? ""}
        />
        <section
          id="viewer-section"
          data-viewer-section="true"
          className="pp-viewer-section"
          onClick={onClickScreen}
        >
          {content}
        </section>
      </div>
      <ViewerHeader
        projectName={data.project.name}
        fileName={data.file.name}
        pageName={page?.name}
        pageId={pageId}
        pages={pageList}
        frameName={frame?.name}
        flows={menuFlows}
        frameId={frame?.id ?? null}
        interactionsMode={interactionsMode}
        zoom={zoom}
        fullscreen={fullscreen}
        inTeam={inTeam}
        onGoToDashboard={handleGoToDashboard}
        onGoToWorkspace={handleGoToWorkspace}
        onGoToInteractions={handleGoToInteractions}
        onGoToPage={handleGoToPage}
        onSelectFlow={handleSelectFlow}
        onSelectInteractionsMode={handleSelectInteractionsMode}
        onToggleThumbnails={toggleThumbnails}
        onCloseThumbnails={closeThumbnails}
        onIncreaseZoom={handleIncreaseZoom}
        onDecreaseZoom={handleDecreaseZoom}
        onResetZoom={handleResetZoom}
        onZoomFit={() => handleZoomType("fit")}
        onZoomFill={() => handleZoomType("fill")}
        onToggleFullscreen={toggleFullscreen}
      />
    </div>
  );
}

export default function Page() {
  return (
    <QueryParams fallback={<ViewerLoader />}>
      {(params) => <ViewerRoute params={params} />}
    </QueryParams>
  );
}
