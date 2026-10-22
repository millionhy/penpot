"use client";

// The workspace top toolbar (F9.4, tools opened by F9.5): the floating row
// at the top center of the viewport. Port of
// app.main.ui.workspace.top_toolbar.
//
// Move, frame, rect and ellipse switch the canvas tool (F9.5); the line,
// arrow, text, image, path and curve entries stay disabled until their
// slices land. The CLJS toolbar renders nothing for read-only files, and
// so does this one.
//
// Deviations from the CLJS original, documented (AD12):
// - No tool flyouts, MCP/plugins buttons, debug panel or toolbar collapse
//   handle; no rulers, so the row sits at the 8px offset of
//   .no-rulers.
// - No tool keyboard shortcuts.

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
import { isDrawTool, type WorkspaceTool } from "@/lib/workspace";

interface DrawingTool {
  tool: WorkspaceTool;
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
  tool: WorkspaceTool;
  onToolChange: (tool: WorkspaceTool) => void;
}

export function WorkspaceTopToolbar({
  canEdit,
  tool,
  onToolChange,
}: WorkspaceTopToolbarProps) {
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
        className={
          tool === "move"
            ? "pp-workspace-tool pp-workspace-tool--active"
            : "pp-workspace-tool"
        }
        aria-pressed={tool === "move"}
        title={tr("workspace.toolbar.move")}
        aria-label={tr("workspace.toolbar.move")}
        data-tool="move"
        onClick={() => onToolChange("move")}
      >
        <MoveIcon />
      </button>

      {DRAWING_TOOLS.map((entry) => {
        const enabled = isDrawTool(entry.tool);
        const active = tool === entry.tool;
        return (
          <button
            key={entry.tool}
            type="button"
            className={
              active ? "pp-workspace-tool pp-workspace-tool--active" : "pp-workspace-tool"
            }
            disabled={!enabled}
            aria-pressed={active}
            title={entry.label}
            aria-label={entry.label}
            data-tool={entry.tool}
            onClick={enabled ? () => onToolChange(entry.tool) : undefined}
          >
            {entry.icon}
          </button>
        );
      })}
    </div>
  );
}
