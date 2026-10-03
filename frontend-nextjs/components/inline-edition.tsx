"use client";

// Inline edition (F5.2). Port of app.main.ui.dashboard.inline-edition:
// a self-focused input that commits on Enter and on blur, with the close
// button and Escape committing the current text too (the CLJS on-cancel
// forwards the state value to on-end rather than discarding it).

import { useEffect, useRef, useState } from "react";

export interface InlineEditionProps {
  content: string;
  onEnd: (name: string) => void;
  maxLength?: number;
}

export function InlineEdition({ content, onEnd, maxLength }: InlineEditionProps) {
  const [name, setName] = useState(content);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const node = inputRef.current;
    if (node === null) return;
    node.focus();
    node.select();
  }, []);

  return (
    <div
      className="pp-edit-wrapper"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <input
        className="pp-element-title"
        value={name}
        ref={inputRef}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          // Keep the dashboard-wide Enter handler (open-selected-file) away.
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onEnd(name);
          } else if (event.key === "Enter") {
            event.preventDefault();
            onEnd(event.currentTarget.value);
          }
        }}
        onBlur={(event) => onEnd(event.target.value)}
        maxLength={maxLength}
      />
      <span
        className="pp-inline-close"
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onEnd(name);
        }}
      >
        ×
      </span>
    </div>
  );
}
