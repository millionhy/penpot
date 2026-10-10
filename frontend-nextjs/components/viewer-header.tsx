"use client";

// Header of app.main.ui.viewer (F6.2): the sitemap nav zone, the section
// button and the options zone (zoom widget, edit link, fullscreen). Not
// migrated yet: the progress widget, the share button and the login link,
// the comments/inspect mode buttons and their menus, and the flows /
// interactions menus of header-options (F6.5).
//
// The dropdown is ported from app.main.ui.components.dropdown. The CLJS
// relies on stop-propagation to keep the open dropdown from closing on a
// click of its own trigger; the App Router attaches React's delegated
// listener to the document node itself, where stop-propagation cannot hide
// an event from a sibling document listener. The zoom widget therefore
// passes its node as the dropdown container (a click inside keeps it open,
// like the CLJS container check) and closes on the document / contextmenu /
// Escape listeners; the sitemap dropdown keeps the any-click close.

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  AddIcon,
  ArrowIcon,
  CurveIcon,
  ExpandIcon,
  PenpotLogoIcon,
  PlayIcon,
  RemoveIcon,
  TickIcon,
} from "@/components/viewer-icons";
import { tr } from "@/lib/i18n";
import { isMacos, macShift, splitSc } from "@/lib/shortcuts";
import { formatPercent } from "@/lib/viewer";

interface DropdownProps {
  show: boolean;
  onClose: () => void;
  // The CLJS container ref: clicks inside it do not close the dropdown.
  container?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

// dropdown: renders nothing while hidden, so the document listeners below
// only exist while a dropdown is open.
function Dropdown({ show, onClose, container, children }: DropdownProps) {
  if (!show) return null;
  return (
    <DropdownContent onClose={onClose} container={container}>
      {children}
    </DropdownContent>
  );
}

// dropdown-content*: the document listeners and the 0ms arming timer
// (tm/schedule with its default delay) that keeps the opening click from
// closing the dropdown again.
function DropdownContent({ onClose, container, children }: Omit<DropdownProps, "show">) {
  const listeningRef = useRef(false);
  const onCloseRef = useRef(onClose);

  // The listeners are attached once; the ref carries the latest handler.
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      if (!listeningRef.current) return;
      // MacOS ctrl+click sends two events: context-menu and click. Ignore
      // its ctrl key to handle the pair once.
      if (isMacos() && event.ctrlKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target !== null && (target as HTMLElement).dataset.noClose !== undefined) return;
      const parent = container?.current ?? null;
      if (parent !== null && parent.contains(target)) return;
      onCloseRef.current();
    };

    const onDocumentKeyup = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };

    document.addEventListener("click", onDocumentClick);
    document.addEventListener("contextmenu", onDocumentClick);
    document.addEventListener("keyup", onDocumentKeyup);
    const timer = window.setTimeout(() => {
      listeningRef.current = true;
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("contextmenu", onDocumentClick);
      document.removeEventListener("keyup", onDocumentKeyup);
    };
  }, [container]);

  return <>{children}</>;
}

interface ZoomWidgetProps {
  zoom: number;
  onIncrease: () => void;
  onDecrease: () => void;
  onZoomReset: () => void;
  onZoomFit: () => void;
  onZoomFill: () => void;
  onToggleFullscreen: () => void;
}

// zoom-widget: the zoom percentage and its dropdown (step buttons, reset,
// fit / fill / fullscreen with their shortcut keys).
function ZoomWidget({
  zoom,
  onIncrease,
  onDecrease,
  onZoomReset,
  onZoomFit,
  onZoomFill,
  onToggleFullscreen,
}: ZoomWidgetProps) {
  const [open, setOpen] = useState(false);
  const widgetRef = useRef<HTMLDivElement>(null);
  const [macos, setMacos] = useState(false);

  // check-platform? :macos is a navigator read; resolve it after mount so
  // the server render stays stable.
  useEffect(() => {
    setMacos(isMacos());
  }, []);

  // sc/get-tooltip :toggle-fullscreen, split into key caps (Shift+F / ⇧F).
  const fullscreenKeys = splitSc((macos ? macShift : "Shift+") + "F");

  return (
    <div
      ref={widgetRef}
      className={open ? "pp-zoom-widget pp-selected" : "pp-zoom-widget"}
      onClick={(event) => {
        event.stopPropagation();
        setOpen(true);
      }}
      title={tr("workspace.header.zoom")}
    >
      <span className="pp-label">{formatPercent(zoom)}</span>
      <Dropdown show={open} onClose={() => setOpen(false)} container={widgetRef}>
        <ul className="pp-dropdown">
          <li className="pp-basic-zoom-bar">
            <span className="pp-zoom-btns">
              <button
                type="button"
                className="pp-zoom-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  onDecrease();
                }}
              >
                <span className="pp-zoom-icon">
                  <RemoveIcon />
                </span>
              </button>
              <p className="pp-zoom-text">{formatPercent(zoom)}</p>
              <button
                type="button"
                className="pp-zoom-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  onIncrease();
                }}
              >
                <span className="pp-zoom-icon">
                  <AddIcon />
                </span>
              </button>
            </span>
            <button type="button" className="pp-reset-btn" onClick={onZoomReset}>
              {tr("workspace.header.reset-zoom")}
            </button>
          </li>
          <li className="pp-zoom-option" onClick={onZoomFit}>
            {tr("workspace.header.zoom-fit")}
            <span className="pp-shortcuts">
              {splitSc("F").map((sc) => (
                <span className="pp-shortcut-key" key={"zoom-fit-" + sc}>
                  {sc}
                </span>
              ))}
            </span>
          </li>
          <li className="pp-zoom-option" onClick={onZoomFill}>
            {tr("workspace.header.zoom-fill")}
            <span className="pp-shortcuts">
              {splitSc("F").map((sc) => (
                <span className="pp-shortcut-key" key={"zoom-fill-" + sc}>
                  {sc}
                </span>
              ))}
            </span>
          </li>
          <li className="pp-zoom-option" onClick={onToggleFullscreen}>
            {tr("workspace.header.zoom-full-screen")}
            <span className="pp-shortcuts">
              {fullscreenKeys.map((sc) => (
                <span className="pp-shortcut-key" key={"zoom-fullscreen-" + sc}>
                  {sc}
                </span>
              ))}
            </span>
          </li>
        </ul>
      </Dropdown>
    </div>
  );
}

export interface SitemapPage {
  id: string;
  name: string;
}

interface SitemapZoneProps {
  projectName: string;
  fileName: string;
  pageName?: string;
  pageId: string | null;
  pages: SitemapPage[];
  frameName?: string;
  onGoToPage: (pageId: string) => void;
  onToggleThumbnails: () => void;
}

// header-sitemap: the project name, the file / page breadcrumb with the
// page dropdown and the current frame (opens the thumbnails panel).
function SitemapZone({
  projectName,
  fileName,
  pageName,
  pageId,
  pages,
  frameName,
  onGoToPage,
  onToggleThumbnails,
}: SitemapZoneProps) {
  const [open, setOpen] = useState(false);

  const navigateTo = (id: string) => {
    onGoToPage(id);
    setOpen(false);
  };

  return (
    <div className="pp-sitemap-zone" title={tr("viewer.header.sitemap")}>
      <span className="pp-project-name">{projectName}</span>
      <div className="pp-sitemap-text">
        <div className="pp-breadcrumb" onClick={() => setOpen(true)}>
          <span className="pp-breadcrumb-text">{fileName + " / " + (pageName ?? "")}</span>
          <span className="pp-icon">
            <ArrowIcon />
          </span>
          <span>{"/"}</span>
          <Dropdown show={open} onClose={() => setOpen(false)}>
            <ul className="pp-dropdown-sitemap">
              {pages.map((page) => (
                <li
                  key={page.id}
                  id={page.id}
                  className={
                    page.id === pageId ? "pp-dropdown-element pp-selected" : "pp-dropdown-element"
                  }
                  onClick={() => navigateTo(page.id)}
                >
                  <span className="pp-label">{page.name}</span>
                  {page.id === pageId ? (
                    <span className="pp-icon-check">
                      <TickIcon />
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </Dropdown>
        </div>
        <div className="pp-current-frame" id="current-frame" onClick={onToggleThumbnails}>
          <span className="pp-frame-name">{frameName}</span>
          <span className="pp-icon">
            <ArrowIcon />
          </span>
        </div>
      </div>
    </div>
  );
}

export interface ViewerHeaderProps {
  projectName: string;
  fileName: string;
  pageName?: string;
  pageId: string | null;
  pages: SitemapPage[];
  frameName?: string;
  zoom: number;
  fullscreen: boolean;
  inTeam: boolean;
  onGoToDashboard: () => void;
  onGoToWorkspace: () => void;
  onGoToInteractions: () => void;
  onGoToPage: (pageId: string) => void;
  onToggleThumbnails: () => void;
  onCloseThumbnails: () => void;
  onIncreaseZoom: () => void;
  onDecreaseZoom: () => void;
  onResetZoom: () => void;
  onZoomFit: () => void;
  onZoomFill: () => void;
  onToggleFullscreen: () => void;
}

export function ViewerHeader({
  projectName,
  fileName,
  pageName,
  pageId,
  pages,
  frameName,
  zoom,
  fullscreen,
  inTeam,
  onGoToDashboard,
  onGoToWorkspace,
  onGoToInteractions,
  onGoToPage,
  onToggleThumbnails,
  onCloseThumbnails,
  onIncreaseZoom,
  onDecreaseZoom,
  onResetZoom,
  onZoomFit,
  onZoomFill,
  onToggleFullscreen,
}: ViewerHeaderProps) {
  return (
    // Any click on the header closes the thumbnails panel (close-thumbnails
    // guards on shown-thumbnails).
    <header className="pp-viewer-header" onClick={onCloseThumbnails}>
      <div className="pp-nav-zone">
        {/* Without team permissions the link is disabled, like the CLJS
            inline styles. */}
        <a
          className="pp-home-link"
          data-testid="penpot-logo-link"
          onClick={onGoToDashboard}
          style={inTeam ? undefined : { cursor: "auto", pointerEvents: "none" }}
        >
          <PenpotLogoIcon className="pp-logo-icon" />
        </a>
        <SitemapZone
          projectName={projectName}
          fileName={fileName}
          pageName={pageName}
          pageId={pageId}
          pages={pages}
          frameName={frameName}
          onGoToPage={onGoToPage}
          onToggleThumbnails={onToggleThumbnails}
        />
      </div>
      <div className="pp-mode-zone">
        {/* The only section the shell renders is interactions, so the button
            is always selected and navigating it is a no-op once there. */}
        <button
          type="button"
          className="pp-mode-zone-btn pp-selected"
          data-value="interactions"
          title={tr("viewer.header.interactions-section", "G V")}
          onClick={onGoToInteractions}
        >
          <PlayIcon />
        </button>
      </div>
      <div className="pp-options-zone">
        <ZoomWidget
          zoom={zoom}
          onIncrease={onIncreaseZoom}
          onDecrease={onDecreaseZoom}
          onZoomReset={onResetZoom}
          onZoomFit={onZoomFit}
          onZoomFill={onZoomFill}
          onToggleFullscreen={onToggleFullscreen}
        />
        {inTeam ? (
          <button type="button" className="pp-edit-btn" onClick={onGoToWorkspace}>
            <CurveIcon />
          </button>
        ) : null}
        <button
          type="button"
          className={fullscreen ? "pp-fullscreen-btn pp-selected" : "pp-fullscreen-btn"}
          title={tr("viewer.header.fullscreen")}
          onClick={onToggleFullscreen}
        >
          <ExpandIcon />
        </button>
      </div>
    </header>
  );
}
