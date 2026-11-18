// app.util.mime: the export type table.

import { describe, expect, it } from "vitest";
import { get, getExtension, type ExportType } from "./mime.js";

describe("mime", () => {
  it("maps every export type", () => {
    const types: ExportType[] = ["png", "jpeg", "webp", "svg", "pdf", "zip"];

    expect(types.map(getExtension)).toEqual([".png", ".jpg", ".webp", ".svg", ".pdf", ".zip"]);
    expect(types.map(get)).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/svg+xml",
      "application/pdf",
      "application/zip",
    ]);
  });
});