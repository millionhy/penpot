// normalizeHexInput (lib/hex-input.ts): the color row's hex field accepts a
// three or six digit hex with or without a leading "#", in any case, and
// rejects anything else so a bad draft never commits.

import { describe, expect, it } from "vitest";

import { normalizeHexInput } from "@/lib/hex-input";

describe("normalizeHexInput", () => {
  it("passes a six-digit hex through, lowercased", () => {
    expect(normalizeHexInput("123456")).toBe("#123456");
    expect(normalizeHexInput("#AbCdEf")).toBe("#abcdef");
  });

  it("expands a three-digit shorthand", () => {
    expect(normalizeHexInput("fff")).toBe("#ffffff");
    expect(normalizeHexInput("#abc")).toBe("#aabbcc");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeHexInput("  FF00AA ")).toBe("#ff00aa");
  });

  it("rejects anything that is not a three or six digit hex", () => {
    expect(normalizeHexInput("")).toBeNull();
    expect(normalizeHexInput("#")).toBeNull();
    expect(normalizeHexInput("12345")).toBeNull();
    expect(normalizeHexInput("1234567")).toBeNull();
    expect(normalizeHexInput("gggggg")).toBeNull();
    expect(normalizeHexInput("red")).toBeNull();
  });
});
