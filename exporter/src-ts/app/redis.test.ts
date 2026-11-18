// app.redis: the RESP2 codec and, over a throwaway server, the client the job
// layer sits on.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.PENPOT_SECRET_KEY = "test-secret";

import { decode } from "./transit.js";
import { startRedis, type MockRedis } from "../test/redis-server.js";
import type * as RedisModule from "./redis.js";

let server: MockRedis;
let redis: typeof RedisModule;

beforeAll(async () => {
  server = await startRedis();
  process.env.PENPOT_REDIS_URI = `redis://127.0.0.1:${server.port}/0`;
  process.env.PENPOT_TENANT = "acme";
  redis = await import("./redis.js");
  redis.init();
});

afterAll(async () => {
  await redis.stop();
  await server.close();
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("parseUri", () => {
  it("fills the default port and database", () => {
    expect(redis.parseUri("redis://redis/0")).toMatchObject({ host: "redis", port: 6379, db: 0 });
  });

  it("reads the port, the database and the credentials", () => {
    expect(redis.parseUri("redis://admin:s3cret@cache:6390/3")).toMatchObject({
      host: "cache",
      port: 6390,
      db: 3,
      username: "admin",
      password: "s3cret",
    });
  });
});

describe("the RESP codec", () => {
  it("encodes a command as an array of bulk strings", () => {
    expect(redis.encodeCommand(["HSET", "key", "a", 1])).toBe(
      "*4\r\n$4\r\nHSET\r\n$3\r\nkey\r\n$1\r\na\r\n$1\r\n1\r\n",
    );
  });

  it("waits for the whole bulk string", () => {
    const text = Buffer.from("$5\r\nhello\r\n", "utf8");

    expect(redis.parseReply(text.subarray(0, 8))).toBeUndefined();
    expect(redis.parseReply(text)).toEqual({ value: "hello", next: text.length });
  });

  it("parses nested arrays and integers", () => {
    const text = Buffer.from("*2\r\n$1\r\na\r\n:7\r\n", "utf8");

    expect(redis.parseReply(text)?.value).toEqual(["a", 7]);
  });

  it("turns an error reply into an Error", () => {
    const parsed = redis.parseReply(Buffer.from("-ERR nope\r\n", "utf8"));

    expect(parsed?.value).toBeInstanceOf(Error);
    expect((parsed?.value as Error).message).toBe("ERR nope");
  });

  it("parses a nil bulk string", () => {
    expect(redis.parseReply(Buffer.from("$-1\r\n", "utf8"))?.value).toBeNull();
  });
});

describe("the client", () => {
  it("namespaces keys under the tenant", () => {
    expect(redis.tenantKey("profile-1")).toBe("acme.profile-1");
    expect(redis.redisKey("job.", "j1")).toBe("penpot.exporter.acme.job.j1");
  });

  it("writes a hash and drops nil values", async () => {
    await redis.hset("penpot.exporter.acme.job.j1", { data: "blob", missing: undefined, gone: null });

    expect(server.hashes.get("penpot.exporter.acme.job.j1")).toEqual(new Map([["data", "blob"]]));
  });

  it("reads a hash back and answers null when it is missing", async () => {
    expect(await redis.hgetall("penpot.exporter.acme.job.j1")).toEqual({ data: "blob" });
    expect(await redis.hgetall("penpot.exporter.acme.job.nope")).toBeNull();
  });

  it("scans the job keyspace", async () => {
    await redis.hset("penpot.exporter.acme.job.j2", { data: "blob" });
    await redis.hset("penpot.exporter.acme.other", { data: "blob" });

    expect((await redis.scan("penpot.exporter.acme.job.*")).sort()).toEqual([
      "penpot.exporter.acme.job.j1",
      "penpot.exporter.acme.job.j2",
    ]);
  });

  it("erases a key", async () => {
    await redis.del("penpot.exporter.acme.job.j2");

    expect(await redis.hgetall("penpot.exporter.acme.job.j2")).toBeNull();
  });

  it("publishes a map as compact transit and delivers it to subscribers", async () => {
    const topic = redis.tenantKey("profile-1");
    const received: string[] = [];
    redis.subscribe(topic, (_topic, payload) => received.push(payload));

    // The subscriber connection opens asynchronously, so the SUBSCRIBE has to
    // reach the server before the message does.
    await wait(50);
    redis.publish(topic, { type: "export-update" });

    const deadline = Date.now() + 1000;
    while (received.length === 0 && Date.now() < deadline) await wait(10);

    expect(received).toHaveLength(1);
    expect(decode(received[0])).toEqual({ type: "export-update" });
  });

  it("stops handing messages to an unsubscribed handler", async () => {
    const topic = redis.tenantKey("profile-2");
    const received: string[] = [];
    const unsubscribe = redis.subscribe(topic, (_topic, payload) => received.push(payload));

    unsubscribe();
    await wait(20);
    redis.publish(topic, "hello");
    await wait(50);

    expect(received).toEqual([]);
  });

  it("rejects writes once the connection is gone", async () => {
    await redis.stop();

    await expect(redis.hset("penpot.exporter.acme.job.j3", { data: "blob" })).rejects.toMatchObject({
      data: { code: "redis-not-available" },
    });
  });
});