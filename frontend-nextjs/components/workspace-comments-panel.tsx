"use client";

// The workspace comments panel (F5.7): the port of the sidebar thread list of
// app.main.ui.workspace.comments (the comments-list, thread-info and
// thread-card pieces): the filter row, the thread cards with their unread
// badges, the expanded thread with its replies and the reply composer. The
// shell swaps it into the right sidebar in place of the style panel while
// comments.panelOpen.
//
// The panel drives lib/workspace-comments-actions and reads the comments
// slice of lib/workspace-store, so it stays in step with the canvas pins
// (components/workspace-comment-bubbles) without any shared callback.
//
// Deviations from the CLJS original, documented:
// - The panel lists the threads of the open page only; the CLJS groups every
//   page of the file under a per-page title.
// - The stamps go through lib/timeago (the port of app.common.time/timeago);
//   the cards show author, avatar and relative time like the CLJS list.
// - Deleting a reply has no confirm step; deleting a thread keeps the CLJS
//   confirm modal (modals.delete-comment-thread). The CLJS thread options
//   dropdown is flattened into a single delete button, shown to the thread
//   owner like the CLJS checks.
// - The @mention autocomplete runs through components/comment-mention (the
//   suggestions popup of app.main.ui.comments); a mention stored in the
//   content renders as a chip through parseCommentContent. The inline reply
//   editor (the CLJS options-menu edit entry) takes plain text: the suggestion
//   popup stays on the composer only.
// - The CLJS resolve control is a textless checkbox (the checkbox* call in
//   comments.cljs carries no label); this port keeps that shape and its
//   meaning: checked resolves the thread.
// - New threads go through the canvas click-to-place flow (the :comments
//   drawing tool): the list footer enters placement and the floating composer
//   on the canvas collects the text, like the CLJS create-draft gesture.

import { useRef, useState, useSyncExternalStore } from "react";

import { CommentAvatar } from "@/components/comment-avatar";
import {
  MentionSuggestions,
  useMentionAutocomplete,
} from "@/components/comment-mention";
import { ConfirmDialog, useModal } from "@/components/modal";
import { tr } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { timeAgo } from "@/lib/timeago";
import {
  sortThreads,
  threadById,
  threadsMentioning,
  validCommentContent,
  visibleThreads,
  parseCommentContent,
  type CommentThread,
} from "@/lib/workspace-comments";
import {
  closeCommentThread,
  editCommentInThread,
  markAllLoadedRead,
  openCommentThread,
  removeReplyFromThread,
  removeThread,
  setCommentsFilter,
  setCommentsPanelOpen,
  setCommentsShowResolved,
  startCommentPlacement,
  submitReply,
  toggleThreadResolved,
} from "@/lib/workspace-comments-actions";
import {
  getInitialWorkspaceState,
  getWorkspaceState,
  subscribeWorkspace,
  type CommentsFilter,
} from "@/lib/workspace-store";

// The three radio filters of the CLJS panel header. The label lives in a
// labelKey field so scripts/extract-translations.mjs sees the literal (the
// data-driven pattern of settingsNav).
const FILTERS = [
  { value: "all", labelKey: "labels.show-all-comments" },
  { value: "yours", labelKey: "labels.show-your-comments" },
  { value: "mentions", labelKey: "labels.show-mentions" },
] as const;

// One comment content with its @[name](id) tokens rendered as chips.
function CommentBody({ content }: { content: string }) {
  return (
    <>
      {parseCommentContent(content).map((segment, index) =>
        segment.kind === "text" ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <span key={index} className="pp-comment-mention">
            @{segment.name}
          </span>
        ),
      )}
    </>
  );
}

// The inline editor of one comment row (the CLJS comment-edit-form*, without
// its mention popup): the row remounts per edited id, so no reset effect.
function ReplyEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (content: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <span className="pp-comments-reply-edit">
      <textarea
        className="pp-comments-input"
        rows={3}
        value={value}
        aria-label={tr("labels.edit")}
        onChange={(event) => setValue(event.target.value)}
      />
      <span className="pp-comments-edit-actions">
        <button
          type="button"
          className="pp-comments-submit"
          disabled={!validCommentContent(value)}
          onClick={() => onSave(value)}
        >
          {tr("labels.save")}
        </button>
        <button type="button" className="pp-comments-back" onClick={onCancel}>
          {tr("labels.cancel")}
        </button>
      </span>
    </span>
  );
}

export interface WorkspaceCommentsPanelProps {
  // The open page: threads of other pages stay out of the list.
  pageId: string;
}

export function WorkspaceCommentsPanel({ pageId }: WorkspaceCommentsPanelProps) {
  const state = useSyncExternalStore(
    subscribeWorkspace,
    getWorkspaceState,
    getInitialWorkspaceState,
  );
  const comments = state.comments;
  const { profile } = useSession();
  const profileId = profile?.id ?? null;
  const { open: openModal } = useModal();
  const [draft, setDraft] = useState("");
  // The comment row in inline edition (the CLJS edition? local flag, one at a
  // time): id of the row plus the content it started with.
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mention = useMentionAutocomplete(
    comments.members,
    draft,
    setDraft,
    textareaRef,
  );

  const pageThreads = comments.threads.filter((thread) => thread["page-id"] === pageId);
  const visible = visibleThreads(pageThreads, {
    showResolved: comments.showResolved,
    onlyForProfile: comments.filter === "yours" ? profileId : null,
  });
  const shown = sortThreads(
    comments.filter === "mentions" ? threadsMentioning(visible, profileId) : visible,
  );

  const openThread = threadById(comments.threads, comments.openThreadId);

  const submitAnswer = (): void => {
    if (openThread === null || !validCommentContent(draft)) return;
    setDraft("");
    mention.close();
    void submitReply(openThread.id, draft);
  };

  const confirmDeleteThread = (thread: CommentThread): void => {
    openModal(
      <ConfirmDialog
        title={tr("modals.delete-comment-thread.title")}
        message={tr("modals.delete-comment-thread.message")}
        acceptLabel={tr("modals.delete-comment-thread.accept")}
        cancelLabel={tr("labels.close")}
        destructive
        onAccept={() => void removeThread(thread.id)}
      />,
    );
  };

  const header = (
    <header className="pp-comments-header">
      {openThread === null ? (
        <h3 className="pp-comments-title">{tr("labels.comments")}</h3>
      ) : (
        <button
          type="button"
          className="pp-comments-back"
          onClick={closeCommentThread}
        >
          {tr("labels.show-comments-list")}
        </button>
      )}
      <div className="pp-comments-header-actions">
        {openThread === null ? (
          <button
            type="button"
            className="pp-comments-mark-read"
            onClick={() => void markAllLoadedRead()}
          >
            {tr("label.mark-all-as-read")}
          </button>
        ) : null}
        <button
          type="button"
          className="pp-comments-close"
          aria-label={tr("labels.close")}
          onClick={() => setCommentsPanelOpen(false)}
        >
          ×
        </button>
      </div>
    </header>
  );

  if (openThread !== null) {
    const replies = comments.replies[openThread.id] ?? [];
    const loadingReplies = comments.loadingReplies[openThread.id] === true;
    const resolved = openThread["is-resolved"] === true;
    // The first comment is replies[0] once the replies loaded: the thread row
    // only carries its content projection, so edition needs the reply row.
    const firstComment = replies[0];
    const canEditFirst =
      profileId !== null && profileId === openThread["owner-id"] && firstComment !== undefined;

    const saveEdit = (commentId: string, content: string): void => {
      setEditing(null);
      void editCommentInThread(openThread.id, commentId, content);
    };
    return (
      <div className="pp-comments-panel" data-testid="comments-panel">
        {header}
        <div className="pp-comments-thread" data-testid="comment-thread">
          <div className="pp-comments-thread-title">
            {/* The textless resolve checkbox of comments.cljs: checked
                resolves the thread. */}
            <input
              type="checkbox"
              className="pp-comments-resolve"
              checked={resolved}
              onChange={() => void toggleThreadResolved(openThread.id, !resolved)}
            />
            <span className="pp-comments-thread-seqn">
              {tr("labels.comment")} #{openThread.seqn}
            </span>
            {profileId !== null && profileId === openThread["owner-id"] ? (
              <button
                type="button"
                className="pp-comments-thread-delete"
                onClick={() => confirmDeleteThread(openThread)}
              >
                {tr("labels.delete-comment-thread")}
              </button>
            ) : null}
          </div>
          <ul className="pp-comments-replies">
            <li className="pp-comments-reply" data-testid="comment-first">
              <span className="pp-comments-reply-meta">
                <CommentAvatar
                  className="pp-comment-avatar--small"
                  photoId={openThread["owner-photo-id"]}
                  name={openThread["owner-fullname"] ?? ""}
                />
                <span className="pp-comments-reply-author">
                  {openThread["owner-fullname"] ?? ""}
                </span>
                <span className="pp-comments-time">{timeAgo(openThread["created-at"])}</span>
              </span>
              {canEditFirst && editing?.id === firstComment.id ? (
                <ReplyEditor
                  key={editing.id}
                  initial={editing.content}
                  onSave={(content) => saveEdit(firstComment.id, content)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <span className="pp-comments-reply-body">
                  <CommentBody content={openThread.content} />
                </span>
              )}
              {canEditFirst ? (
                <button
                  type="button"
                  className="pp-comments-reply-edit-btn"
                  aria-label={tr("labels.edit")}
                  onClick={() => setEditing({ id: firstComment.id, content: openThread.content })}
                >
                  ✎
                </button>
              ) : null}
            </li>
            {replies.slice(1).map((reply) => (
              <li key={reply.id} className="pp-comments-reply" data-testid="comment-reply">
                <span className="pp-comments-reply-meta">
                  <CommentAvatar
                    className="pp-comment-avatar--small"
                    photoId={reply["owner-photo-id"]}
                    name={reply["owner-fullname"] ?? ""}
                  />
                  <span className="pp-comments-reply-author">
                    {reply["owner-fullname"] ?? ""}
                  </span>
                  <span className="pp-comments-time">{timeAgo(reply["created-at"])}</span>
                </span>
                {editing?.id === reply.id ? (
                  <ReplyEditor
                    key={editing.id}
                    initial={editing.content}
                    onSave={(content) => saveEdit(reply.id, content)}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <span className="pp-comments-reply-body">
                    <CommentBody content={reply.content} />
                  </span>
                )}
                {profileId !== null && profileId === reply["owner-id"] ? (
                  <>
                    <button
                      type="button"
                      className="pp-comments-reply-edit-btn"
                      aria-label={tr("labels.edit")}
                      onClick={() => setEditing({ id: reply.id, content: reply.content })}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="pp-comments-reply-delete"
                      aria-label={tr("labels.delete-comment")}
                      onClick={() => void removeReplyFromThread(openThread.id, reply.id)}
                    >
                      ×
                    </button>
                  </>
                ) : null}
              </li>
            ))}
            {loadingReplies ? (
              <li className="pp-comments-empty">{tr("labels.empty")}</li>
            ) : null}
          </ul>
          <div className="pp-comments-composer">
            <MentionSuggestions mention={mention} onPick={mention.pick} />
            <textarea
              className="pp-comments-input"
              rows={3}
              ref={textareaRef}
              value={draft}
              placeholder={tr("labels.write-new-comment")}
              aria-label={tr("labels.write-new-comment")}
              onChange={(event) => {
                setDraft(event.target.value);
                mention.onChange(event);
              }}
              onKeyDown={(event) => {
                if (mention.onKeyDown(event)) event.preventDefault();
              }}
            />
            <button
              type="button"
              className="pp-comments-submit"
              disabled={!validCommentContent(draft)}
              onClick={submitAnswer}
            >
              {tr("labels.reply")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pp-comments-panel" data-testid="comments-panel">
      {header}
      <div className="pp-comments-filters" role="radiogroup" aria-label={tr("labels.comments")}>
        {FILTERS.map((item) => (
          <label key={item.value} className="pp-comments-filter">
            <input
              type="radio"
              name="pp-comments-filter"
              checked={comments.filter === item.value}
              onChange={() => setCommentsFilter(item.value as CommentsFilter)}
            />
            <span>{tr(item.labelKey)}</span>
          </label>
        ))}
      </div>
      <label className="pp-comments-option">
        <input
          type="checkbox"
          checked={!comments.showResolved}
          onChange={() => setCommentsShowResolved(!comments.showResolved)}
        />
        <span>{tr("labels.hide-resolved-comments")}</span>
      </label>
      {comments.status === "error" ? (
        <p className="pp-comments-error">{tr("errors.comment-error")}</p>
      ) : null}
      <ul className="pp-comments-list">
        {shown.map((thread) => (
          <li key={thread.id}>
            <button
              type="button"
              className={
                thread["count-unread-comments"] !== undefined &&
                thread["count-unread-comments"] > 0
                  ? "pp-comments-thread-card pp-comments-thread-card--unread"
                  : "pp-comments-thread-card"
              }
              data-testid="comment-thread-card"
              onClick={() => void openCommentThread(thread.id)}
            >
              <CommentAvatar
                className="pp-comments-thread-avatar"
                photoId={thread["owner-photo-id"]}
                name={thread["owner-fullname"] ?? ""}
              />
              <span className="pp-comments-thread-seqn">#{thread.seqn}</span>
              <span className="pp-comments-thread-author">
                {thread["owner-fullname"] ?? ""}
                <span className="pp-comments-time">{timeAgo(thread["created-at"])}</span>
              </span>
              <span className="pp-comments-thread-preview">
                <CommentBody content={thread.content} />
              </span>
            </button>
          </li>
        ))}
        {shown.length === 0 && comments.status === "ready" ? (
          <li className="pp-comments-empty">{tr("labels.no-comments-available")}</li>
        ) : null}
        {shown.length === 0 && comments.status === "loading" ? (
          <li className="pp-comments-empty">{tr("labels.empty")}</li>
        ) : null}
      </ul>
      <div className="pp-comments-composer">
        <button
          type="button"
          className="pp-comments-submit"
          onClick={startCommentPlacement}
        >
          {tr("labels.comment")}
        </button>
      </div>
    </div>
  );
}
