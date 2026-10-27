"use client";

// The workspace top toolbar (F9.4, tools opened by F9.5): the floating row
// at the top center of the viewport. Port of
// app.main.ui.workspace.top_toolbar.
//
// The reference layout is seven tool slots plus the plugins entry: move,
// frame, the shapes group (rect as its default tool), text, image, the
// free-draw group (path as its default tool), a 1px separator and plugins.
// A group button selects its default tool here; the flyouts that pick the
// other members stay out of this slice. The CLJS toolbar renders nothing for
// read-only files, and so does this one.
//
// Deviations from the CLJS original, documented (AD12):
// - No tool flyouts (the shapes and free-draw groups collapse to their
//   default tools), no MCP button, no debug panel and no toolbar collapse
//   toggle; the handler below the row is decorative.
// - No tool keyboard shortcuts.

import type { ReactNode } from "react";

import {
  BoardIcon,
  ImageIcon,
  MoveIcon,
  PathIcon,
  PuzzleIcon,
  RectangleIcon,
  TextIcon,
} from "@/components/workspace-icons";
import { tr } from "@/lib/i18n";
import { isDrawTool, type WorkspaceTool } from "@/lib/workspace";

interface ToolGroup {
  // The tool the button selects when clicked (the CLJS default tool of the
  // group; the flyout members are not reachable here).
  tool: WorkspaceTool;
  label: string;
  icon: ReactNode;
  // The tools that keep the button in its active state, like
  // is-selected-group in the CLJS original.
  members: readonly WorkspaceTool[];
}

const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    tool: "move",
    label: tr("workspace.toolbar.move"),
    icon: <MoveIcon />,
    members: ["move"],
  },
  {
    tool: "frame",
    label: tr("workspace.toolbar.frame"),
    icon: <BoardIcon />,
    members: ["frame"],
  },
  {
    tool: "rect",
    label: tr("workspace.toolbar.rect"),
    icon: <RectangleIcon />,
    members: ["rect", "ellipse", "line", "arrow"],
  },
  {
    tool: "text",
    label: tr("workspace.toolbar.text"),
    icon: <TextIcon />,
    members: ["text"],
  },
  {
    tool: "image",
    label: tr("workspace.toolbar.image"),
    icon: <ImageIcon />,
    members: ["image"],
  },
  {
    tool: "path",
    label: tr("workspace.toolbar.path"),
    icon: <PathIcon />,
    members: ["path", "curve"],
  },
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
      <div className="pp-workspace-toolbar-options" data-testid="toolbar-options">
        {TOOL_GROUPS.map((group) => {
          const enabled = isDrawTool(group.tool);
          const active = group.members.includes(tool);
          return (
            <button
              key={group.tool}
              type="button"
              className={
                active
                  ? "pp-workspace-tool pp-workspace-tool--active"
                  : "pp-workspace-tool"
              }
              disabled={!enabled}
              aria-pressed={active}
              title={group.label}
              aria-label={group.label}
              data-tool={group.tool}
              onClick={enabled ? () => onToolChange(group.tool) : undefined}
            >
              {group.icon}
            </button>
          );
        })}

        <div className="pp-workspace-toolbar-separator" role="separator" />

        <button
          type="button"
          className="pp-workspace-tool"
          aria-label={tr("workspace.toolbar.plugins")}
          title={tr("workspace.toolbar.plugins")}
          data-tool="plugins"
        >
          <PuzzleIcon />
        </button>
      </div>

      <button
        type="button"
        className="pp-workspace-toolbar-handler"
        aria-label={tr("workspace.toolbar.toggle-toolbar")}
        title={tr("workspace.toolbar.toggle-toolbar")}
      >
        <div className="pp-workspace-toolbar-handler-indicator" />
      </button>
    </div>
  );
}
