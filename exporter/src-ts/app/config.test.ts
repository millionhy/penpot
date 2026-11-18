// app.config: env decoding, validation and the management key.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig, readEnv } from "./config.js";

describe("readEnv", () => {
  it("maps PENPOT_FOO_BAR to foo-bar", () => {
    expect(
      readEnv({ PENPOT_SECRET_KEY: "s", PENPOT_HTTP_SERVER_PORT: "80", OTHER: "x" }),
    ).toEqual({ "secret-key": "s", "http-server-port": "80" });
  });
});

describe("loadConfig", () => {
  it("applies the defaults", () => {
    const config = loadConfig({ PENPOT_SECRET_KEY: "s" });

    expect(config).toMatchObject({
      "public-uri": "http://localhost:3449",
      tenant: "default",
      host: "localhost",
      "http-server-port": 6061,
      "http-server-host": "0.0.0.0",
      tempdir: "/tmp/penpot",
      "redis-uri": "redis://redis/0",
      "exporter-max-concurrent-jobs": 4,
      "exporter-job-ttl": 3600,
      "wasm-worker-image-cache-size": 134217728,
    });
    expect(config.flags.size).toBe(0);
  });

  it("decodes the numbers and the flag list", () => {
    const config = loadConfig({
      PENPOT_SECRET_KEY: "s",
      PENPOT_HTTP_SERVER_PORT: "7000",
      PENPOT_FLAGS: "enable-exporter-svgo disable-other",
    });

    expect(config["http-server-port"]).toBe(7000);
    expect(config.flags.has("exporter-svgo")).toBe(true);
    expect(config.flags.has("other")).toBe(false);
  });

  it("keeps internal-uri optional", () => {
    expect(loadConfig({ PENPOT_SECRET_KEY: "s" })["internal-uri"]).toBeUndefined();
  });

  it("requires a secret key", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/secret-key/);
  });

  it("rejects a malformed number", () => {
    expect(() => loadConfig({ PENPOT_SECRET_KEY: "s", PENPOT_HTTP_SERVER_PORT: "12abc" })).toThrow(
      /http-server-port/,
    );
  });

  it("rejects a negative number", () => {
    expect(() => loadConfig({ PENPOT_SECRET_KEY: "s", PENPOT_EXPORTER_JOB_TTL: "-1" })).toThrow(
      /exporter-job-ttl/,
    );
  });

  it("rejects a malformed uri", () => {
    expect(() => loadConfig({ PENPOT_SECRET_KEY: "s", PENPOT_PUBLIC_URI: "nope" })).toThrow(/public-uri/);
  });
});

describe("managementKey", () => {
  afterEach(() => {
    delete process.env.PENPOT_SECRET_KEY;
    delete process.env.PENPOT_EXPORTER_SHARED_KEY;
    vi.resetModules();
  });

  it("prefers the explicit shared key", async () => {
    vi.resetModules();
    process.env.PENPOT_SECRET_KEY = "secret";
    process.env.PENPOT_EXPORTER_SHARED_KEY = "shared";

    const { managementKey } = await import("./config.js");

    expect(managementKey()).toBe("shared");
  });

  it("derives a url-safe key from the secret", async () => {
    vi.resetModules();
    process.env.PENPOT_SECRET_KEY = "secret";

    const { managementKey } = await import("./config.js");
    const key = managementKey();

    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(managementKey()).toBe(key);
  });
});