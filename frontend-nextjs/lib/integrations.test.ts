import { describe, expect, it } from "vitest";
import {
  createTokenParams,
  expirationOptions,
  findMcpToken,
  formatTokenDate,
  mcpEnabled,
  mcpServerUrl,
  tokenSubtitle,
  tokenValid,
  userTokens,
  type AccessToken,
} from "@/lib/integrations";

function token(overrides: Partial<AccessToken> = {}): AccessToken {
  return { id: "t1", name: "Token", ...overrides };
}

describe("userTokens", () => {
  it("keeps only the rows without a type", () => {
    const mcp = token({ id: "m1", type: "mcp" });
    const plain = token({ id: "t2" });
    const other = token({ id: "t3", type: "other" });
    expect(userTokens([mcp, plain, other]).map((row) => row.id)).toEqual(["t2"]);
  });

  it("treats an absent list as empty", () => {
    expect(userTokens(null)).toEqual([]);
  });
});

describe("findMcpToken", () => {
  it("returns the first mcp row", () => {
    const first = token({ id: "m1", type: "mcp" });
    const second = token({ id: "m2", type: "mcp" });
    expect(findMcpToken([token({ id: "t1" }), first, second])).toBe(first);
  });

  it("returns null when no row is an mcp key", () => {
    expect(findMcpToken([token()])).toBeNull();
    expect(findMcpToken(null)).toBeNull();
  });
});

describe("tokenValid", () => {
  const now = new Date("2026-10-09T12:00:00Z");

  it("accepts a token without an expiration date", () => {
    expect(tokenValid(token(), now)).toBe(true);
    expect(tokenValid(token({ "expires-at": null }), now)).toBe(true);
  });

  it("compares the expiration instant strictly", () => {
    expect(tokenValid(token({ "expires-at": new Date("2026-10-09T12:00:01Z") }), now)).toBe(true);
    expect(tokenValid(token({ "expires-at": new Date("2026-10-09T12:00:00Z") }), now)).toBe(false);
    expect(tokenValid(token({ "expires-at": new Date("2026-10-09T11:59:59Z") }), now)).toBe(false);
  });

  it("rejects null tokens", () => {
    expect(tokenValid(null, now)).toBe(false);
  });
});

describe("mcpEnabled", () => {
  it("reads the profile prop as a boolean", () => {
    expect(mcpEnabled({ props: { "mcp-enabled": true } })).toBe(true);
    expect(mcpEnabled({ props: { "mcp-enabled": false } })).toBe(false);
    expect(mcpEnabled({ props: {} })).toBe(false);
    expect(mcpEnabled(null)).toBe(false);
  });
});

describe("createTokenParams", () => {
  it("omits the expiration for 'never'", () => {
    expect(createTokenParams({ name: "CI", expiration: "never", isMcp: false })).toEqual({
      name: "CI",
    });
  });

  it("sends the duration presets as-is", () => {
    expect(createTokenParams({ name: "CI", expiration: "720h", isMcp: false })).toEqual({
      name: "CI",
      expiration: "720h",
    });
  });

  it("forces the MCP name and type", () => {
    expect(createTokenParams({ name: "ignored", expiration: "1440h", isMcp: true })).toEqual({
      name: "MCP key",
      expiration: "1440h",
      type: "mcp",
    });
    expect(createTokenParams({ name: "ignored", expiration: "never", isMcp: true })).toEqual({
      name: "MCP key",
      type: "mcp",
    });
  });

  it("offers never plus the four duration presets", () => {
    expect(expirationOptions.map((option) => option.value)).toEqual([
      "never",
      "720h",
      "1440h",
      "2160h",
      "4320h",
    ]);
  });
});

describe("mcpServerUrl", () => {
  it("appends the stream path to the public uri", () => {
    expect(mcpServerUrl("http://localhost:3449", "abc")).toBe(
      "http://localhost:3449/mcp/stream?userToken=abc",
    );
  });

  it("does not double the slash", () => {
    expect(mcpServerUrl("http://localhost:3449/", "abc")).toBe(
      "http://localhost:3449/mcp/stream?userToken=abc",
    );
  });

  it("encodes the key for the query string", () => {
    expect(mcpServerUrl("https://penpot.example", "a+b/c")).toBe(
      "https://penpot.example/mcp/stream?userToken=a%2Bb%2Fc",
    );
  });
});

describe("formatTokenDate", () => {
  it("renders the long date of ct/format-inst 'PPP'", () => {
    expect(formatTokenDate(new Date("2026-10-09T12:00:00Z"))).toBe("October 9, 2026");
  });

  it("returns null for absent instants", () => {
    expect(formatTokenDate(null)).toBeNull();
    expect(formatTokenDate(undefined)).toBeNull();
  });
});

describe("tokenSubtitle", () => {
  const now = new Date("2026-10-09T12:00:00Z");

  it("reports no expiration date", () => {
    expect(tokenSubtitle(token(), now)).toEqual({
      text: "No expiration date",
      warning: false,
    });
  });

  it("reports the upcoming expiration", () => {
    expect(tokenSubtitle(token({ "expires-at": new Date("2026-11-08T12:00:00Z") }), now)).toEqual({
      text: "Expires on November 8, 2026",
      warning: false,
    });
  });

  it("marks a passed expiration as a warning", () => {
    expect(tokenSubtitle(token({ "expires-at": new Date("2026-10-01T12:00:00Z") }), now)).toEqual({
      text: "Expired on October 1, 2026",
      warning: true,
    });
  });
});
