// app.version: the stamp the build script leaves behind.

import { describe, expect, it } from "vitest";
import { parseVersion, version } from "./version.js";

describe("parseVersion", () => {
  it("splits a release stamp", () => {
    expect(parseVersion("1.19.4")).toEqual({
      full: "1.19.4",
      branch: undefined,
      base: "1.19.4",
      main: "1.19",
      major: "1",
      minor: "19",
      patch: "4",
      modifier: undefined,
      commit: undefined,
      "commit-hash": undefined,
    });
  });

  it("keeps the modifier", () => {
    expect(parseVersion("1.19.4-RC1")).toMatchObject({
      full: "1.19.4-RC1",
      base: "1.19.4",
      modifier: "RC1",
    });
  });

  it("reads the branch and the commit", () => {
    expect(parseVersion("penpot-1.19.4-3-gabc123")).toMatchObject({
      branch: "penpot",
      commit: "3",
      "commit-hash": "abc123",
    });
  });

  it("treats develop and the build placeholder as develop", () => {
    const develop = {
      full: "develop",
      branch: "develop",
      base: "0.0.0",
      main: "0.0",
      major: "0",
      minor: "0",
      patch: "0",
    };

    expect(parseVersion("develop")).toMatchObject(develop);
    expect(parseVersion("%version%")).toMatchObject(develop);
  });

  it("exposes the bundled stamp", () => {
    expect(version.full).toBe("develop");
  });
});