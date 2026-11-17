"use client";

// Icon components of the viewer shell (F6.2). Path data copied verbatim from
// the icon files under frontend/resources/images/icons; every icon is a 16px
// viewBox svg whose stroke the stylesheet paints (%button-icon /
// %button-icon-small), standing in for the CLJS deprecated-icon vars.

import type { SVGProps } from "react";

function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

export function ArrowIcon() {
  return (
    <Icon>
      <path d="m6 12 4-4-4-4" />
    </Icon>
  );
}

export function ReloadIcon() {
  return (
    <Icon>
      <path d="M2.4 8a6 6 0 111.758 4.242M2.4 8l2.1-2zm0 0L1 5.5z" />
    </Icon>
  );
}

export function TickIcon() {
  return (
    <Icon>
      <path d="m13.333 4-7.333 7.333-3.333-3.333" />
    </Icon>
  );
}

export function ExpandIcon() {
  return (
    <Icon>
      <path d="M10.357 2.813h2.828v2.829m-10.37 4.713v2.829h2.828m7.071-9.9l-9.428 9.429z" />
    </Icon>
  );
}

export function CurveIcon() {
  return (
    <Icon>
      <path d="m11.333 2c.175-.175.383-.314.612-.409s.474-.143.722-.143c.247 0 .492.048.721.143s.437.234.612.409.314.383.409.612c.095.228.143.474.143.721 0 .248-.048.493-.143.722s-.234.436-.409.612l-9 9-3.667 1 1-3.667z" />
    </Icon>
  );
}

export function AddIcon() {
  return (
    <Icon>
      <path d="m8 3.333v4.667 4.667m-4.667-4.667h4.667 4.667" />
    </Icon>
  );
}

export function RemoveIcon() {
  return (
    <Icon>
      <path d="m3 7.997h10" />
    </Icon>
  );
}

// close.svg: the thumbnails summary close button (F6.3).
export function CloseIcon() {
  return (
    <Icon>
      <path d="m11.997 3.997-3.997 4.003-3.997 4.003m-.006-8 4.003 3.997 4.003 3.997" />
    </Icon>
  );
}

export function PlayIcon() {
  return (
    <Icon>
      <path d="M4 2l9.6 6L4 14V2z" />
    </Icon>
  );
}

// comments.svg: the comments section button of the header (F6.6).
export function CommentsIcon() {
  return (
    <Icon>
      <path d="M13.611 7.666a5.585 5.585 0 01-.6 2.534 5.67 5.67 0 01-5.066 3.134 5.586 5.586 0 01-2.534-.6L1.611 14l1.267-3.8a5.585 5.585 0 01-.6-2.534A5.67 5.67 0 017.945 2h.333a5.655 5.655 0 015.333 5.334v.332z" />
    </Icon>
  );
}

// code.svg: the inspect section button (D23, kept beside its neighbours).
export function CodeIcon() {
  return (
    <Icon>
      <path d="M10.666 12l4-4-4-4M5.333 4l-4 4 4 4" />
    </Icon>
  );
}

// clipboard.svg: the copy button of the share dialog (F6.6).
export function ClipboardIcon() {
  return (
    <Icon>
      <path d="M3.333 10h-.666a1.334 1.334 0 01-1.334-1.333v-6c0-.737.597-1.334 1.334-1.334h6c.736 0 1.333.597 1.333 1.334v.666M6 8a2 2 0 012-2h4.667c1.103 0 2 .896 2 2v4.667c0 1.103-.897 2-2 2H8c-1.104 0-2-.897-2-2V8z" />
    </Icon>
  );
}

// component.svg: a component main instance, the inspect layer tree (D23).
export function ComponentIcon() {
  return (
    <Icon>
      <path d="M6.912 1.2a1.54 1.54 0 0 1 2.176 0L14.8 6.912c.6.601.6 1.575 0 2.176L9.088 14.8c-.601.6-1.575.6-2.176 0L1.2 9.088a1.54 1.54 0 0 1 0-2.176L6.912 1.2Zm.755 4.716L5.916 7.667a.47.47 0 0 0 0 .666l1.751 1.751a.47.47 0 0 0 .666 0l1.751-1.751a.47.47 0 0 0 0-.666L8.333 5.916a.47.47 0 0 0-.666 0Z" />
    </Icon>
  );
}

// component-copy.svg: a component instance, the inspect layer tree (D23).
export function ComponentCopyIcon() {
  return (
    <Icon>
      <path d="M7.162 1.2a1.54 1.54 0 0 1 2.176 0l5.709 5.712a1.538 1.538 0 0 1 0 2.176L9.338 14.8c-.601.6-1.575.6-2.176 0l-5.71-5.712a1.54 1.54 0 0 1 0-2.176L7.162 1.2Z" />
    </Icon>
  );
}

// variant.svg: a variant, the inspect layer tree and subtitle (D23).
export function VariantIcon() {
  return (
    <Icon>
      <path d="M8.75 1.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm-1.5 13.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM8.75 8a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0ZM5.375 4.625a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm0 6.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm5.25 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm0-6.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM1.25 8.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm13.5-1.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </Icon>
  );
}

// masked.svg: a masked group, the inspect layer tree (D23).
export function MaskedIcon() {
  return (
    <Icon>
      <path d="m9.333 10-3.333 3.333-3.333-3.333m10.666-7.333h-4.666c-1.473 0-2.667 1.194-2.667 2.666v8" />
    </Icon>
  );
}

// layers.svg: the multiple-selection icon of the inspect sidebar (D23).
export function LayersIcon() {
  return (
    <Icon>
      <path d="M1.333 11.333 8 14.667l6.667-3.334M1.333 8 8 11.333 14.667 8M8 1.333 1.333 4.667 8 8l6.667-3.333L8 1.333z" />
    </Icon>
  );
}

// status-tick.svg: the checked mark of the share dialog checkboxes.
export function StatusTickIcon() {
  return (
    <Icon>
      <path d="M13.333 4L6 11.333 2.667 8" />
    </Icon>
  );
}

// penpot-logo-icon.svg: the sitemap home link. Not 16px - the stylesheet
// sizes it (28px) and paints the fill through the class the caller passes.
export function PenpotLogoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500.00001" {...props}>
      <path
        d="m159.4607 552.36219-52.57675 74.05348v41.86098l-45.753774 21.76184-.412151-.19478v17.20283 255.89707l178.379885 84.27239 10.90209 5.1462 10.89926-5.1462 178.38271-84.27239v-273.0999l-.33593.15808-45.76789-21.76749v-41.81863l-1.60059-2.25268-50.97899-71.8008-52.57958 74.05348v.0734l-38.25894-53.88377-37.96254 53.4688-1.35782-1.91111zm9.3015 43.01555 20.33627 28.64128h-59.27553l20.09914-28.30535zm181.13787 0 20.33626 28.64128h-59.27553l20.09632-28.30535zm-90.83852 20.24593 20.33626 28.63846h-59.2727l20.09631-28.30535zm-134.85903 22.82891h28.11339v94.66356l-28.11339-13.2818zm42.54695 0h27.97224l-.003 114.69495-27.97224-13.21405zm138.58809 0h28.11622l-.003 101.38492-28.11057 13.27898-.003-114.6639zm42.54695 0h27.97224v81.3507l-27.97224 13.21406zm-133.38265 20.24311h28.11339v117.07749l-28.11339-13.2818zm42.54695 0h27.97225l-.003 104.02152-27.97224 13.21688.003-117.2384zm136.12651 31.11133 24.75131 10.12014-24.75131 11.6925zm-286.29137.0367v21.80982l-24.748483-11.6925zm-24.367392 34.4113 156.581352 73.96879v224.87888l-156.581352-73.96877zm334.964042 0v224.8789l-156.58134 73.96877v-224.87888z"
        transform="translate(0 -552.3622)"
      />
    </svg>
  );
}
