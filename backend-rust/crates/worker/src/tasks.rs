//! Task names and SQL contracts owned by the five offline handlers.

/// Email delivery task.
pub const TASK_SENDMAIL: &str = "sendmail";
/// Object and soft-deletion maintenance task.
pub const TASK_OBJECTS_GC: &str = "objects-gc";
/// Completed task-row cleanup.
pub const TASK_TASKS_GC: &str = "tasks-gc";
/// Expired HTTP session cleanup.
pub const TASK_SESSION_GC: &str = "session-gc";
/// Outbound webhook delivery.
pub const TASK_RUN_WEBHOOK: &str = "run-webhook";

/// Five handlers that do not require the Fressian file-data layer.
pub const PENPOT_TASK_NAMES: [&str; 5] = [
    TASK_SENDMAIL,
    TASK_OBJECTS_GC,
    TASK_TASKS_GC,
    TASK_SESSION_GC,
    TASK_RUN_WEBHOOK,
];

/// Delete old task rows. The service binds a PostgreSQL interval.
pub const SQL_TASKS_GC: &str = "DELETE FROM task WHERE scheduled_at < now() - ?::interval";

/// Reserve expired upload sessions in stable age order.
pub const SQL_OBJECTS_GC_UPLOAD_SESSIONS: &str = "SELECT us.id
     FROM upload_session AS us
    WHERE (us.deleted_at IS NOT NULL
           AND us.deleted_at <= ?)
       OR (us.deleted_at IS NULL
           AND us.created_at <= ?)
       OR EXISTS (SELECT 1
                    FROM profile AS p
                   WHERE p.id = us.profile_id
                     AND p.deleted_at IS NOT NULL
                     AND p.deleted_at <= ?)
    ORDER BY us.created_at ASC
    LIMIT ?
      FOR UPDATE OF us
     SKIP LOCKED";

/// Remove upload-session chunk links and return their storage objects.
pub const SQL_OBJECTS_GC_DELETE_CHUNKS: &str = "DELETE FROM upload_session_chunk
    WHERE session_id = ?
    RETURNING object_id";

/// Delete idle and absolutely expired sessions.
pub const SQL_SESSION_GC: &str = "DELETE FROM http_session_v2
    WHERE modified_at < ?::timestamptz
       OR created_at  < ?::timestamptz";

/// Increment a webhook error counter.
pub const SQL_WEBHOOK_ERROR: &str =
    "update webhook set error_code=?, error_count=error_count+1 where id=?";

/// Reset a webhook after a successful delivery.
pub const SQL_WEBHOOK_SUCCESS: &str =
    "update webhook set updated_at=?, error_code=NULL, error_count=0 where id=?";

/// Record one webhook delivery attempt.
pub const SQL_WEBHOOK_DELIVERY: &str = "insert into webhook_delivery (webhook_id, created_at, error_code, req_data, rsp_data) values (?, ?, ?, ?, ?)";
