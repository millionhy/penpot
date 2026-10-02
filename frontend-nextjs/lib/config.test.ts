import { describe, expect, it } from "vitest";
import { config, hasFlag, parseFlags } from "@/lib/config";

describe("parseFlags", () => {
  it("adds the name behind an enable- token", () => {
    expect([...parseFlags(["enable-registration"])]).toEqual(["registration"]);
  });

  it("removes the name behind a disable- token", () => {
    expect([...parseFlags(["disable-registration"], ["registration", "login"])]).toEqual(["login"]);
  });

  it("ignores a bare token, like flags/parse does", () => {
    expect([...parseFlags(["registration"], [])]).toEqual([]);
  });

  it("applies tokens in order", () => {
    expect([...parseFlags(["enable-x", "disable-x"], [])]).toEqual([]);
    expect([...parseFlags(["disable-x", "enable-x"], [])]).toEqual(["x"]);
  });
});

describe("config.flags", () => {
  // The defaults of common/src/app/common/flags.cljc decide whether the auth
  // pages render at all, so an unconfigured shell must behave like a stock
  // self-hosted deployment.
  it("starts from the penpot defaults", () => {
    expect(hasFlag("registration")).toBe(true);
    expect(hasFlag("login-with-password")).toBe(true);
    expect(hasFlag("email-verification")).toBe(true);
  });

  it("exposes the flags as a plain list", () => {
    expect(Array.isArray(config.flags)).toBe(true);
    expect(config.flags).toContain("registration");
  });

  it("leaves the legal links unset unless the environment provides them", () => {
    expect(config.termsOfServiceUri === null || typeof config.termsOfServiceUri === "string").toBe(
      true,
    );
  });
});
