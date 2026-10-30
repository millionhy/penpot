"use client";

// The workspace top toolbar (F9.4, tools opened by F9.5): the floating row
// at the top center of the viewport. Port of
// app.main.ui.workspace.top_toolbar.
//
// The reference layout is seven tool slots plus the plugins entry: move,
// frame, the shapes group (rect, ellipse, line and arrow), text, image, the
// free-draw group, a 1px separator and plugins. A group with more than one
// member opens its flyout on hover (350 ms, group-tool* on-display-menu) and
// on Enter/Space/ArrowDown; the main button selects the member the group
// last had active, which falls back to the group default (active-group-tool).
// Every tool slot selects its tool, so the row is also the way back to move.
// The CLJS toolbar renders nothing for read-only files, and so does this one.
//
// 第2项 opened text, the freehand curve and the line/arrow drag tools. The
// free-draw group still has one member: the pen tool has no port yet, so the
// group stays a plain button rather than a flyout that would offer it.
//
// Deviations from the CLJS original, documented (AD12):
// - No MCP button, no debug panel and no toolbar collapse toggle; the
//   handler below the row is decorative.
// - No tool keyboard shortcuts.
// - The flyout only handles Escape from the keyboard; Tab moves the focus
//   natively instead of the CLJS roving-focus loop.

import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  ArrowIcon,
  BoardIcon,
  CurveIcon,
  EllipseIcon,
  ImageIcon,
  LineIcon,
  MoveIcon,
  PathIcon,
  PuzzleIcon,
  RectangleIcon,
  TextIcon,
} from "@/components/workspace-icons";
import { tr } from "@/lib/i18n";
import type { WorkspaceTool } from "@/lib/workspace";
import { IMAGE_ACCEPT } from "@/lib/workspace-image";

// group-tool* on-display-menu / on-hide-menu: the delay before the flyout
// opens on hover and before it closes after the pointer leaves.
const FLYOUT_DELAY_MS = 350;

interface ToolGroup {
  // The tool the button selects when the group has no active member (the
  // CLJS :default-tool of the group).
  tool: WorkspaceTool;
  icon: ReactNode;
  // The tools of the group; a single one renders without a flyout.
  members: readonly WorkspaceTool[];
}

// tool-label of top_toolbar.cljs. Every key is a literal call site so
// scripts/extract-translations.mjs sees it.
function toolLabel(tool: WorkspaceTool): string {
  switch (tool) {
    case "move":
      return tr("workspace.toolbar.move");
    case "frame":
      return tr("workspace.toolbar.frame");
    case "rect":
      return tr("workspace.toolbar.rect");
    case "ellipse":
      return tr("workspace.toolbar.ellipse");
    case "line":
      return tr("workspace.toolbar.line");
    case "arrow":
      return tr("workspace.toolbar.arrow");
    case "text":
      return tr("workspace.toolbar.text");
    case "image":
      return tr("workspace.toolbar.image");
    case "path":
      return tr("workspace.toolbar.path");
    case "curve":
      return tr("workspace.toolbar.curve");
    default:
      return tool;
  }
}

// The icon of every tool the toolbar offers (the :tools icons of
// grouped-tools).
function toolIcon(tool: WorkspaceTool): ReactNode {
  switch (tool) {
    case "move":
      return <MoveIcon />;
    case "frame":
      return <BoardIcon />;
    case "ellipse":
      return <EllipseIcon />;
    case "line":
      return <LineIcon />;
    case "arrow":
      return <ArrowIcon />;
    case "text":
      return <TextIcon />;
    case "image":
      return <ImageIcon />;
    case "path":
      return <PathIcon />;
    case "curve":
      return <CurveIcon />;
    default:
      return <RectangleIcon />;
  }
}

const TOOL_GROUPS: readonly ToolGroup[] = [
  { tool: "move", icon: <MoveIcon />, members: ["move"] },
  { tool: "frame", icon: <BoardIcon />, members: ["frame"] },
  {
    tool: "rect",
    icon: <RectangleIcon />,
    members: ["rect", "ellipse", "line", "arrow"],
  },
  { tool: "text", icon: <TextIcon />, members: ["text"] },
  { tool: "image", icon: <ImageIcon />, members: ["image"] },
  { tool: "curve", icon: <CurveIcon />, members: ["curve"] },
];

// active-group-tool: the member the group had active, else its default. The
// call site keeps the value while the pointer moves away, so the button
// shows the tool the user picked until the group changes again.
function activeMember(group: ToolGroup, tool: WorkspaceTool): WorkspaceTool {
  return group.members.includes(tool) ? tool : group.tool;
}

interface ToolGroupButtonProps {
  group: ToolGroup;
  tool: WorkspaceTool;
  onToolChange: (tool: WorkspaceTool) => void;
}

function ToolGroupButton({ group, tool, onToolChange }: ToolGroupButtonProps) {
  const [open, setOpen] = useState(false);
  const [defaultTool, setDefaultTool] = useState<WorkspaceTool>(activeMember(group, tool));
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const hasFlyout = group.members.length > 1;
  const active = group.members.includes(tool);

  // (mf/with-effect [drawtool group] (reset! default-tool* ...)).
  useEffect(() => {
    setDefaultTool(activeMember(group, tool));
  }, [group, tool]);

  useEffect(
    () => () => {
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const cancelTimers = (): void => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleOpen = (): void => {
    if (!hasFlyout) return;
    cancelTimers();
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, FLYOUT_DELAY_MS);
  };

  const scheduleClose = (): void => {
    if (!hasFlyout) return;
    cancelTimers();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, FLYOUT_DELAY_MS);
  };

  const select = (next: WorkspaceTool): void => {
    cancelTimers();
    setOpen(false);
    onToolChange(next);
  };

  return (
    <div
      className="pp-workspace-tool-group"
      onPointerEnter={scheduleOpen}
      onPointerLeave={scheduleClose}
    >
      <button
        ref={buttonRef}
        type="button"
        className={active ? "pp-workspace-tool pp-workspace-tool--active" : "pp-workspace-tool"}
        aria-pressed={active}
        aria-haspopup={hasFlyout ? "true" : undefined}
        aria-expanded={hasFlyout ? open : undefined}
        title={toolLabel(defaultTool)}
        aria-label={toolLabel(defaultTool)}
        data-tool={defaultTool}
        onClick={() => select(defaultTool)}
        onKeyDown={(event) => {
          if (!hasFlyout) return;
          if (event.key === "Escape") {
            if (!open) return;
            event.preventDefault();
            cancelTimers();
            setOpen(false);
            return;
          }
          if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
            event.preventDefault();
            cancelTimers();
            setOpen(true);
          }
        }}
      >
        {toolIcon(defaultTool)}
      </button>

      {hasFlyout ? (
        <ul
          role="menu"
          className={
            open
              ? "pp-workspace-toolbar-flyout pp-workspace-toolbar-flyout--open"
              : "pp-workspace-toolbar-flyout"
          }
          aria-label={toolLabel(defaultTool)}
          aria-hidden={!open}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            cancelTimers();
            setOpen(false);
            buttonRef.current?.focus();
          }}
        >
          {group.members.map((member) => (
            <li key={member} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={tool === member}
                aria-label={toolLabel(member)}
                title={toolLabel(member)}
                className={
                  tool === member
                    ? "pp-workspace-tool pp-workspace-tool--active"
                    : "pp-workspace-tool"
                }
                data-tool={member}
                tabIndex={open ? 0 : -1}
                onClick={() => select(member)}
              >
                {toolIcon(member)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

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
          if (group.tool === "image") {
            return (
              <button
                key={group.tool}
                type="button"
                className="pp-workspace-tool"
                disabled={onImageFiles === undefined}
                title={toolLabel("image")}
                aria-label={toolLabel("image")}
                data-tool={group.tool}
                onClick={
                  onImageFiles === undefined
                    ? undefined
                    : () => imageInputRef.current?.click()
                }
              >
                {group.icon}
              </button>
            );
          }
          return (
            <ToolGroupButton
              key={group.tool}
              group={group}
              tool={tool}
              onToolChange={onToolChange}
            />
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
