"use client";

// The dashboard comment notifications (F5.7): the port of
// app.main.ui.dashboard.comments (DashboardComments, the bell with its unread
// dot and the dropdown feed of the unread threads of the active team; not to
// be confused with the websocket listener of lib/dashboard-notifications).
//
// The CLJS keeps the threads in the global store under :comment-threads and
// filters them through the profile's notification preferences; this port
// holds them in local state because the backend query already applies those
// preferences (get-unread-comment-threads reads
// :notifications :dashboard-comments off the profile), and re-reads them on
// team switch, on open and after marking all read.
//
// Deviations from the CLJS original, documented:
// - The feed rows carry the file name only: the query joins f.name and the
//   thread page name is not among its columns, so the CLJS page-name suffix
//   has no source here (the deep link still carries the page id).
// - Marking all read shows no success toast: the shell has no toast surface
//   yet; the refetch replacing the feed is the feedback.
// - The dropdown closes through its buttons only; the CLJS dropdown also
//   reacts to outside clicks, which needs the shared dropdown primitive.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { CommentAvatar } from "@/components/comment-avatar";
import { useDashboard } from "@/lib/dashboard-context";
import { workspaceHref } from "@/lib/dashboard";
import { tr } from "@/lib/i18n";
import {
  fetchUnreadCommentThreads,
  formatCommentContent,
  groupThreadsByFileAndPage,
  markAllThreadsRead,
  sortByModifiedDesc,
  type CommentThread,
} from "@/lib/workspace-comments";
import { timeAgo } from "@/lib/timeago";

export function DashboardComments() {
  const { teamId } = useDashboard();
  const router = useRouter();
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [show, setShow] = useState(false);

  const reload = useCallback(() => {
    if (teamId === null) {
      setThreads([]);
      return;
    }
    fetchUnreadCommentThreads(teamId)
      .then(setThreads)
      .catch(() => setThreads([]));
  }, [teamId]);

  // The retrieve-unread-comment-threads of the CLJS effect keyed on team-id.
  useEffect(() => {
    reload();
  }, [reload]);

  const onReadAll = (): void => {
    const ids = threads.map((thread) => thread.id);
    if (ids.length === 0) return;
    markAllThreadsRead(ids)
      .then(reload)
      .catch(() => undefined);
  };

  const onThreadClick = (thread: CommentThread): void => {
    setShow(false);
    router.push(
      workspaceHref({
        teamId,
        fileId: thread["file-id"],
        pageId: thread["page-id"],
        threadId: thread.id,
      }),
    );
  };

  const groups = groupThreadsByFileAndPage(sortByModifiedDesc(threads));

  return (
    <div className="pp-dashboard-notifications">
      <button
        type="button"
        className="pp-notifications-bell"
        aria-label={tr("dashboard.notifications.view")}
        data-testid="open-comments"
        onClick={() => setShow((current) => !current)}
      >
        &#128276;
        {threads.length > 0 ? <span className="pp-notifications-unread" aria-hidden="true" /> : null}
      </button>

      {show ? (
        <div className="pp-notifications-dropdown" data-testid="notifications-dropdown">
          <div className="pp-notifications-header">
            <h3 className="pp-notifications-title">{tr("dashboard.notifications")}</h3>
            {threads.length > 0 ? (
              <button
                type="button"
                className="pp-notifications-read-all"
                aria-label={tr("label.mark-all-as-read")}
                onClick={onReadAll}
              >
                &#10003;
              </button>
            ) : null}
            <button
              type="button"
              className="pp-notifications-close"
              aria-label={tr("labels.close")}
              onClick={() => setShow(false)}
            >
              ×
            </button>
          </div>

          {groups.length > 0 ? (
            <div className="pp-notifications-groups">
              {groups.map((group) => (
                <div
                  key={group["page-id"] + group["file-id"]}
                  className="pp-notifications-group"
                  data-testid="notification-group"
                >
                  {group.items.map((thread) => (
                    <button
                      key={thread.id}
                      type="button"
                      className="pp-notifications-item"
                      data-testid="notification-item"
                      onClick={() => onThreadClick(thread)}
                    >
                      <span className="pp-notifications-location">
                        {"#" + thread.seqn + " " + (thread["file-name"] ?? "")}
                      </span>
                      <span className="pp-notifications-thread">
                        <CommentAvatar
                          className="pp-comment-avatar--small"
                          photoId={thread["owner-photo-id"]}
                          name={thread["owner-fullname"] ?? ""}
                        />
                        <span className="pp-notifications-meta">
                          <span className="pp-notifications-author">
                            {thread["owner-fullname"] ?? ""}
                          </span>
                          <span className="pp-notifications-time">
                            {timeAgo(thread["modified-at"] ?? thread["created-at"])}
                          </span>
                        </span>
                        <span className="pp-notifications-preview">
                          {formatCommentContent(thread.content)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="pp-notifications-empty">{tr("labels.no-comments-available")}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
