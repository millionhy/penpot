"use client";

// The workspace top toolbar (F9.4): the floating row at the top center of
// the viewport. Port of app.main.ui.workspace.top_toolbar.
//
// Move is the only active tool; the drawing, text and image tools are
// disabled until F9.5 opens the drawing write path. The CLJS toolbar
// renders nothing for read-only files, and so does this one.
//
// Deviations from the CLJS original, documented (AD10):
// - No tool flyouts, MCP/plugins buttons, debug panel or toolbar collapse
//   handle; no rulers, so the row sits at the 8px offset of
//   .no-rulers.

import type { ReactNode } from "react";

import {
  ArrowIcon,
  BoardIcon,
  CurveIcon,
  EllipseIcon,
  ImageIcon,
  LineIcon,
  MoveIcon,
  PathIcon,
  RectangleIcon,
  TextIcon,
} from "@/components/workspace-icons";
import { tr } from "@/lib/i18n";

interface DrawingTool {
  tool: string;
  label: string;
  icon: ReactNode;
}

const DRAWING_TOOLS: readonly DrawingTool[] = [
  { tool: "frame", label: tr("workspace.toolbar.frame"), icon: <BoardIcon /> },
  { tool: "rect", label: tr("workspace.toolbar.rect"), icon: <RectangleIcon /> },
  {
    tool: "ellipse",
    label: tr("workspace.toolbar.ellipse"),
    icon: <EllipseIcon />,
  },
  { tool: "line", label: tr("workspace.toolbar.line"), icon: <LineIcon /> },
  { tool: "arrow", label: tr("workspace.toolbar.arrow"), icon: <ArrowIcon /> },
  { tool: "text", label: tr("workspace.toolbar.text"), icon: <TextIcon /> },
  { tool: "image", label: tr("workspace.toolbar.image"), icon: <ImageIcon /> },
  { tool: "path", label: tr("workspace.toolbar.path"), icon: <PathIcon /> },
  { tool: "curve", label: tr("workspace.toolbar.curve"), icon: <CurveIcon /> },
];

export interface WorkspaceTopToolbarProps {
  canEdit: boolean;
}

export function WorkspaceTopToolbar({ canEdit }: WorkspaceTopToolbarProps) {
  if (!canEdit) return null;

  return (
    <div
      className="pp-workspace-toolbar"
      role="toolbar"
      aria-label={tr("workspace.toolbar.label")}
      data-testid="workspace-toolbar"
    >
      <button
        type="button"
        className="pp-workspace-tool pp-workspace-tool--active"
        aria-pressed="true"
        title={tr("workspace.toolbar.move")}
        aria-label={tr("workspace.toolbar.move")}
        data-tool="move"
      >
        <MoveIcon />
      </button>

      {DRAWING_TOOLS.map((entry) => (
        <button
          key={entry.tool}
          type="button"
          className="pp-workspace-tool"
          disabled
          title={entry.label}
          aria-label={entry.label}
          data-tool={entry.tool}
        >
          {entry.icon}
        </button>
      ))}
    </div>
  );
}
