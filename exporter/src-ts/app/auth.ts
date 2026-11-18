// app.auth: resolves the caller's session cookie to a real profile id.
//
// The export commands take `profile-id` from the request body, which was
// harmless while it only picked a pub/sub topic. The job API can read and
// cancel other people's work, so its ownership comes from the session: the
// token goes to the backend's get-profile command, which answers with the
// anonymous profile (uuid/zero) when it is not a valid session.
//
// Results are memoized briefly, so a burst of export calls from one client is
// one round trip rather than one per request.

import { getInternalUri, managementKey } from "./config.js";
import { raise } from "./errors.js";
import { createLogger } from "./logging.js";
import { decode, encode } from "./transit.js";
import { ensurePathSlash, join } from "./uri.js";
import { zero } from "./uuid.js";

const log = createLogger("app.auth");

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  "profile-id": string | undefined;
  "expires-at": number;
}

const cache = new Map<string, CacheEntry>();

// The subset of fetch the auth call needs, so a test can answer without a
// backend. The default is the global fetch Node ships.
export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>;

const defaultFetcher: Fetcher = (url, init) => fetch(url, init);

function putInCache(token: string, profileId: string | undefined, now: number): void {
  for (const [key, entry] of cache) {
    if (entry["expires-at"] <= now) cache.delete(key);
  }
  cache.set(token, { "profile-id": profileId, "expires-at": now + CACHE_TTL_MS });
}

export function rpcUri(): string {
  return join(ensurePathSlash(getInternalUri()), "api/rpc/command/get-profile").toString();
}

async function fetchProfileId(token: string, fetcher: Fetcher): Promise<string | undefined> {
  const uri = rpcUri();
  const headers = {
    "Content-Type": "application/transit+json",
    "X-Shared-Key": `exporter ${managementKey()}`,
    Cookie: `auth-token=${token}`,
  };

  try {
    const response = await fetcher(uri, { method: "POST", headers, body: encode({}) });
    if (response.status !== 200) return undefined;
    const body = await response.text();
    return decode<{ id?: string }>(body)?.id;
  } catch (cause) {
    log.warn({ hint: "unable to resolve session profile", uri, cause });
    return undefined;
  }
}

// The authenticated profile id, or undefined for an anonymous or absent
// session.
export async function resolveProfileId(
  token: string | undefined,
  fetcher: Fetcher = defaultFetcher,
): Promise<string | undefined> {
  if (token === undefined || token === null) return undefined;

  const now = Date.now();
  const cached = cache.get(token);
  if (cached !== undefined && cached["expires-at"] > now) return cached["profile-id"];

  const profileId = await fetchProfileId(token, fetcher);
  // uuid/zero is the anonymous profile: treat it as no session at all.
  const resolved = profileId !== undefined && profileId !== zero ? profileId : undefined;

  putInCache(token, resolved, now);
  return resolved;
}

// Like resolve-profile-id, but rejects anonymous callers.
export async function requireProfileId(
  token: string | undefined,
  fetcher: Fetcher = defaultFetcher,
): Promise<string> {
  const profileId = await resolveProfileId(token, fetcher);
  if (profileId === undefined) {
    return raise({
      type: "authentication",
      code: "authentication-required",
      hint: "no valid session for this request",
    });
  }
  return profileId;
}

export interface JobLike {
  "profile-id"?: unknown;
}

// Raises unless `profileId` owns `job`.
export function checkOwner<T extends JobLike | undefined | null>(job: T, profileId: string | undefined): T {
  if (job === undefined || job === null || String(job["profile-id"]) !== String(profileId)) {
    return raise({ type: "not-found", code: "object-not-found", hint: "job does not exist" });
  }
  return job;
}