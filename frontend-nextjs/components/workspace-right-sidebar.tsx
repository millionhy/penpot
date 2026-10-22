"use client";

// The workspace right sidebar (F9.4): a 52px header (the zoom widget) plus
// the options area. F9.5 fills that area with the style panel, passed as
// children; without children the empty placeholder stays, so the sidebar
// still works on its own.

import type { ReactNode } from "react";

import { tr } from "@/lib/i18n";

export interface WorkspaceRightSidebarProps {
  header?: ReactNode;
  children?: ReactNode;
}

export function WorkspaceRightSidebar({
  header,
  children,
}: WorkspaceRightSidebarProps) {
  return (
    <aside className="pp-workspace-right">
      <header className="pp-workspace-right-header">{header}</header>
      <div className="pp-workspace-right-options">
        {children ?? <p className="pp-workspace-empty">{tr("labels.empty")}</p>}
      </div>
    </aside>
  );
}
