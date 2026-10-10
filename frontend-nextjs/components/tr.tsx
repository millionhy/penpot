// Renders a translated string, turning the [label](url) link syntax of the
// catalog into real anchors and the **text** runs into <strong>. Stands in for
// i18n/tr-html* in the CLJS app, which injects the same strings as raw HTML.

import { richSegments, tr } from "@/lib/i18n";

export interface TrProps {
  // Translation key. Pass a literal so the extractor can see it.
  k: string;
  args?: ReadonlyArray<unknown>;
  tagName?: "span" | "div" | "p";
  className?: string;
}

export function Tr({ k, args = [], tagName: Tag = "span", className }: TrProps) {
  const segments = richSegments(tr(k, ...args));
  return (
    <Tag className={className}>
      {segments.map((segment, index) => {
        if (segment.href !== undefined) {
          return (
            <a
              key={index}
              href={segment.href}
              target={segment.self === true ? "_self" : "_blank"}
              rel="noreferrer noopener"
            >
              {segment.text}
            </a>
          );
        }
        if (segment.bold === true) {
          return <strong key={index}>{segment.text}</strong>;
        }
        return <span key={index}>{segment.text}</span>;
      })}
    </Tag>
  );
}
