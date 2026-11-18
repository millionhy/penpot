// app.redis, Node side.
//
// The CLJS namespace uses ioredis; this port speaks RESP2 over node:net
// instead, which is the whole of what the exporter asks of it: hash writes and
// reads, expire, del, a cursor scan, publish and subscribe. Commands are
// queued while the socket is connecting and the socket reconnects on its own,
// like ioredis does by default, because a redis hiccup should not take the
// exporter down with it.
//
// Two connections exist for the same reason as in the original: a connection
// in subscriber mode rejects every other command.

import { createConnection, type Socket } from "node:net";

import { get } from "./config.js";
import { raise } from "./errors.js";
import { createLogger, setLevel } from "./logging.js";
import { encode } from "./transit.js";

const log = createLogger("app.redis");
setLevel("app.redis", "trace");

const CONNECT_TIMEOUT_MS = 5000;
const RECONNECT_DELAY_MS = 1000;

export interface Endpoint {
  host: string;
  port: number;
  username: string | undefined;
  password: string | undefined;
  db: number;
}

// redis://user:pass@host:port/db, the shape of :redis-uri.
export function parseUri(uri: string): Endpoint {
  const url = new URL(uri);
  const db = url.pathname.replace(/^\//, "");

  return {
    host: url.hostname || "127.0.0.1",
    port: url.port === "" ? 6379 : Number.parseInt(url.port, 10),
    username: url.username === "" ? undefined : decodeURIComponent(url.username),
    password: url.password === "" ? undefined : decodeURIComponent(url.password),
    db: db === "" ? 0 : Number.parseInt(db, 10),
  };
}

export function encodeCommand(args: readonly (string | number)[]): string {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const text = String(arg);
    out += `$${Buffer.byteLength(text, "utf8")}\r\n${text}\r\n`;
  }
  return out;
}

export type Reply = string | number | null | Reply[] | Error;

// One reply, or undefined when the buffer holds only part of it. A bulk string
// is sliced by bytes, so a value cut across two chunks is never decoded early.
export function parseReply(buffer: Buffer, offset = 0): { value: Reply; next: number } | undefined {
  if (offset >= buffer.length) return undefined;

  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd < 0) return undefined;

  const marker = String.fromCharCode(buffer[offset]);
  const line = buffer.toString("utf8", offset + 1, lineEnd);
  const next = lineEnd + 2;

  switch (marker) {
    case "+":
      return { value: line, next };
    case "-":
      return { value: new Error(line), next };
    case ":":
      return { value: Number.parseInt(line, 10), next };
    case "$": {
      const size = Number.parseInt(line, 10);
      if (size < 0) return { value: null, next };
      if (buffer.length < next + size + 2) return undefined;
      return { value: buffer.toString("utf8", next, next + size), next: next + size + 2 };
    }
    case "*": {
      const count = Number.parseInt(line, 10);
      if (count < 0) return { value: null, next };

      const items: Reply[] = [];
      let cursor = next;
      for (let index = 0; index < count; index += 1) {
        const parsed = parseReply(buffer, cursor);
        if (parsed === undefined) return undefined;
        items.push(parsed.value);
        cursor = parsed.next;
      }
      return { value: items, next: cursor };
    }
    default:
      return { value: new Error(`unexpected redis reply: ${marker}`), next };
  }
}

type MessageHandler = (topic: string, payload: string) => void;
type Waiter = { resolve: () => void; reject: (cause: unknown) => void };
type Pending = { resolve: (value: Reply) => void; reject: (cause: unknown) => void };

class Connection {
  private socket: Socket | undefined;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private pending: Pending[] = [];
  private waiters: Waiter[] = [];
  private readonly topics = new Set<string>();
  private messageHandler: MessageHandler | undefined;
  private stopped = false;
  private retry: NodeJS.Timeout | undefined;

  constructor(
    private readonly endpoint: Endpoint,
    private readonly uri: string,
    private readonly role: string,
  ) {}

  start(): void {
    this.open();
  }

  stop(): Promise<void> {
    if (this.stopped) return Promise.resolve();

    this.stopped = true;
    if (this.retry !== undefined) clearTimeout(this.retry);

    // QUIT gets a reply, but the socket is going away either way, so the
    // answer is not awaited past the write.
    const closing = this.socket;
    this.socket = undefined;
    if (closing !== undefined) {
      closing.write(encodeCommand(["QUIT"]));
      closing.end();
    }

    this.failWaiters(new Error("redis connection stopped"));
    this.failPending(new Error("redis connection stopped"));

    return Promise.resolve();
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  subscribe(topic: string): void {
    this.topics.add(topic);
    if (this.socket !== undefined && !this.socket.connecting) {
      this.socket.write(encodeCommand(["SUBSCRIBE", topic]));
    }
  }

  async command(args: readonly (string | number)[]): Promise<Reply> {
    if (this.stopped) {
      return raise({ type: "internal", code: "redis-not-available", hint: "no redis connection" });
    }

    await this.waitForConnection();

    return new Promise<Reply>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket?.write(encodeCommand(args));
    });
  }

  private open(): void {
    if (this.stopped) return;

    const socket = createConnection({ host: this.endpoint.host, port: this.endpoint.port });
    this.socket = socket;
    socket.setNoDelay(true);

    socket.on("connect", () => {
      log.info({ hint: "redis connection established", uri: this.uri, role: this.role });
      this.handshake();
      this.resolveWaiters();
      for (const topic of this.topics) socket.write(encodeCommand(["SUBSCRIBE", topic]));
    });

    socket.on("data", (chunk: Buffer) => this.onData(chunk));

    socket.on("error", (cause) => {
      log.error({ hint: "error on redis connection", role: this.role, cause });
    });

    socket.on("close", () => {
      log.warn({ hint: "connection closed", role: this.role });
      this.socket = undefined;
      this.buffer = Buffer.alloc(0);
      this.failPending(new Error("redis connection closed"));
      this.scheduleReconnect();
    });
  }

  private handshake(): void {
    const socket = this.socket;
    if (socket === undefined) return;

    if (this.endpoint.password !== undefined) {
      const args =
        this.endpoint.username === undefined
          ? ["AUTH", this.endpoint.password]
          : ["AUTH", this.endpoint.username, this.endpoint.password];
      socket.write(encodeCommand(args));
    }

    if (this.endpoint.db !== 0) socket.write(encodeCommand(["SELECT", this.endpoint.db]));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retry !== undefined) return;

    this.retry = setTimeout(() => {
      this.retry = undefined;
      log.warn({ hint: "reconnecting to redis", role: this.role, ms: RECONNECT_DELAY_MS });
      this.open();
    }, RECONNECT_DELAY_MS);
    this.retry.unref?.();
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    for (;;) {
      const parsed = parseReply(this.buffer);
      if (parsed === undefined) break;

      this.buffer = this.buffer.subarray(parsed.next);
      this.dispatch(parsed.value);
    }
  }

  private dispatch(value: Reply): void {
    const pending = this.pending.shift();
    if (pending !== undefined) {
      if (value instanceof Error) pending.reject(value);
      else pending.resolve(value);
      return;
    }

    // No command is waiting, so this is a push: only `message` matters, and
    // the subscription confirmations and pongs are dropped.
    if (Array.isArray(value) && value[0] === "message" && value.length >= 3) {
      const topic = String(value[1]);
      const payload = String(value[2]);
      this.messageHandler?.(topic, payload);
    }
  }

  private waitForConnection(): Promise<void> {
    if (this.socket !== undefined && !this.socket.connecting) return Promise.resolve();
    if (this.stopped) {
      return Promise.reject(new Error("no redis connection"));
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (cause) => {
          clearTimeout(timer);
          reject(cause);
        },
      };

      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error("redis connection timed out"));
      }, CONNECT_TIMEOUT_MS);
      timer.unref?.();

      this.waiters.push(waiter);
    });
  }

  private resolveWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  private failWaiters(cause: unknown): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(cause);
  }

  private failPending(cause: unknown): void {
    const pending = this.pending;
    this.pending = [];
    for (const item of pending) item.reject(cause);
  }
}

let client: Connection | undefined;
let subscriber: Connection | undefined;

const subscriptions = new Map<string, Set<MessageHandler>>();

function dispatchMessage(topic: string, payload: string): void {
  for (const handler of subscriptions.get(topic) ?? []) {
    try {
      handler(topic, payload);
    } catch (cause) {
      log.error({ hint: "error on redis subscription handler", topic, cause });
    }
  }
}

function createConnectionFor(endpoint: Endpoint, uri: string, role: string): Connection {
  const connection = new Connection(endpoint, uri, role);
  connection.start();
  return connection;
}

export function init(): void {
  const uri = get("redis-uri");
  const endpoint = parseUri(uri);

  client?.stop().catch(() => undefined);
  subscriber?.stop().catch(() => undefined);

  client = createConnectionFor(endpoint, uri, "commands");

  const sub = createConnectionFor(endpoint, uri, "subscriber");
  sub.onMessage(dispatchMessage);
  // A reconnection leaves the socket open but forgets the subscriptions, so
  // they are reinstated by Connection#open; nothing else to do here.
  subscriber = sub;

  for (const topic of subscriptions.keys()) sub.subscribe(topic);
}

export function stop(): Promise<void> {
  subscriptions.clear();

  const running = [subscriber?.stop(), client?.stop()].filter(
    (item): item is Promise<void> => item !== undefined,
  );
  subscriber = undefined;
  client = undefined;

  return Promise.all(running).then(() => undefined);
}

function requireClient(): Connection {
  if (client === undefined) {
    return raise({ type: "internal", code: "redis-not-available", hint: "no redis connection" });
  }
  return client;
}

// Namespaces `parts` under the tenant, the prefix the backend msgbus uses.
export function tenantKey(...parts: readonly string[]): string {
  return `${get("tenant")}.${parts.join("")}`;
}

// Namespaces `parts` under the exporter, inside the tenant.
export function redisKey(...parts: readonly string[]): string {
  return `penpot.exporter.${get("tenant")}.${parts.join("")}`;
}

// Publishes on `topic`, which must already be namespaced.
export function publish(topic: string, payload: unknown): void {
  const text = isPlainObject(payload) ? encode(payload) : String(payload);
  client?.command(["PUBLISH", topic, text]).catch((cause) => {
    log.warn({ hint: "unable to publish", topic, cause });
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value)
  );
}

// Subscribes `handler` to `topic`, which must already be namespaced. Returns a
// function that removes this handler.
export function subscribe(topic: string, handler: MessageHandler): () => void {
  let handlers = subscriptions.get(topic);
  if (handlers === undefined) {
    handlers = new Set();
    subscriptions.set(topic, handlers);
  }
  handlers.add(handler);

  subscriber?.subscribe(topic);

  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) subscriptions.delete(topic);
  };
}

// Writes `data` as a hash. Nil values are dropped, since redis has no null.
export async function hset(key: string, data: Record<string, unknown>): Promise<Reply> {
  const args: string[] = [];
  for (const field of Object.keys(data)) {
    const value = data[field];
    if (value === undefined || value === null) continue;
    args.push(field, String(value));
  }

  if (args.length === 0) return null;
  return requireClient().command(["HSET", key, ...args]);
}

// The hash as a map of string keys, or null when it does not exist.
export async function hgetall(key: string): Promise<Record<string, string> | null> {
  try {
    const reply = await requireClient().command(["HGETALL", key]);
    if (!Array.isArray(reply) || reply.length === 0) return null;

    const out: Record<string, string> = {};
    for (let index = 0; index + 1 < reply.length; index += 2) {
      out[String(reply[index])] = String(reply[index + 1]);
    }
    return Object.keys(out).length === 0 ? null : out;
  } catch (cause) {
    log.warn({ hint: "redis command failed", cause });
    return null;
  }
}

export function expire(key: string, seconds: number): Promise<Reply> {
  return requireClient().command(["EXPIRE", key, seconds]);
}

export function del(key: string): Promise<Reply> {
  return requireClient().command(["DEL", key]);
}

// Every key matching `pattern`, walked in cursor batches so a large keyspace is
// never blocked the way KEYS would block it.
export async function scan(pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";

  for (;;) {
    let reply: Reply;
    try {
      reply = await requireClient().command(["SCAN", cursor, "MATCH", pattern, "COUNT", 200]);
    } catch (cause) {
      log.warn({ hint: "redis command failed", cause });
      return found;
    }

    if (!Array.isArray(reply) || reply.length < 2) return found;

    cursor = String(reply[0]);
    if (Array.isArray(reply[1])) found.push(...reply[1].map((key) => String(key)));
    if (cursor === "0") return found;
  }
}