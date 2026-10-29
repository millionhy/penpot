"use client";

// The workspace top toolbar (F9.4, tools opened by F9.5): the floating row
// at the top center of the viewport. Port of
// app.main.ui.workspace.top_toolbar.
//
// The reference layout is seven tool slots plus the plugins entry: move,
// frame, the shapes group (rect as its default tool), text, image, the
// free-draw group, a 1px separator and plugins. A group button selects its
// default tool here; the flyouts that pick the other members stay out of
// this slice. The CLJS toolbar renders nothing for read-only files, and so
// does this one.
//
// 第2项 opened text and the freehand curve. The free-draw group defaults to
// curve because the pen tool has no flyout yet; the image slot is the hidden
// file picker image-upload-tool* rather than a tool.
//
// Deviations from the CLJS original, documented (AD12):
// - No tool flyouts (the shapes and free-draw groups collapse to their
//   default tools), no MCP button, no debug panel and no toolbar collapse
//   toggle; the handler below the row is decorative.
// - No tool keyboard shortcuts.

import { useRef, type ReactNode } from "react";

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
import { isDrawingTool, type WorkspaceTool } from "@/lib/workspace";
import { IMAGE_ACCEPT } from "@/lib/workspace-image";

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
    tool: "curve",
    label: tr("workspace.toolbar.curve"),
    icon: <PathIcon />,
    members: ["path", "curve"],
  },
];

export interface WorkspaceTopToolbarProps {
  canEdit: boolean;
  tool: WorkspaceTool;
  onToolChange: (tool: WorkspaceTool) => void;
  // 第2项: the image button is a file picker, not a tool (the CLJS
  // image-upload-tool*); the shell hands the picked files to the canvas.
  onImageFiles?: (files: readonly File[]) => void;
}

export function WorkspaceTopToolbar({
  canEdit,
  tool,
  onToolChange,
  onImageFiles,
}: WorkspaceTopToolbarProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null);

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
          const isImage = group.tool === "image";
          const enabled = isImage ? onImageFiles !== undefined : isDrawingTool(group.tool);
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
              onClick={
                enabled
                  ? isImage
                    ? () => imageInputRef.current?.click()
                    : () => onToolChange(group.tool)
                  : undefined
              }
            >
              {group.icon}
            </button>
          );
        })}

        <input
          ref={imageInputRef}
          className="pp-file-input"
          type="file"
          accept={IMAGE_ACCEPT}
          multiple
          data-testid="image-file-input"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            // Let the same file be picked again after a failed upload.
            event.target.value = "";
            if (files.length > 0) onImageFiles?.(files);
          }}
        />

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
