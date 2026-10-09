"use client";

// Templates strip (F5.6). Port of app.main.ui.dashboard.templates: the
// collapsible bottom drawer with the builtin template cards and the
// libraries & templates link, mounted by the recent and files sections.
//
// Deviations from the CLJS original, documented:
// - import-template! emits launch/finish analytics events and, on the recent
//   section, navigates to the default project; the shell has no analytics
//   seam, and the navigation targets the page already shown (nav ignores the
//   :project-id option, see lib/dashboard.ts), so opening the dialog and
//   refreshing through onFinishImport is the whole behavior.
// - card-item* binds its Enter handler on the inner <a>, which has no href
//   and cannot take focus, so keyboard import never fires there; the shell
//   binds the handler on the focusable container instead.
// - The title and move arrows use text glyphs (no icon set in the shell) and
//   the "Add" icon of the cards is a "+". The arrow glyphs encode the CLJS
//   rotations directly.
// - The CLJS fetch effect reruns on [profile collapsed] and refetches every
//   time; the shell fetches once per mount (ref guard against the StrictMode
//   double effect) when expanded with a profile, and a failed fetch leaves
//   the strip with the link card alone.

import { useEffect, useRef, useState } from "react";
import { useImportFile } from "@/components/import-dialog";
import { getBuiltinTemplates, type BuiltinTemplate } from "@/lib/binfile";
import { config } from "@/lib/config";
import { normalizeWheel } from "@/lib/dom";
import { tr } from "@/lib/i18n";
import {
  readTemplatesCollapsed,
  templateThumbnailUrl,
  visibleTemplates,
  writeTemplatesCollapsed,
} from "@/lib/templates";

interface TemplatesSectionProps {
  // The project the import dialog targets: the current one, else drafts
  // ((or project-id default-project-id) in import-template!).
  projectId: string | null;
  defaultProjectId: string | null;
  profileId: string | null;
  onFinishImport: () => void;
}

// title*: the drawer header, "Libraries & Templates" with the show/hide
// toggle on its right.
function TemplatesTitle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  // Swallow Enter so the window-level dashboard listener (open selected
  // file) cannot react to it, like title*'s on-key-down.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.stopPropagation();
    event.preventDefault();
    onToggle();
  };
  return (
    <div className="pp-template-title">
      <button
        type="button"
        className="pp-template-title-btn"
        onClick={onToggle}
        onKeyDown={onKeyDown}
      >
        <span className="pp-template-title-text">{tr("dashboard.libraries-and-templates")}</span>
        <span className="pp-template-title-icon-container">
          <span className="pp-template-title-icon-text">
            {collapsed ? tr("labels.show") : tr("labels.hide")}
          </span>
          <span className="pp-template-title-icon" aria-hidden="true">
            {collapsed ? "\u2191" : "\u2193"}
          </span>
        </span>
      </button>
    </div>
  );
}

interface TemplateCardProps {
  item: BuiltinTemplate;
  index: number;
  collapsed: boolean;
  onImport: () => void;
}

// card-item*: one template card; hovering swaps the name for the
// add-to-project hint.
function TemplateCard({ item, index, collapsed, onImport }: TemplateCardProps) {
  const [hover, setHover] = useState(false);

  // Enter on the focused card (the handler sits on the container, see the
  // header note) must not reach the window-level open-selected-file listener.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.stopPropagation();
    event.preventDefault();
    onImport();
  };

  return (
    <div
      className="pp-template-card-container"
      id={"card-container-" + index}
      data-index={index}
      tabIndex={collapsed ? -1 : 0}
      onKeyDown={onKeyDown}
    >
      <a
        className="pp-template-card"
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={(event) => {
          event.preventDefault();
          onImport();
        }}
      >
        <div className="pp-template-img-container">
          <img
            src={templateThumbnailUrl(config.publicUri, item.id)}
            alt={item.name}
            loading="lazy"
            decoding="async"
          />
        </div>
        <div className="pp-template-card-name">
          <span className="pp-template-card-text">
            {hover ? tr("dashboard.template.add-to-project") : item.name}
          </span>
          <span className="pp-template-download-icon" aria-hidden="true">
            +
          </span>
        </div>
      </a>
    </div>
  );
}

// card-item-link*: the explore card; Enter inside the link must not bubble
// to the window-level listener either.
function TemplateLinkCard({ total, collapsed }: { total: number; collapsed: boolean }) {
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.stopPropagation();
  };
  return (
    <div className="pp-template-card-container">
      <div className="pp-template-card">
        <div className="pp-template-img-container">
          <a
            id={"card-container-" + total}
            tabIndex={collapsed ? -1 : 0}
            href="https://penpot.app/libraries-templates"
            target="_blank"
            rel="noreferrer"
            onKeyDown={onKeyDown}
          >
            <div className="pp-template-link">
              <div className="pp-template-link-title">{tr("dashboard.libraries-and-templates")}</div>
              <div className="pp-template-link-text">
                {tr("dashboard.libraries-and-templates.explore")}
              </div>
            </div>
          </a>
        </div>
      </div>
    </div>
  );
}

type MoveEvent = React.KeyboardEvent | React.MouseEvent;

export function TemplatesSection({
  projectId,
  defaultProjectId,
  profileId,
  onFinishImport,
}: TemplatesSectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  // null until the fetch settles; then the visible list (possibly empty).
  const [templates, setTemplates] = useState<BuiltinTemplate[] | null>(null);
  const [canMove, setCanMove] = useState({ left: false, right: true });
  const contentRef = useRef<HTMLDivElement | null>(null);
  const requested = useRef(false);

  const { openTemplate } = useImportFile(projectId ?? defaultProjectId, onFinishImport);

  // collapsed* initializes from storage/global in CLJS; the shell reads on
  // mount instead (never during SSR, like useDashboardLayout) and writes
  // through on toggle. The fetch below waits for this read, so a collapsed
  // strip never fetches (the CLJS effect reads storage during render).
  useEffect(() => {
    setCollapsed(readTemplatesCollapsed());
    setHydrated(true);
  }, []);

  // The fetch-builtin-templates half of the [profile collapsed] effect.
  useEffect(() => {
    if (!hydrated || collapsed || profileId === null || templates !== null || requested.current) {
      return;
    }
    requested.current = true;
    void getBuiltinTemplates().then(
      (rows) => setTemplates(visibleTemplates(rows)),
      () => setTemplates([]),
    );
  }, [hydrated, collapsed, profileId, templates]);

  // The [templates] effect: reset the strip to its start and recompute the
  // move buttons (the CLJS scroll-to + dispatch-event pair, direct here).
  useEffect(() => {
    const content = contentRef.current;
    if (content === null || templates === null) return;
    content.scrollTo({ left: 0, top: 0, behavior: "instant" });
    setCanMove({
      left: content.scrollLeft > 0,
      right: content.scrollWidth - content.scrollLeft > content.clientWidth,
    });
  }, [templates]);

  const onToggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeTemplatesCollapsed(next);
  };

  // on-scroll of templates-section*.
  const onScroll = (event: React.UIEvent) => {
    const content = event.currentTarget;
    const scrollAvailable = content.scrollWidth - content.scrollLeft;
    setCanMove({
      left: content.scrollLeft > 0,
      right: scrollAvailable > content.clientWidth,
    });
  };

  // on-wheel: a mostly-vertical wheel spins the strip sideways. The ":mode
  // smooth" key of the CLJS scrollBy is inert; the smoothness comes from the
  // scroll-behavior in the stylesheet.
  const onWheel = (event: React.WheelEvent) => {
    const content = contentRef.current;
    if (content === null) return;
    const { spinX, spinY } = normalizeWheel(event.nativeEvent);
    if (Math.abs(spinY) > Math.abs(spinX)) {
      content.scrollBy({ left: 300 * spinY });
    }
  };

  // on-move-left / on-move-right share their handler between click and
  // keydown and invert on the opposite arrow key, like the CLJS bindings
  // (both get the same fn; a click event simply has no key).
  const onMoveLeft = (event: MoveEvent) => {
    const content = contentRef.current;
    if (content === null) return;
    const key = "key" in event ? event.key : undefined;
    content.scrollBy({ left: key === "ArrowRight" ? 300 : -300 });
  };
  const onMoveRight = (event: MoveEvent) => {
    const content = contentRef.current;
    if (content === null) return;
    const key = "key" in event ? event.key : undefined;
    content.scrollBy({ left: key === "ArrowLeft" ? -300 : 300 });
  };

  const total = templates?.length ?? 0;

  return (
    <div
      className={
        collapsed ? "pp-dashboard-templates-section is-collapsed" : "pp-dashboard-templates-section"
      }
    >
      <TemplatesTitle collapsed={collapsed} onToggle={onToggleCollapse} />

      <p className="pp-template-content-description">
        {tr("dashboard.libraries-and-templates.description")}
      </p>

      <div className="pp-template-content" ref={contentRef} onScroll={onScroll} onWheel={onWheel}>
        {(templates ?? []).map((item, index) => (
          <TemplateCard
            key={item.id}
            item={item}
            index={index}
            collapsed={collapsed}
            onImport={() => openTemplate(item)}
          />
        ))}

        <TemplateLinkCard total={total} collapsed={collapsed} />
      </div>

      {canMove.left ? (
        <button
          type="button"
          className="pp-template-move-button pp-template-move-left"
          tabIndex={collapsed ? -1 : 0}
          onClick={onMoveLeft}
          onKeyDown={onMoveLeft}
        >
          <span aria-hidden="true">{"\u2190"}</span>
        </button>
      ) : null}

      {canMove.right ? (
        <button
          type="button"
          className="pp-template-move-button pp-template-move-right"
          tabIndex={collapsed ? -1 : 0}
          aria-label={tr("labels.next")}
          onClick={onMoveRight}
          onKeyDown={onMoveRight}
        >
          <span aria-hidden="true">{"\u2192"}</span>
        </button>
      ) : null}
    </div>
  );
}
