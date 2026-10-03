"use client";

// Lightweight popup menu (F5.2). Stands in for ds.layout.menu's menu*/
// context-menu* until @penpot/ui is wired: a fixed-position portal that
// anchors either to a point (right-click context menus) or to a trigger
// rectangle (the "..." buttons), with the same drilldown submenu variant the
// file and project menus use for their arbitrarily deep move-to trees.
//
// Deviations from the CLJS menus, documented: no type-ahead or arrow-key
// navigation (items are plain buttons, Tab works), and submenus replace the
// content in place instead of a second floating panel.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuAnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type MenuAnchor =
  | { kind: "point"; x: number; y: number }
  | { kind: "rect"; rect: MenuAnchorRect; placement?: "bottom-start" | "bottom-end" };

export interface MenuEntryItem {
  type: "item";
  id: string;
  label: string;
  testId?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuEntrySubmenu {
  type: "submenu";
  id: string;
  label: string;
  items: MenuEntry[];
}

export interface MenuEntrySeparator {
  type: "separator";
  id: string;
}

export type MenuEntry = MenuEntryItem | MenuEntrySubmenu | MenuEntrySeparator;

export function menuAnchorFromEvent(event: { clientX: number; clientY: number }): MenuAnchor {
  return { kind: "point", x: event.clientX, y: event.clientY };
}

export function menuAnchorFromElement(
  element: Element,
  placement: "bottom-start" | "bottom-end" = "bottom-start",
): MenuAnchor {
  const box = element.getBoundingClientRect();
  return {
    kind: "rect",
    rect: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
    placement,
  };
}

const VIEWPORT_MARGIN = 8;

interface Level {
  label: string | null;
  entries: MenuEntry[];
}

export interface DashboardMenuProps {
  anchor: MenuAnchor;
  entries: MenuEntry[];
  onClose: () => void;
  ariaLabel?: string;
}

export function DashboardMenu({ anchor, entries, onClose, ariaLabel }: DashboardMenuProps) {
  const [mounted, setMounted] = useState(false);
  const [levels, setLevels] = useState<Level[]>([{ label: null, entries }]);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const nodeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // The root entries can rebuild while the menu is open (the file menu waits
  // for get-all-projects); a drilled-down level keeps its own snapshot.
  useEffect(() => {
    setLevels((current) => [{ label: null, entries }, ...current.slice(1)]);
  }, [entries]);

  const closeAll = useCallback(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!mounted) return;
    const onPointerDown = (event: MouseEvent) => {
      const node = nodeRef.current;
      if (node !== null && !node.contains(event.target as Node)) closeAll();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAll();
    };
    const onScroll = () => closeAll();
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [mounted, closeAll]);

  // Position after each content change, clamped to the viewport.
  useLayoutEffect(() => {
    if (!mounted) return;
    const node = nodeRef.current;
    if (node === null) return;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    let left: number;
    let top: number;
    if (anchor.kind === "point") {
      left = anchor.x;
      top = anchor.y;
    } else {
      const placement = anchor.placement ?? "bottom-start";
      left = placement === "bottom-end" ? anchor.rect.right - width : anchor.rect.left;
      top = anchor.rect.bottom + 4;
      if (top + height > window.innerHeight - VIEWPORT_MARGIN) {
        const above = anchor.rect.top - height - 4;
        if (above >= VIEWPORT_MARGIN) top = above;
      }
    }
    if (left + width > window.innerWidth - VIEWPORT_MARGIN) {
      left = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    }
    if (top + height > window.innerHeight - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
    }
    setPosition({ left, top });
  }, [mounted, anchor, levels]);

  if (!mounted) return null;

  const current = levels[levels.length - 1];

  const drillIn = (level: Level) => {
    setLevels((stack) => [...stack, level]);
  };

  const drillOut = () => {
    setLevels((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack));
  };

  const renderEntries = (level: Level) => (
    <>
      {level.label !== null ? (
        <li role="none">
          <button type="button" className="pp-menu-item pp-menu-back" onClick={drillOut}>
            <span aria-hidden="true">‹</span>
            <span className="pp-menu-back-label">{level.label}</span>
          </button>
        </li>
      ) : null}
      {level.entries.map((entry) => {
        if (entry.type === "separator") {
          return <li key={entry.id} className="pp-menu-separator" role="separator" />;
        }
        if (entry.type === "submenu") {
          return (
            <li key={entry.id} role="none">
              <button
                type="button"
                role="menuitem"
                className="pp-menu-item"
                data-testid={entry.id}
                aria-haspopup="menu"
                onClick={() => drillIn({ label: entry.label, entries: entry.items })}
              >
                <span className="pp-menu-item-label">{entry.label}</span>
                <span aria-hidden="true">›</span>
              </button>
            </li>
          );
        }
        return (
          <li key={entry.id} role="none">
            <button
              type="button"
              role="menuitem"
              className={
                entry.danger === true ? "pp-menu-item pp-menu-item-danger" : "pp-menu-item"
              }
              data-testid={entry.testId ?? entry.id}
              disabled={entry.disabled === true}
              onClick={() => {
                closeAll();
                entry.onSelect();
              }}
            >
              <span className="pp-menu-item-label">{entry.label}</span>
            </button>
          </li>
        );
      })}
    </>
  );

  return createPortal(
    <div
      className="pp-menu-popup"
      role="menu"
      aria-label={ariaLabel}
      ref={nodeRef}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position === null ? "hidden" : "visible",
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <ul className="pp-menu-list">{renderEntries(current)}</ul>
    </div>,
    document.body,
  );
}
