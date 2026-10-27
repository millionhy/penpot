"use client";

// Icon components of the workspace shell (F9.4). Path data copied verbatim
// from the icon files under frontend/resources/images/icons; every icon is a
// 16px viewBox svg whose stroke the stylesheet paints, following the
// viewer-icons convention (F6.2).
//
// The Penpot logo is the exception: it keeps the 500px viewBox of
// penpot-logo-icon.svg and the header stylesheet sizes it.

import type { SVGProps } from "react";

export { PenpotLogoIcon } from "@/components/viewer-icons";

function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="pp-workspace-icon"
      {...props}
    >
      {children}
    </svg>
  );
}

// menu.svg: the header menu trigger.
export function MenuIcon() {
  return (
    <Icon>
      <path d="m8 7.333c.368 0 .667.299.667.667s-.299.667-.667.667-.667-.299-.667-.667.299-.667.667-.667zm0-4.666c.368 0 .667.298.667.666s-.299.667-.667.667-.667-.299-.667-.667.299-.666.667-.666zm0 9.333c.368 0 .667.299.667.667s-.299.666-.667.666-.667-.298-.667-.666.299-.667.667-.667z" />
    </Icon>
  );
}

// move.svg: the active toolbar tool.
export function MoveIcon() {
  return (
    <Icon>
      <path d="m2 2 5.129 12.31 1.82-5.361 5.361-1.82z" />
    </Icon>
  );
}

// board.svg: frames.
export function BoardIcon() {
  return (
    <Icon>
      <path d="M3.5 3.5h-2m2 0v-2m0 2h9m-9 0v9m9-9v-2m0 2h2m-2 0v9m0 0h2m-2 0v2m0-2h-9m0 0v2m0-2h-2" />
    </Icon>
  );
}

// rectangle.svg.
export function RectangleIcon() {
  return (
    <Icon>
      <path d="m12.667 2h-9.334c-.736 0-1.333.597-1.333 1.333v9.334c0 .736.597 1.333 1.333 1.333h9.334c.736 0 1.333-.597 1.333-1.333v-9.334c0-.736-.597-1.333-1.333-1.333z" />
    </Icon>
  );
}

// ellipse.svg.
export function EllipseIcon() {
  return (
    <Icon>
      <path d="M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0Z" />
    </Icon>
  );
}

// easing-linear.svg: the line tool.
export function LineIcon() {
  return (
    <Icon>
      <path d="M2.667 13.333L13.333 2.667" />
    </Icon>
  );
}

// stroke-arrow.svg.
export function ArrowIcon() {
  return (
    <Icon>
      <path d="M15.5 7.617h-14m14 0l-6.008 4.996M15.5 7.617L9.492 2.613" />
    </Icon>
  );
}

// text.svg.
export function TextIcon() {
  return (
    <Icon>
      <path d="m2.667 4.666v-1.999h5.333 5.334v1.999m-7.334 8.668h4m-2-10.667v10.666" />
    </Icon>
  );
}

// img.svg: image.
export function ImageIcon() {
  return (
    <Icon>
      <path d="m12.667 2h-9.334c-.736 0-1.333.597-1.333 1.333v9.334c0 .736.597 1.333 1.333 1.333h9.334c.736 0 1.333-.597 1.333-1.333v-9.334c0-.736-.597-1.333-1.333-1.333zm-9.334 12 7.333-7.334 3.334 3.334m-8.333-3.334c-.552 0-1-.447-1-1 0-.552.448-1 1-1s1 .448 1 1c0 .553-.448 1-1 1z" />
    </Icon>
  );
}

// path.svg.
export function PathIcon() {
  return (
    <Icon>
      <path d="m14 1.333c.736 0 1.334.598 1.334 1.334s-.598 1.333-1.334 1.333-1.333-.597-1.333-1.333.597-1.334 1.333-1.334zm-10.667 12c6.667 0 2.667-10.666 9.333-10.666m-10.666 9.333c.713 0 1.296.561 1.332 1.265.001.023.002.045.002.068 0 .736-.598 1.334-1.334 1.334s-1.333-.598-1.333-1.334.597-1.333 1.333-1.333z" />
    </Icon>
  );
}

// curve.svg.
export function CurveIcon() {
  return (
    <Icon>
      <path d="m11.333 2c.175-.175.383-.314.612-.409s.474-.143.722-.143c.247 0 .492.048.721.143s.437.234.612.409.314.383.409.612c.095.228.143.474.143.721 0 .248-.048.493-.143.722s-.234.436-.409.612l-9 9-3.667 1 1-3.667z" />
    </Icon>
  );
}

// status-tick.svg: the saved-status mark.
export function TickIcon() {
  return (
    <Icon>
      <path d="M13.333 4L6 11.333 2.667 8" />
    </Icon>
  );
}

// arrow-right.svg: the layer expand chevron; the stylesheet rotates it when
// the row is expanded.
export function ChevronIcon() {
  return (
    <Icon>
      <path d="m6 12 4-4-4-4" />
    </Icon>
  );
}

// expand.svg: the restore-UI button while the chrome is hidden.
export function ExpandIcon() {
  return (
    <Icon>
      <path d="M10.357 2.813h2.828v2.829m-10.37 4.713v2.829h2.828m7.071-9.9l-9.428 9.429z" />
    </Icon>
  );
}

// add.svg: the zoom-in widget button.
export function PlusIcon() {
  return (
    <Icon>
      <path d="m8 3.333v4.667 4.667m-4.667-4.667h4.667 4.667" />
    </Icon>
  );
}

// remove.svg: the zoom-out widget button.
export function MinusIcon() {
  return (
    <Icon>
      <path d="m3 7.997h10" />
    </Icon>
  );
}

// delete.svg: the page delete button of the sitemap.
export function TrashIcon() {
  return (
    <Icon>
      <path d="m2 4h1.333 2 5.334 2 1.333m-1.333 0v9.333c0 .737-.597 1.334-1.334 1.334h-6.666c-.737 0-1.334-.597-1.334-1.334v-9.333m2 0v-1.333c0-.737.597-1.334 1.334-1.334h2.666c.737 0 1.334.597 1.334 1.334v1.333m-4 3.333v4m2.666-4v4" />
    </Icon>
  );
}

// search.svg: the layers search trigger.
export function SearchIcon() {
  return (
    <Icon>
      <path d="M7.329 12.666c1.473.002 2.807-.594 3.773-1.559.966-.964 1.564-2.297 1.566-3.77.002-2.945-2.384-5.335-5.33-5.338-2.945-.002-5.335 2.384-5.337 5.329-.003 2.946 2.383 5.336 5.328 5.338Zm6.666 1.339-2.893-2.898" />
    </Icon>
  );
}

// document.svg: the page row icon of the sitemap.
export function DocumentIcon() {
  return (
    <Icon>
      <path d="m8.667 1.334h-4.667c-.353 0-.692.14-.942.39-.251.25-.391.589-.391.943v10.667c0 .353.14.692.391.942.25.25.589.391.942.391h8c.354 0 .693-.141.943-.391s.391-.589.391-.942v-7.334zm0 0v4.666h4.667" />
    </Icon>
  );
}

// group.svg: the group rows of the layers tree.
export function GroupIcon() {
  return (
    <Icon>
      <path d="M14.276 13.61c.25-.251.39-.59.39-.943V5.333A1.332 1.332 0 0 0 13.333 4h-6L6 2H2.666c-.353 0-.692.14-.942.391-.251.25-.391.589-.391.942v9.334A1.333 1.333 0 0 0 2.666 14h10.667c.354 0 .693-.14.943-.39Z" />
    </Icon>
  );
}

// comments.svg: the right header comments button.
export function CommentsIcon() {
  return (
    <Icon>
      <path d="M13.611 7.666a5.585 5.585 0 01-.6 2.534 5.67 5.67 0 01-5.066 3.134 5.586 5.586 0 01-2.534-.6L1.611 14l1.267-3.8a5.585 5.585 0 01-.6-2.534A5.67 5.67 0 017.945 2h.333a5.655 5.655 0 015.333 5.334v.332z" />
    </Icon>
  );
}

// history.svg: the right header history button.
export function HistoryIcon() {
  return (
    <Icon>
      <path d="M2.4 8a6 6 0 111.758 4.242M2.4 8l2.1-2M2.4 8L1 5.5m7.4-.7v3.6l2.4 1.2" />
    </Icon>
  );
}

// share.svg: the right header share link (14x15 viewBox).
export function ShareIcon() {
  return (
    <Icon viewBox="0 0 14 15">
      <path d="m4.727 8.673 4.553 2.654m-.007-7.32L4.727 6.66M13 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM5 7.667a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm8 4.666a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
    </Icon>
  );
}

// play.svg: the right header viewer link.
export function PlayIcon() {
  return (
    <Icon>
      <path d="M4 2l9.6 6L4 14V2z" />
    </Icon>
  );
}

// close.svg: the layers search close button.
export function CloseIcon() {
  return (
    <Icon>
      <path d="m11.997 3.997-3.997 4.003-3.997 4.003m-.006-8 4.003 3.997 4.003 3.997" />
    </Icon>
  );
}

// puzzle.svg: the plugins button of the toolbar.
export function PuzzleIcon() {
  return (
    <Icon>
      <path d="M13.152 5.819c.61.609 1.516 1.232 1.516 2.181 0 .96-.93 1.595-1.545 2.21-.438.438-1.023.05-1.203-.433a1.69 1.69 0 0 0-1.207-1.05 1.69 1.69 0 0 0-1.535.45 1.69 1.69 0 0 0-.45 1.536 1.69 1.69 0 0 0 1.05 1.207c.483.18.855.78.432 1.203l-1.073 1.074c-.298.299-.715.471-1.137.471s-.838-.172-1.136-.47l-1.045-1.046a.7.7 0 0 0-.585-.193c-.329.049-.56.336-.68.645a1.69 1.69 0 0 1-1.21 1.026 1.69 1.69 0 0 1-1.521-.453 1.69 1.69 0 0 1-.453-1.52 1.69 1.69 0 0 1 1.026-1.211c.503-.195.896-.82.452-1.265L1.803 9.136A1.62 1.62 0 0 1 1.332 8c0-.939.885-1.55 1.488-2.153.484-.484 1.115-.05 1.327.471A1.69 1.69 0 0 0 5.36 7.322a1.69 1.69 0 0 0 1.508-.455 1.69 1.69 0 0 0 .456-1.508 1.69 1.69 0 0 0-1.005-1.214c-.52-.211-.955-.843-.471-1.326C6.461 2.206 7.038 1.33 8 1.332c.95 0 1.572.907 2.181 1.516.461.46 1.07.051 1.265-.452a1.69 1.69 0 0 1 1.21-1.026 1.69 1.69 0 0 1 1.521.453c.392.391.567.978.453 1.52a1.69 1.69 0 0 1-1.026 1.211c-.503.195-.913.804-.452 1.265" />
    </Icon>
  );
}
