// app.jobs.store: redis persistence for export jobs.
//
// Each job is a single blob with a TTL matching the exported file, so records
// expire with their files. Reads use redis; cancellation needs the process that
// runs the job, which is what the cancel topic is for.

import { get } from "../config.js";
import { errorData } from "../errors.js";
import { createLogger, setLevel } from "../logging.js";
import { expire, hgetall, hset, publish, redisKey, scan, subscribe } from "../redis.js";
import { decode, encode, keywordMap } from "../transit.js";
import type { Job } from "../jobs.js";

const log = createLogger("app.jobs.store");
setLevel("app.jobs.store", "debug");

// The topic is resolved on use: the config loads lazily, so reading it at
// module load would force every importer to have the environment ready first.
function cancelTopic(): string {
  return redisKey("job-cancel");
}

export function jobKey(jobId: string): string {
  return redisKey("job.", jobId);
}

function ttl(): number {
  return get("exporter-job-ttl", 3600);
}

// Writes the record and refreshes its TTL. A failed write is logged and
// swallowed: the export still runs and still publishes websocket updates, but
// the job can no longer be fetched afterwards.
export async function persist(job: Job): Promise<Job> {
  const key = jobKey(job.id);

  try {
    await hset(key, { data: encode(keywordMap(job)) });
    await expire(key, ttl());
  } catch (cause) {
    if (errorData(cause).code === "redis-not-available") {
      log.warn({ hint: "job record not persisted, no redis connection", "job-id": job.id, state: job.state });
    } else {
      log.error({ hint: "unable to persist job record", "job-id": job.id, state: job.state, cause });
    }
  }

  return job;
}

// The job record, or undefined when unknown or expired.
export async function fetch(jobId: string): Promise<Job | undefined> {
  const data = await hgetall(jobKey(jobId));
  const blob = data?.data;
  if (blob === undefined) return undefined;

  try {
    return decode<Job>(blob);
  } catch (cause) {
    log.warn({ hint: "unable to decode job record", "job-id": jobId, cause });
    return undefined;
  }
}

export async function fetchAll(): Promise<Job[]> {
  const keys = await scan(redisKey("job.*"));
  const jobs = await Promise.all(
    keys.map(async (key) => {
      const data = await hgetall(key);
      const blob = data?.data;
      if (blob === undefined) return undefined;

      try {
        return decode<Job>(blob);
      } catch {
        return undefined;
      }
    }),
  );

  return jobs.filter((job): job is Job => job !== undefined);
}

// Asks every exporter to cancel `jobId`. Only the one running it acts.
export function requestCancel(jobId: string): void {
  publish(cancelTopic(), jobId);
}

// Registers `handler` (a function of the job-id string) for cancel requests.
// Returns an unsubscribe function.
export function onCancelRequest(handler: (jobId: string) => void): () => void {
  return subscribe(cancelTopic(), (_topic, payload) => handler(payload));
}