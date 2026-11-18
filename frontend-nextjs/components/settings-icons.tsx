"use client";

// Icons of the settings pages (F5.6). Path data copied verbatim from the icon
// files under frontend/resources/images/icons; the CLJS pages pull them
// through the ds icon* component, which draws every glyph as a 16px svg whose
// stroke the stylesheet paints, like the workspace-icons convention.
//
// icon* has a size "s" that renders the glyph at 12px inside the same 16px
// box; here that size is the `small` flag (a 12px svg the caller centres in a
// 16px box, so the stroke keeps the 0.75px the sprite gives it).

import type { SVGProps } from "react";

interface IconProps extends SVGProps<SVGSVGElement> {
  small?: boolean;
}

function Icon({ small = false, children, ...props }: IconProps) {
  const size = small ? 12 : 16;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="pp-settings-icon"
      {...props}
    >
      {children}
    </svg>
  );
}

// info.svg: the reload hint of the shortcuts page.
export function InfoIcon() {
  return (
    <Icon>
      <path d="M8 9V5m0 6h0ZM1.333 8.082a6.667 6.667 0 1 1 13.333-.163 6.667 6.667 0 0 1-13.333.163Zh0Z" />
    </Icon>
  );
}

// open-link.svg: the MCP help link of the integrations page.
export function OpenLinkIcon() {
  return (
    <Icon>
      <path d="M4 12l8-8zm8-8H4zm0 0v8z" />
    </Icon>
  );
}

// search.svg.
export function SearchIcon({ small = false }: { small?: boolean }) {
  return (
    <Icon small={small}>
      <path d="M7.329 12.666c1.473.002 2.807-.594 3.773-1.559.966-.964 1.564-2.297 1.566-3.77.002-2.945-2.384-5.335-5.33-5.338-2.945-.002-5.335 2.384-5.337 5.329-.003 2.946 2.383 5.336 5.328 5.338Zm6.666 1.339-2.893-2.898" />
    </Icon>
  );
}

// delete-text.svg: the search clear button.
export function DeleteTextIcon({ small = false }: { small?: boolean }) {
  return (
    <Icon small={small}>
      <path d="m7.981 1.333c3.68 0 6.675 2.988 6.686 6.667.01 3.679-2.969 6.667-6.648 6.667-3.68 0-6.675-2.988-6.686-6.667-.01-3.679 2.969-6.667 6.648-6.667zm2.013 4.667-1.994 2-1.994 2m-.012-4 2.006 2 2.006 2" />
    </Icon>
  );
}

// import-export.svg: the footer trigger of the shortcuts page.
export function ImportExportIcon() {
  return (
    <Icon>
      <path d="m8.5 8.658-2-1.657m0 0-2 1.657m2-1.657V11.5m6 1.842-2 1.657m0 0-2-1.657m2 1.657V10.5m3.15.104a3.18 3.18 0 0 0-1.832-5.78h-.802A5.088 5.088 0 1 0 2.278 9.46" />
    </Icon>
  );
}

// broken-link.svg: the disabled-shortcut legend of the footer.
export function BrokenLinkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M6.5 10.5h-1a2.5 2.5 0 0 1 0-5m4 0h1a2.5 2.5 0 0 1 2 4M6 8h2M3 3l10 10" />
    </Icon>
  );
}

// reload.svg: the restore-all button.
export function ReloadIcon() {
  return (
    <Icon>
      <path d="M2.4 8a6 6 0 111.758 4.242M2.4 8l2.1-2zm0 0L1 5.5z" />
    </Icon>
  );
}

// arrow-down.svg: an expanded tree node.
export function ArrowDownIcon({ small = false }: { small?: boolean }) {
  return (
    <Icon small={small}>
      <path d="m4 6 4 4 4-4" />
    </Icon>
  );
}

// arrow-right.svg: a collapsed tree node.
export function ArrowRightIcon({ small = false }: { small?: boolean }) {
  return (
    <Icon small={small}>
      <path d="m6 12 4-4-4-4" />
    </Icon>
  );
}
