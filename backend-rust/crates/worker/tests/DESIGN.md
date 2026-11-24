# Mixed Clojure and Rust worker cluster

This document defines the compatibility checks that need a live PostgreSQL
and Redis instance. The offline Rust gate does not start either service.

## Shared row and queue contract

- `task` is a partitioned table. `completed` and `failed` rows live in
  `task_completed`; every other status lives in `task_default`.
- Status strings are `new`, `retry`, `scheduled`, `running`, `completed`,
  and `failed`.
- `queue` stores `tenant:queue`. The Redis list key is
  `penpot.worker.queue:<tenant>:<queue>`.
- `props` is Transit JSON in JSONB. Both workers must decode the same map and
  must not treat the payload as Fressian file data.
- A dispatcher publishes a Transit vector `[task-id scheduled-at]`. The
  runner compares epoch milliseconds with the current row and skips a stale
  message when the timestamp changed.

## Retry contract

The runner catches a handler error as follows:

- At `retry_num < max_retries`, persist `status = retry`, add `inc_by`
  (default `1`), and schedule after `delay * 2^(new_retry_num - 1)`.
- At `retry_num >= max_retries`, persist `status = failed`.
- `inc_by = 0` keeps the retry number. The same exponential rule still uses
  the resulting retry number.
- A missing handler completes the task with a warning, matching the current
  Clojure runner.

## Live compatibility matrix

1. Clojure dispatcher, Rust runner: submit one `sendmail`, one
   `objects-gc`, one `tasks-gc`, one `session-gc`, and one `run-webhook`
   task. Assert status, retry count, error text, and queue payload shape.
2. Rust dispatcher, Clojure runner: repeat the five tasks. The Clojure
   runner must decode every payload and update the same columns.
3. Move a task's scheduled timestamp after dispatch but before execution.
   Both runners must skip the stale Redis message.
4. Stop Redis after the dispatcher marks rows scheduled. After five minutes,
   both implementations must return the rows to `new`.
5. Leave a row in `running` for more than 24 hours. Both implementations must
   mark it failed with `orphan with running status`.
6. Run both cron schedulers against one `scheduled_task` row. The
   `FOR UPDATE SKIP LOCKED` lock must allow only one instance to execute a
   tick and both instances must compute the same next instant.

## Unlock conditions

Use a disposable database with the backend migrations applied and a
disposable Redis database. Never point these tests at shared data. The live
adapter must map sqlx and Redis connection errors as retryable operational
errors so the loop sleeps instead of terminating.
