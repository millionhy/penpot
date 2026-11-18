// app.util.shell: temp files, the deletion schedule and the external commands.

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dir = path.join(tmpdir(), `penpot-exporter-test-${process.pid}`);

let shell: typeof import("./shell.js");

beforeAll(async () => {
  process.env.PENPOT_SECRET_KEY = "test-secret";
  process.env.PENPOT_TEMPDIR = dir;
  shell = await import("./shell.js");
});

afterAll(() => {
  delete process.env.PENPOT_SECRET_KEY;
  delete process.env.PENPOT_TEMPDIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("getTmpdir", () => {
  it("creates the configured directory", () => {
    expect(shell.getTmpdir()).toBe(dir);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("tempfile", () => {
  it("hands out a free path without creating it", () => {
    vi.useFakeTimers();
    try {
      const file = shell.tempfile({ suffix: ".png" });

      expect(path.dirname(file)).toBe(dir);
      expect(path.basename(file)).toMatch(/^penpot\.[0-9a-f-]{36}-\d+\.png$/);
      expect(existsSync(file)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scheduleDeletion", () => {
  it("removes the file when the timer fires", async () => {
    const file = shell.tempfile();
    await shell.writeFile(file, "x");

    vi.useFakeTimers();
    try {
      shell.scheduleDeletion(file, 0);
      vi.advanceTimersByTime(0);
    } finally {
      vi.useRealTimers();
    }

    expect(existsSync(file)).toBe(false);
  });
});

describe("file helpers", () => {
  it("writes, stats, reads and removes", async () => {
    const file = shell.tempfile();
    await shell.writeFile(file, "hello");

    const stat = (await shell.stat(file))!;
    expect(stat).toMatchObject({ path: file, size: 5 });
    expect(stat["created-at"]).toBeGreaterThan(0);
    expect((await shell.readFile(file)).toString()).toBe("hello");

    await shell.rmdir(file);
    expect(await shell.stat(file)).toBeNull();
  });

  it("reports a missing path as nil", async () => {
    expect(await shell.stat(path.join(dir, "nope"))).toBeNull();
  });

  it("moves a file", async () => {
    const from = shell.tempfile();
    const to = shell.tempfile();
    await shell.writeFile(from, "data");

    await shell.move(from, to);

    expect(existsSync(from)).toBe(false);
    expect((await shell.readFile(to)).toString()).toBe("data");
  });
});

describe("runCmd", () => {
  it("returns stdout as a buffer", async () => {
    const out = await shell.runCmd(process.execPath, ["-e", "process.stdout.write('ok')"]);

    expect(out.toString()).toBe("ok");
  });
});