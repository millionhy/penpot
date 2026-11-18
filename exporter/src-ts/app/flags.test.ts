// app.flags: the enable-/disable- list applied left to right.

import { describe, expect, it } from "vitest";
import { hasFlag, parseFlags } from "./flags.js";

describe("parseFlags", () => {
  it("reads a comma or space separated list", () => {
    expect(Array.from(parseFlags("enable-a,disable-b enable-c"))).toEqual(["a", "c"]);
  });

  it("applies later entries last", () => {
    expect(parseFlags("enable-a disable-a").size).toBe(0);
    expect(Array.from(parseFlags("disable-a enable-a"))).toEqual(["a"]);
  });

  it("accepts an array and keyword literals", () => {
    expect(Array.from(parseFlags(["enable-a", ":enable-b"]))).toEqual(["a", "b"]);
  });

  it("ignores names without a prefix", () => {
    expect(parseFlags("a enable-b").has("a")).toBe(false);
    expect(Array.from(parseFlags("a enable-b"))).toEqual(["b"]);
  });

  it("returns an empty set for a missing value", () => {
    expect(parseFlags(undefined).size).toBe(0);
    expect(parseFlags(null).size).toBe(0);
    expect(parseFlags("").size).toBe(0);
  });
});

describe("hasFlag", () => {
  it("checks membership", () => {
    expect(hasFlag(new Set(["a"]), "a")).toBe(true);
    expect(hasFlag(new Set(["a"]), "b")).toBe(false);
  });
});