"use client";

// token-item* of the integrations page: name, expiration line and the
// options menu with the single Delete entry. The CLJS uses the shared
// context-menu; the shell has no context menu yet, so the menu is a small
// popover kept inside the item.

import { useEffect, useRef, useState } from "react";
import { MenuIcon } from "@/components/workspace-icons";
import { tr } from "@/lib/i18n";
import { tokenSubtitle, type AccessToken } from "@/lib/integrations";

export interface TokenItemProps {
  token: AccessToken;
  onDelete: (token: AccessToken) => void;
}

export function TokenItem({ token, onDelete }: TokenItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const subtitle = tokenSubtitle(token);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (actionsRef.current !== null && !actionsRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  return (
    <div className="pp-token-item" data-id={token.id}>
      <div className="pp-token-item-title" title={token.name}>
        {token.name}
      </div>

      <div
        className={
          "pp-token-item-subtitle" +
          (subtitle.warning ? " pp-token-item-subtitle-warning" : "")
        }
      >
        {subtitle.text}
      </div>

      <div className="pp-token-item-actions" ref={actionsRef}>
        <button
          type="button"
          className="pp-token-item-menu-button"
          aria-label={tr("labels.options")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <MenuIcon />
        </button>

        {menuOpen ? (
          <div className="pp-token-item-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="pp-token-item-delete"
              onClick={() => {
                setMenuOpen(false);
                onDelete(token);
              }}
            >
              {tr("labels.delete")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
