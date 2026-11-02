"use client";

// The @mention autocomplete shared by the comment composers (F5.7 follow-up):
// the role of the comments-mentions-choice popup of app.main.ui.comments —
// typing "@" (not inside a word) opens up to four candidate members filtered
// on the fullname or the email, ArrowUp/ArrowDown moves the selection and
// Enter/Tab inserts the @[fullname](id) token. The CLJS drives this with an
// Rx stream over a contenteditable; the port keeps the same rules on a plain
// controlled textarea, so the state lives in this hook.

import {
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { CommentAvatar } from "@/components/comment-avatar";
import { tr } from "@/lib/i18n";
import {
  currentMentionQuery,
  filterMentionCandidates,
  insertMentionToken,
  type MentionCandidate,
  type MentionQuery,
} from "@/lib/workspace-comments";

export interface MentionAutocomplete {
  // The popup is open while the caret sits on an @fragment and there are
  // members to suggest.
  open: boolean;
  filter: string;
  candidates: MentionCandidate[];
  selected: number;
  onChange(event: ChangeEvent<HTMLTextAreaElement>): void;
  // True when the key was consumed by the popup (the caller must not submit).
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
  // Insert a candidate picked from the popup list with the pointer.
  pick(user: MentionCandidate): void;
  close(): void;
}

export function useMentionAutocomplete(
  members: readonly MentionCandidate[],
  value: string,
  setValue: (next: string) => void,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
): MentionAutocomplete {
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);

  const candidates = useMemo(
    () => (query === null ? [] : filterMentionCandidates(members, query.filter)),
    [query, members],
  );

  const close = (): void => setQuery(null);

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const position = event.target.selectionStart ?? event.target.value.length;
    setQuery(members.length > 0 ? currentMentionQuery(event.target.value, position) : null);
    setCaret(position);
    setSelected(0);
  };

  const insert = (user: MentionCandidate): void => {
    if (query === null) return;
    const result = insertMentionToken(value, query, caret, user);
    setValue(result.text);
    setQuery(null);
    // Land the caret after the inserted token once the controlled value
    // reaches the DOM again.
    const area = textareaRef.current;
    if (area !== null) {
      requestAnimationFrame(() => area.setSelectionRange(result.caret, result.caret));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (query === null) return false;
    if (event.key === "Escape") {
      close();
      return true;
    }
    if (candidates.length === 0) return false;
    const last = candidates.length - 1;
    if (event.key === "ArrowDown") {
      setSelected((current) => Math.min(current + 1, last));
      return true;
    }
    if (event.key === "ArrowUp") {
      setSelected((current) => Math.max(current - 1, 0));
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      insert(candidates[Math.min(selected, last)]);
      return true;
    }
    return false;
  };

  return {
    open: query !== null && members.length > 0,
    filter: query?.filter ?? "",
    candidates,
    selected,
    onChange,
    onKeyDown,
    pick: insert,
    close,
  };
}

export interface MentionSuggestionsProps {
  mention: MentionAutocomplete;
  onPick(user: MentionCandidate): void;
}

// The popup list above the composer. With no candidates it is the CLJS
// not-found line (the %s carries the typed fragment).
export function MentionSuggestions({ mention, onPick }: MentionSuggestionsProps) {
  if (!mention.open) return null;
  if (mention.candidates.length === 0) {
    return (
      <div className="pp-mention-pop pp-mention-pop--empty" data-testid="mention-empty">
        {tr("comments.mentions.not-found", mention.filter)}
      </div>
    );
  }
  return (
    <div className="pp-mention-pop" role="listbox" data-testid="mention-popup">
      {mention.candidates.map((user, index) => (
        <button
          key={user.id}
          type="button"
          role="option"
          aria-selected={index === mention.selected}
          className={
            index === mention.selected ? "pp-mention-entry pp-mention-entry--selected" : "pp-mention-entry"
          }
          onPointerDown={(event) => {
            // The CLJS binds pointerdown so the button wins over the textarea
            // blur that would otherwise close the popup first.
            event.preventDefault();
            event.stopPropagation();
            onPick(user);
          }}
        >
          <CommentAvatar photoId={user["photo-id"]} name={user.fullname ?? user.email ?? ""} className="pp-mention-avatar" />
          <span className="pp-mention-name">{user.fullname ?? ""}</span>
          <span className="pp-mention-email">{user.email ?? ""}</span>
        </button>
      ))}
    </div>
  );
}
