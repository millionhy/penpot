// A hex color typed into the style panel's color row: it accepts three or
// six digits, with or without a leading "#", in any case, and normalizes to
// the "#rrggbb" the store holds. Anything else is not a color yet, so it
// reads as null and the caller keeps the draft instead of committing a value
// the store cannot hold. Pure, so it lives under lib/ and is unit-tested
// (D7).

export function normalizeHexInput(raw: string): string | null {
  const text = raw.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(text)) return null;
  const digits =
    text.length === 3
      ? text
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : text;
  if (digits.length !== 6) return null;
  return `#${digits.toLowerCase()}`;
}
