import { globSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { SERIALIZER_EXPORTS, SERIALIZERS, serializers } from "./enums";

const keys = SERIALIZER_EXPORTS.map(([key]) => key);

describe("serializers", () => {
  it("answers one table per serializer key and nothing else", () => {
    expect(Object.keys(SERIALIZERS).sort()).toEqual([...keys].sort());
  });

  it("is the table the accessor hands out", () => {
    expect(serializers()).toBe(SERIALIZERS);
  });

  it("keeps the discriminants the serializers write", () => {
    // Spot values from render-wasm/src/enums.rs; the drift check below covers
    // the rest whenever a Rust build is around.
    expect(SERIALIZERS["shape-type"].rect).toBe(3);
    expect(SERIALIZERS["fill-data"].image).toBe(3);
    expect(SERIALIZERS["blend-mode"].normal).toBe(3);
    expect(SERIALIZERS["segment-data"]["move-to"]).toBe(1);
    expect(SERIALIZERS["constraint-h"].leftright).toBe(3);
  });
});

// The Rust build emits render_wasm_shared.js next to the artifact. Any local
// build (either target) leaves one under render-wasm/target, and diffing
// against it turns a stale inlined table into a test failure instead of
// silently wrong pixels.
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const built = globSync(
  "render-wasm/target/*/wasm32-unknown-emscripten/*/build/*/out/render_wasm_shared.js",
  { cwd: repoRoot },
);

describe.skipIf(built.length === 0)("against a Rust build", () => {
  it("matches the enum table the build emitted", async () => {
    const file = path.resolve(repoRoot, built[0]);
    const emitted = (await import(pathToFileURL(file).href)) as Record<string, unknown>;

    for (const [key, exportName] of SERIALIZER_EXPORTS) {
      expect(emitted[exportName], `${exportName} missing from ${built[0]}`).toBeDefined();
      expect(SERIALIZERS[key], `${key} drifted from ${exportName}`).toEqual(
        emitted[exportName],
      );
    }
  });
});
