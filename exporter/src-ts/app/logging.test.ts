// app.logging: the level thresholds and the key=value record shape.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, enabled, formatProps, setLevel } from "./logging.js";

describe("formatProps", () => {
  it("joins the pairs in order and skips undefined", () => {
    expect(formatProps({ hint: "welcome", n: 1, ok: true, nil: null, skip: undefined })).toBe(
      'hint="welcome", n=1, ok=true, nil=nil',
    );
  });

  it("renders an instant like the CLJS printer", () => {
    expect(formatProps({ at: new Date("2026-01-02T03:04:05.678Z") })).toBe('at=#inst "2026-01-02T03:04:05.678Z"');
  });
});

describe("enabled", () => {
  it("keeps the root threshold closed by default", () => {
    expect(enabled("test.silent.namespace", "info")).toBe(false);
    expect(enabled("test.silent.namespace", "error")).toBe(false);
  });

  it("inherits the parent threshold", () => {
    setLevel("test.parent", "warn");

    expect(enabled("test.parent", "warn")).toBe(true);
    expect(enabled("test.parent.child", "warn")).toBe(true);
    expect(enabled("test.parent.child", "info")).toBe(false);
  });
});

describe("createLogger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes the prefixed record", () => {
    const sink = vi.spyOn(console, "log").mockImplementation(() => {});
    setLevel("test.sink", "info");

    createLogger("test.sink").info({ hint: "welcome", module: "exporter" });

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatch(
      /^INF \d{2}:\d{2}:\d{2}\.\d{3} \[test\.sink\] hint="welcome", module="exporter"$/,
    );
  });

  it("stays quiet below the threshold", () => {
    const sink = vi.spyOn(console, "log").mockImplementation(() => {});

    createLogger("test.quiet").info({ hint: "nothing" });

    expect(sink).not.toHaveBeenCalled();
  });
});