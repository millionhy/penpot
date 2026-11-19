// The legacy export command table: both commands, and the shared envelope.

import { describe, expect, it } from "vitest";

import { errorData } from "../errors.js";
import { createExportCommands } from "./commands.js";
import { conformParams } from "./export.js";

const FILE = "11111111-1111-1111-1111-111111111111";
const PAGE = "22222222-2222-2222-2222-222222222222";
const OBJECT = "33333333-3333-3333-3333-333333333333";
const PROFILE = "44444444-4444-4444-4444-444444444444";

function shapeParams(): Record<string, unknown> {
  return {
    cmd: "export-shapes",
    "profile-id": PROFILE,
    exports: [
      {
        "file-id": FILE,
        "page-id": PAGE,
        "object-id": OBJECT,
        name: "Board",
        suffix: "",
        scale: 2,
        type: "png",
        filename: "Board.png",
      },
    ],
  };
}

function frameParams(): Record<string, unknown> {
  return {
    cmd: "export-frames",
    "profile-id": PROFILE,
    exports: [{ "file-id": FILE, "page-id": PAGE, "object-id": OBJECT, name: "Frame A" }],
  };
}

describe("createExportCommands", () => {
  it("registers both legacy commands", () => {
    expect(Object.keys(createExportCommands()).sort()).toEqual(["export-frames", "export-shapes"]);
  });

  it("validates shapes through the shared envelope", () => {
    const params = conformParams(createExportCommands(), shapeParams());

    expect(params.cmd).toBe("export-shapes");
  });

  it("validates frames through the shared envelope", () => {
    const params = conformParams(createExportCommands(), frameParams());

    expect(params.cmd).toBe("export-frames");
  });

  it("keeps rejecting an unknown command", () => {
    try {
      conformParams(createExportCommands(), { cmd: "export-nothing", "profile-id": PROFILE });
      throw new Error("expected a rejection");
    } catch (cause) {
      expect(errorData(cause).problems).toContainEqual({
        path: ["cmd"],
        pred: "unknown export command: export-nothing",
      });
    }
  });
});
