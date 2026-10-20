"use client";

// The workspace right sidebar (F9.4): a 52px header plus an empty options
// area. The zoom widget moves into the header in Task 5; the design/style
// options toolbox stays out of this slice (AD10: the user chose an empty
// skeleton).

import type { ReactNode } from "react";

import { tr } from "@/lib/i18n";

export interface WorkspaceRightSidebarProps {
  header?: ReactNode;
}

export function WorkspaceRightSidebar({ header }: WorkspaceRightSidebarProps) {
  return (
    <aside className="pp-workspace-right">
      <header className="pp-workspace-right-header">{header}</header>
      <div className="pp-workspace-right-options">
        <p className="pp-workspace-empty">{tr("labels.empty")}</p>
      </div>
    </aside>
  );
}
