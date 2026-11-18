// A throwaway RESP2 server for the redis tests: enough of HSET, HGETALL,
// EXPIRE, DEL, SCAN, PUBLISH, SUBSCRIBE and QUIT to exercise app.redis and the
// job store without a real redis.

import { createServer, type Server, type Socket } from "node:net";

import { encodeCommand, parseReply, type Reply } from "../app/redis.js";

export interface MockRedis {
  port: number;
  hashes: Map<string, Map<string, string>>;
  close(): Promise<void>;
}

interface ClientState {
  subscriptions: Set<string>;
}

function bulk(value: string): string {
  return `$${Buffer.byteLength(value, "utf8")}\r\n${value}\r\n`;
}

function array(values: readonly string[]): string {
  return `*${values.length}\r\n${values.map(bulk).join("")}`;
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export async function startRedis(): Promise<MockRedis> {
  const hashes = new Map<string, Map<string, string>>();
  const clients = new Map<Socket, ClientState>();
  let subscribers = 0;

  function reply(socket: Socket, text: string): void {
    socket.write(text);
  }

  function publish(topic: string, payload: string): number {
    let receivers = 0;
    for (const [socket, state] of clients) {
      if (!state.subscriptions.has(topic)) continue;
      receivers += 1;
      reply(socket, `*3\r\n${bulk("message")}${bulk(topic)}${bulk(payload)}`);
    }
    return receivers;
  }

  function execute(socket: Socket, command: string[]): void {
    const name = (command[0] ?? "").toLowerCase();
    const args = command.slice(1);

    switch (name) {
      case "hset": {
        const [key, ...pairs] = args;
        let hash = hashes.get(key);
        if (hash === undefined) {
          hash = new Map();
          hashes.set(key, hash);
        }
        for (let index = 0; index + 1 < pairs.length; index += 2) hash.set(pairs[index], pairs[index + 1]);
        reply(socket, `:${pairs.length / 2}\r\n`);
        return;
      }
      case "hgetall": {
        const hash = hashes.get(args[0]);
        const flat: string[] = [];
        for (const [field, value] of hash ?? []) flat.push(field, value);
        reply(socket, array(flat));
        return;
      }
      case "expire":
      case "del": {
        if (name === "del") hashes.delete(args[0]);
        reply(socket, ":1\r\n");
        return;
      }
      case "scan": {
        const pattern = patternToRegExp(args[2] ?? "*");
        const keys = Array.from(hashes.keys()).filter((key) => pattern.test(key));
        // One batch, cursor back to 0: the multi-batch walk is covered by the
        // store test that seeds more than one job.
        reply(socket, `*2\r\n${bulk("0")}${array(keys)}`);
        return;
      }
      case "publish": {
        const receivers = publish(args[0], args[1]);
        reply(socket, `:${receivers}\r\n`);
        return;
      }
      case "subscribe": {
        const state = clients.get(socket);
        for (const topic of args) {
          state?.subscriptions.add(topic);
          subscribers += 1;
        }
        const last = args[args.length - 1] ?? "";
        reply(socket, `*3\r\n${bulk("subscribe")}${bulk(last)}:${subscribers}\r\n`);
        return;
      }
      case "quit": {
        reply(socket, "+OK\r\n");
        socket.end();
        return;
      }
      default: {
        reply(socket, "-ERR unknown command\r\n");
      }
    }
  }

  const server: Server = createServer((socket) => {
    clients.set(socket, { subscriptions: new Set() });
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

      for (;;) {
        const parsed = parseReply(buffer);
        if (parsed === undefined) return;

        buffer = buffer.subarray(parsed.next);
        const command = parsed.value;
        if (Array.isArray(command)) execute(socket, command.map((item) => String(item)));
      }
    });

    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    hashes,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of clients.keys()) socket.destroy();
        clients.clear();
        server.close(() => resolve());
      }),
  };
}

// Kept next to the server so a test can assert what the client put on the wire.
export function command(...args: readonly (string | number)[]): string {
  return encodeCommand(args);
}

export type { Reply };