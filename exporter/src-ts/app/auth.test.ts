// app.auth: the session resolution, its cache and the ownership check.

import { describe, expect, it } from "vitest";

import { checkOwner, requireProfileId, resolveProfileId, rpcUri, type Fetcher } from "./auth.js";
import { errorData } from "./errors.js";
import { encode, keywordMap } from "./transit.js";
import { next as nextUuid, zero } from "./uuid.js";

process.env.PENPOT_SECRET_KEY = "test-secret";
process.env.PENPOT_INTERNAL_URI = "http://backend:6060";

const PROFILE = "11111111-1111-1111-1111-111111111111";

interface Call {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function answer(status: number, body = ""): { fetcher: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    return { status, text: async () => body };
  };
  return { fetcher, calls };
}

function failure(cause: Error): Fetcher {
  return async () => {
    throw cause;
  };
}

describe("rpcUri", () => {
  it("resolves against the internal uri", () => {
    expect(rpcUri()).toBe("http://backend:6060/api/rpc/command/get-profile");
  });
});

describe("resolveProfileId", () => {
  it("returns undefined without a token, without a round trip", async () => {
    const result = await resolveProfileId(undefined, failure(new Error("must not be called")));

    expect(result).toBeUndefined();
  });

  it("asks the backend with the shared key and the cookie", async () => {
    const { fetcher, calls } = answer(200, encode(keywordMap({ id: PROFILE })));

    expect(await resolveProfileId(nextUuid(), fetcher)).toBe(PROFILE);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://backend:6060/api/rpc/command/get-profile");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["Content-Type"]).toBe("application/transit+json");
    expect(calls[0].init.headers["X-Shared-Key"]).toMatch(/^exporter .+$/);
    expect(calls[0].init.headers.Cookie).toMatch(/^auth-token=.+$/);
  });

  it("answers with a copy of the token in the cookie", async () => {
    const token = nextUuid();
    const { fetcher, calls } = answer(200, encode(keywordMap({ id: PROFILE })));

    await resolveProfileId(token, fetcher);

    expect(calls[0].init.headers.Cookie).toBe(`auth-token=${token}`);
  });

  it("caches the answer briefly", async () => {
    const token = nextUuid();
    const first = answer(200, encode(keywordMap({ id: PROFILE })));

    expect(await resolveProfileId(token, first.fetcher)).toBe(PROFILE);
    expect(await resolveProfileId(token, failure(new Error("cached")))).toBe(PROFILE);
    expect(first.calls).toHaveLength(1);
  });

  it("caches an anonymous answer too", async () => {
    const token = nextUuid();
    const first = answer(200, encode(keywordMap({ id: zero })));

    expect(await resolveProfileId(token, first.fetcher)).toBeUndefined();
    expect(await resolveProfileId(token, failure(new Error("cached")))).toBeUndefined();
  });

  it("treats the zero profile as anonymous", async () => {
    const { fetcher } = answer(200, encode(keywordMap({ id: zero })));

    expect(await resolveProfileId(nextUuid(), fetcher)).toBeUndefined();
  });

  it("treats a non-200 answer as anonymous", async () => {
    const { fetcher } = answer(401, "nope");

    expect(await resolveProfileId(nextUuid(), fetcher)).toBeUndefined();
  });

  it("swallows a transport failure", async () => {
    expect(await resolveProfileId(nextUuid(), failure(new Error("offline")))).toBeUndefined();
  });
});

describe("requireProfileId", () => {
  it("rejects an anonymous caller", async () => {
    const { fetcher } = answer(200, encode(keywordMap({ id: zero })));

    try {
      await requireProfileId(nextUuid(), fetcher);
      throw new Error("expected a rejection");
    } catch (cause) {
      expect(errorData(cause)).toMatchObject({ type: "authentication", code: "authentication-required" });
    }
  });

  it("passes the profile through", async () => {
    const { fetcher } = answer(200, encode(keywordMap({ id: PROFILE })));

    expect(await requireProfileId(nextUuid(), fetcher)).toBe(PROFILE);
  });
});

describe("checkOwner", () => {
  it("accepts the owner", () => {
    const job = { "profile-id": PROFILE };

    expect(checkOwner(job, PROFILE)).toBe(job);
  });

  it("hides a job from anyone else", () => {
    const job = { "profile-id": PROFILE };

    try {
      checkOwner(job, "22222222-2222-2222-2222-222222222222");
      throw new Error("expected a rejection");
    } catch (cause) {
      expect(errorData(cause)).toMatchObject({ type: "not-found", code: "object-not-found" });
    }
  });

  it("hides a missing job", () => {
    try {
      checkOwner(undefined, PROFILE);
      throw new Error("expected a rejection");
    } catch (cause) {
      expect(errorData(cause)).toMatchObject({ type: "not-found", code: "object-not-found" });
    }
  });
});