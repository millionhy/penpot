import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { call } from "./call";
import { EngineError } from "./errors";
import { alloc, free } from "./memory";
import {
  isContextInitialized,
  live,
  loadModule,
  markContextInitialized,
  markContextLost,
  markReloading,
  moduleOrThrow,
  moduleReady,
  preloadModule,
  ready,
  resetContextState,
  resetModule,
  type LoadModuleOptions,
  type ModuleFactory,
  type RenderWasmModule,
} from "./module";

function makeModule(overrides: Record<string, unknown> = {}): RenderWasmModule {
  return {
    HEAPU8: new Uint8Array(64),
    HEAPU32: new Uint32Array(16),
    HEAP32: new Int32Array(16),
    HEAPF32: new Float32Array(16),
    UTF8ToString: (ptr: number) => `#${ptr}`,
    _init: () => undefined,
    ...overrides,
  };
}

const options = (factory: ModuleFactory): LoadModuleOptions => ({
  jsUrl: "/js/render-wasm.js?version=test",
  wasmUrl: "/js/render-wasm.wasm?version=test",
  factory,
});

afterEach(() => resetModule());

describe("loadModule", () => {
  it("instantiates once and shares the module with every caller", async () => {
    const created = makeModule();
    const configs: Array<Parameters<ModuleFactory>[0]> = [];
    const factory: ModuleFactory = (config) => {
      configs.push(config);
      return created;
    };

    const first = loadModule(options(factory));
    const second = loadModule(options(factory));

    await expect(first).resolves.toBe(created);
    await expect(second).resolves.toBe(created);
    expect(configs).toHaveLength(1);
    expect(moduleReady()).toBe(true);
    expect(moduleOrThrow()).toBe(created);
  });

  it("joins concurrent callers to the in-flight load", async () => {
    const created = makeModule();
    let release: (module: RenderWasmModule) => void = () => undefined;
    let calls = 0;
    const factory: ModuleFactory = () => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    };

    const first = loadModule(options(factory));
    const second = loadModule(options(factory));
    expect(calls).toBe(1);

    release(created);

    await expect(first).resolves.toBe(created);
    await expect(second).resolves.toBe(created);
  });

  it("pins locateFile to the configured wasm URL and forwards printErr", async () => {
    let config: Parameters<ModuleFactory>[0] | undefined;
    const factory: ModuleFactory = (next) => {
      config = next;
      return makeModule();
    };
    const printErr = (): void => undefined;

    await loadModule({ ...options(factory), printErr });

    // The glue asks for "render-wasm.wasm?version=<tag>"; the engine answers
    // with the URL it was given, cache-busting query included.
    expect(config?.locateFile?.("render-wasm.wasm?version=test")).toBe(
      "/js/render-wasm.wasm?version=test",
    );
    expect(config?.printErr).toBe(printErr);
  });

  it("rejects a module without _init and does not cache it", async () => {
    const factory: ModuleFactory = () => makeModule({ _init: undefined });

    await expect(loadModule(options(factory))).rejects.toBeInstanceOf(EngineError);
    expect(moduleReady()).toBe(false);
    expect(() => moduleOrThrow()).toThrowError(
      expect.objectContaining({ code: "wasm-module-not-ready" }),
    );
  });

  it("retries after a failed load instead of caching the rejection", async () => {
    const created = makeModule();
    let attempt = 0;
    const factory: ModuleFactory = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      return created;
    };

    await expect(loadModule(options(factory))).rejects.toThrow("network down");
    await expect(loadModule(options(factory))).resolves.toBe(created);
    expect(attempt).toBe(2);
  });

  it("swallows preload failures and leaves the retry open", async () => {
    const created = makeModule();
    let attempt = 0;
    const factory: ModuleFactory = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      return created;
    };

    preloadModule(options(factory));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(loadModule(options(factory))).resolves.toBe(created);
  });
});

describe("readiness", () => {
  it("requires an initialized context, then a live one, then a settled reload", () => {
    expect(live()).toBe(false);
    expect(ready()).toBe(false);

    markContextInitialized();
    expect(isContextInitialized()).toBe(true);
    expect(live()).toBe(true);
    expect(ready()).toBe(true);

    markReloading();
    expect(live()).toBe(true);
    expect(ready()).toBe(false);

    markReloading(false);
    markContextLost();
    expect(live()).toBe(false);
    expect(ready()).toBe(false);

    markContextLost(false);
    expect(ready()).toBe(true);
  });

  it("keeps the loss and reload flags when the context state resets", () => {
    markContextInitialized();
    markContextLost();
    markReloading();

    resetContextState();

    expect(isContextInitialized()).toBe(false);
    // A restart mid-recovery must not look ready until the re-init finishes.
    expect(live()).toBe(false);
    expect(ready()).toBe(false);

    markContextLost(false);
    markReloading(false);
    markContextInitialized();
    expect(ready()).toBe(true);
  });
});

// The artifact is a build output (public/js is not committed). When it is
// present — a normal dev checkout with the frontend container built — boot
// the real module; on CI the block skips.
const artifactJs = path.resolve(import.meta.dirname, "../../../public/js/render-wasm.js");
const artifactWasm = path.resolve(import.meta.dirname, "../../../public/js/render-wasm.wasm");
const hasArtifact = existsSync(artifactJs) && existsSync(artifactWasm);

describe.skipIf(!hasArtifact)("against the built artifact", () => {
  it(
    "boots the emscripten glue and runs a headless init",
    async () => {
      const factory: ModuleFactory = async (config) => {
        const ns = (await import(pathToFileURL(artifactJs).href)) as {
          default: ModuleFactory;
        };
        return ns.default(config);
      };

      const target = await loadModule({
        jsUrl: artifactJs,
        wasmUrl: artifactWasm,
        factory,
        printErr: () => undefined,
      });

      expect(moduleReady()).toBe(true);
      expect(typeof target.UTF8ToString).toBe("function");
      expect(typeof target._read_error_code).toBe("function");
      expect(target.HEAPU8.length).toBeGreaterThan(0);

      // Headless init is the CPU-only boot: it proves the instance runs
      // without a GL context, and the allocator pair round-trips.
      call(target, "_init_headless", 1920, 1080);
      const ptr = alloc(target, 16);
      expect(ptr).toBeGreaterThan(0);
      free(target);
    },
    120_000,
  );
});
