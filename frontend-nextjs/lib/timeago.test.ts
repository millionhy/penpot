// Unit tests for the relative time stamp (the timeago port). The expected
// strings are asserted through the same Intl.RelativeTimeFormat the module
// uses, so the suite passes whatever locale the platform resolves; the
// granularity picks and the input normalization are what this pins down.

import { describe, expect, it } from "vitest";

import { timeAgo } from "@/lib/timeago";

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

function reference(offsetMs: number): string {
  const seconds = Math.round(offsetMs / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, unitSeconds] of units) {
    if (Math.abs(seconds) >= unitSeconds || unit === "second") {
      return format.format(Math.round(seconds / unitSeconds), unit);
    }
  }
  return "";
}

describe("timeAgo", () => {
  it("renders Date and ISO instants through the coarsest fitting unit", () => {
    expect(timeAgo(new Date(NOW - 5 * 60_000), NOW)).toBe(reference(-5 * 60_000));
    expect(timeAgo(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe(
      reference(-3 * 3_600_000),
    );
    expect(timeAgo(new Date(NOW - 10 * 86_400_000), NOW)).toBe(reference(-10 * 86_400_000));
  });

  it("lands on the seconds granularity under a minute", () => {
    expect(timeAgo(new Date(NOW - 40_000), NOW)).toBe(reference(-40_000));
  });

  it("keeps future instants relative too", () => {
    expect(timeAgo(new Date(NOW + 60_000), NOW)).toBe(reference(60_000));
  });

  it("returns the empty string for missing or unparseable instants", () => {
    expect(timeAgo(null, NOW)).toBe("");
    expect(timeAgo(undefined, NOW)).toBe("");
    expect(timeAgo("not-a-date", NOW)).toBe("");
  });
});
