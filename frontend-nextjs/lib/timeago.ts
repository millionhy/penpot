// Port of app.common.time/timeago: the relative "3 minutes ago" stamp the
// comment cards show. The CLJS delegates to date-fns distanceToNow with
// addSuffix; the browser's Intl.RelativeTimeFormat replaces date-fns here —
// the same phrasing, localized by the platform, no new dependency. nowMs is
// injectable so the tests do not depend on the clock.

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

// The instant arrives as a Date (the transit "~m" reader) or an ISO string
// (JSON fixtures), like everywhere else on this boundary; null-ish and
// unparseable values render as the empty string.
export function timeAgo(value: Date | string | null | undefined, nowMs?: number): string {
  if (value === null || value === undefined) return "";
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ms)) return "";

  const now = nowMs ?? Date.now();
  const seconds = Math.round((ms - now) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, unitSeconds] of UNITS) {
    if (Math.abs(seconds) >= unitSeconds || unit === "second") {
      return format.format(Math.round(seconds / unitSeconds), unit);
    }
  }
  return "";
}
