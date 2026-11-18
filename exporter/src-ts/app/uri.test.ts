// app.uri: the base/join/query moves the renderers rely on.

import { describe, expect, it } from "vitest";
import { ensurePathSlash, getDomain, join, mapToQueryString, queryStringToMap, withQuery } from "./uri.js";

describe("ensurePathSlash", () => {
  it("adds the trailing slash only when missing", () => {
    expect(ensurePathSlash("http://localhost:3449/app").pathname).toBe("/app/");
    expect(ensurePathSlash("http://localhost:3449/app/").pathname).toBe("/app/");
    expect(ensurePathSlash(new URL("http://localhost:3449")).pathname).toBe("/");
  });
});

describe("join", () => {
  it("resolves relative to the base path", () => {
    expect(join(ensurePathSlash("http://localhost:3449/app"), "render.html").href).toBe(
      "http://localhost:3449/app/render.html",
    );
    expect(join("http://localhost:3449/", "api/export").pathname).toBe("/api/export");
  });
});

describe("getDomain", () => {
  it("keeps a non-default port", () => {
    expect(getDomain(new URL("http://localhost:3449"))).toBe("localhost:3449");
    expect(getDomain(new URL("https://penpot.app"))).toBe("penpot.app");
  });
});

describe("mapToQueryString", () => {
  it("drops nils and repeats a key for a list", () => {
    const query = mapToQueryString({
      "file-id": "f",
      "object-id": ["a", "b"],
      page: undefined,
      missing: null,
      n: 1,
    });

    expect(query).toBe("file-id=f&object-id=a&object-id=b&n=1");
  });

  it("escapes values", () => {
    expect(mapToQueryString({ name: "a b&c" })).toBe("name=a+b%26c");
  });
});

describe("queryStringToMap", () => {
  it("reads the pairs into a flat record", () => {
    expect(queryStringToMap("a=1&b=2")).toEqual({ a: "1", b: "2" });
    expect(queryStringToMap("")).toEqual({});
  });
});

describe("withQuery", () => {
  it("replaces and clears the query", () => {
    const base = new URL("http://localhost:3449/render.html?old=1");

    expect(withQuery(base, "a=1").href).toBe("http://localhost:3449/render.html?a=1");
    expect(withQuery(base, "").href).toBe("http://localhost:3449/render.html");
  });
});