// Unit tests for the TypeScript mirror of the generic predicates in
// app.common.schema. The cases pin the ClojureScript semantics that the
// file-change validator relies on.

import { describe, expect, it } from "vitest";

import {
  EMAIL_PATTERN,
  MAX_SAFE_INT,
  MIN_SAFE_INT,
  UUID_PATTERN,
  isEmail,
  isMap,
  isSafeInt,
  isSafeNumber,
  isText,
  isUuid,
  oneOf,
} from "@/lib/common/schema";

describe("isUuid", () => {
  it("accepts the canonical form in either case", () => {
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(true);
    expect(isUuid("ABCDEF01-2345-6789-abcd-ef0123456789")).toBe(true);
  });

  it("rejects malformed values", () => {
    expect(isUuid("12345678-9abc-def0-1122-33445566778")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(123)).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(UUID_PATTERN.test("11111111-2222-3333-4444-555555555555")).toBe(true);
  });
});

describe("safe numbers", () => {
  it("keeps the Integer/MAX_VALUE bounds of ::sm/safe-int", () => {
    expect(MAX_SAFE_INT).toBe(2147483647);
    expect(MIN_SAFE_INT).toBe(-2147483648);
    expect(isSafeInt(MAX_SAFE_INT)).toBe(true);
    expect(isSafeInt(MIN_SAFE_INT)).toBe(true);
    expect(isSafeInt(MAX_SAFE_INT + 1)).toBe(false);
    expect(isSafeInt(MIN_SAFE_INT - 1)).toBe(false);
  });

  it("rejects fractions, NaN and infinities for integers", () => {
    expect(isSafeInt(1.5)).toBe(false);
    expect(isSafeInt(Number.NaN)).toBe(false);
    expect(isSafeInt(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isSafeInt("1")).toBe(false);
  });

  it("accepts in-range numbers and finite fractions", () => {
    expect(isSafeNumber(0.25)).toBe(true);
    expect(isSafeNumber(-2147483648)).toBe(true);
    expect(isSafeNumber(2147483647)).toBe(true);
    expect(isSafeNumber(2147483648)).toBe(false);
    expect(isSafeNumber(Number.NaN)).toBe(false);
    expect(isSafeNumber(Number.NEGATIVE_INFINITY)).toBe(false);
  });
});

describe("isText", () => {
  it("requires a non-blank string", () => {
    expect(isText("Home")).toBe(true);
    expect(isText("  padded  ")).toBe(true);
    expect(isText("   ")).toBe(false);
    expect(isText("")).toBe(false);
    expect(isText(1)).toBe(false);
  });
});

describe("isEmail", () => {
  it("matches the schema email regex", () => {
    expect(isEmail("member@example.com")).toBe(true);
    expect(isEmail("first.last+tag@sub.example.co")).toBe(true);
    expect(isEmail("missing-at.example.com")).toBe(false);
    expect(isEmail("member@example")).toBe(false);
    expect(isEmail(null)).toBe(false);
    expect(EMAIL_PATTERN.test("member@example.com")).toBe(true);
  });
});

describe("isMap", () => {
  it("accepts plain records and rejects arrays, null and primitives", () => {
    expect(isMap({})).toBe(true);
    expect(isMap({ type: "add-page" })).toBe(true);
    expect(isMap([])).toBe(false);
    expect(isMap(null)).toBe(false);
    expect(isMap("map")).toBe(false);
  });
});

describe("oneOf", () => {
  it("builds the ::sm/one-of membership predicate", () => {
    const isSide = oneOf(["left", "right"] as const);
    expect(isSide("left")).toBe(true);
    expect(isSide("right")).toBe(true);
    expect(isSide("center")).toBe(false);
    expect(isSide(null)).toBe(false);
  });
});
