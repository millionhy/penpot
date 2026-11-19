// app.wasm.init: the loader boots the artifact and registers the enum table
// that ships beside it.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import * as wasm from "../wasm.js";
import { SERIALIZER_EXPORTS, serializers, setSerializers } from "./enums.js";

let dir: string | undefined;

// A directory shaped like `resources/wasm`: the emscripten glue, the bytes and
// the enum module. The glue returns a module whose only real call is
// `_init_headless`, which is all `init` needs beyond the imports.
function fixture(options: { missing?: string } = {}): string {
  const target = mkdtempSync(path.join(tmpdir(), "penpot-wasm-"));
  dir = target;

  writeFileSync(path.join(target, "package.json"), '{"type":"module"}');
  writeFileSync(path.join(target, "render-wasm.wasm"), "wasm-bytes");
  writeFileSync(
    path.join(target, "render-wasm.js"),
    `export default async function create() {
       const created = {
         HEAPU8: new Uint8Array(64),
         HEAPU32: new Uint32Array(16),
         calls: [],
       };
       created._init_headless = (width, height) => created.calls.push([width, height]);
       return created;
     }`,
  );

  const body = SERIALIZER_EXPORTS.filter(([, name]) => name !== options.missing)
    .map(([key, name]) => `export const ${name} = { "${key}": 1 };`)
    .join("\n");
  writeFileSync(path.join(target, "shared.js"), `${body}\n`);

  return target;
}

afterEach(() => {
  wasm.reset();
  setSerializers(undefined);
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("init", () => {
  it("boots the artifact and registers shared.js", async () => {
    const module = (await wasm.init(640, 480, fixture())) as unknown as {
      calls: number[][];
    };

    expect(module.calls).toEqual([[640, 480]]);
    expect(serializers()["raster-format"]).toEqual({ "raster-format": 1 });
  });

  it("refuses a shared.js that misses an export", async () => {
    try {
      await wasm.init(640, 480, fixture({ missing: "RawFillRule" }));
      expect.unreachable();
    } catch (cause) {
      expect(cause).toBeInstanceOf(AppError);
      expect((cause as AppError).data).toMatchObject({ code: "stale-wasm-enums" });
    }
  });
});