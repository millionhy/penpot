import { describe, expect, it } from "vitest";
import { parseSseBlocks } from "@/lib/rpc";

// The blocks the backend sends for the bulk trash commands
// (app.rpc.commands.files): a "progress" block per file, then "end".
describe("parseSseBlocks", () => {
  it("reads a complete block", () => {
    const { blocks, rest } = parseSseBlocks('event: progress\ndata: {"~:index":1}\n\n');
    expect(blocks).toEqual([{ type: "progress", data: '{"~:index":1}' }]);
    expect(rest).toBe("");
  });

  it("reads several blocks at once and keeps their order", () => {
    const text =
      'event: progress\ndata: {"~:index":1}\n\n' +
      'event: progress\ndata: {"~:index":2}\n\n' +
      'event: end\ndata: {"~#set":[]}\n\n';
    expect(parseSseBlocks(text).blocks.map((block) => block.type)).toEqual([
      "progress",
      "progress",
      "end",
    ]);
  });

  it("hands back the trailing text of an incomplete block", () => {
    const { blocks, rest } = parseSseBlocks('event: progress\ndata: {"~:in');
    expect(blocks).toEqual([]);
    expect(rest).toBe('event: progress\ndata: {"~:in');
  });

  it("resumes across a chunk boundary", () => {
    const first = parseSseBlocks('event: progress\ndata: {"~:in');
    const second = parseSseBlocks(first.rest + 'dex":1}\n\nevent: end\ndata: 1\n\n');
    expect(second.blocks).toEqual([
      { type: "progress", data: '{"~:index":1}' },
      { type: "end", data: "1" },
    ]);
    expect(second.rest).toBe("");
  });

  it("defaults the event type to message and joins repeated data fields", () => {
    const { blocks } = parseSseBlocks("data: one\ndata: two\n\n");
    expect(blocks).toEqual([{ type: "message", data: "one\ntwo" }]);
  });

  it("drops comments, keep-alives and the single space after the colon", () => {
    const { blocks } = parseSseBlocks(": ping\n\n\nevent:end\ndata:no-space\n\n");
    expect(blocks).toEqual([
      { type: "end", data: "no-space" },
    ]);
  });

  it("accepts CRLF line and block endings", () => {
    const { blocks } = parseSseBlocks("event: progress\r\ndata: 1\r\n\r\n");
    expect(blocks).toEqual([{ type: "progress", data: "1" }]);
  });

  it("answers nothing for an empty buffer", () => {
    expect(parseSseBlocks("")).toEqual({ blocks: [], rest: "" });
  });
});
