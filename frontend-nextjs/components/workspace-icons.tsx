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
