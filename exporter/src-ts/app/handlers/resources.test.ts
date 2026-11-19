// app.handlers.resources: the ephemeral resource handle, the zip wrapper and
// the upload that turns the file into a backend tempfile.

import os from "node:os";
import path from "node:path";
import { writeFile as writeFileP, rm as rmP } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.PENPOT_SECRET_KEY = "test-secret";
process.env.PENPOT_INTERNAL_URI = "http://backend:6060";
process.env.PENPOT_PUBLIC_URI = "http://localhost:3449";
process.env.PENPOT_EXPORTER_SHARED_KEY = "shared-key";
process.env.PENPOT_TEMPDIR = path.join(os.tmpdir(), "penpot-exporter-resources");

const fakeFs = vi.hoisted(() => ({ stream: { kind: "zip-stream" } }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createWriteStream: vi.fn(() => fakeFs.stream) };
});

import { errorData } from "../errors.js";
import { encode } from "../transit.js";
import {
  addToZip,
  closeZip,
  create,
  createZip,
  setArchiverModule,
  uploadResource,
  type ResourceHandle,
} from "./resources.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Listener = (...args: unknown[]) => void;

class FakeZipArchive {
  handlers = new Map<string, Listener[]>();
  files: Array<{ path: string; options: unknown }> = [];
  piped: unknown[] = [];
  finalized = false;

  on(event: string, listener: Listener): this {
    const listeners = this.handlers.get(event) ?? [];
    listeners.push(listener);
    this.handlers.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.handlers.get(event) ?? []) listener(...args);
  }

  pipe(destination: unknown): void {
    this.piped.push(destination);
  }

  file(filePath: string, options: unknown): void {
    this.files.push({ path: filePath, options });
  }

  finalize(): void {
    this.finalized = true;
    this.emit("close");
  }
}

function handle(type: "png" | "zip" = "png"): ResourceHandle {
  return {
    id: "resource-id",
    name: "board",
    path: path.join(os.tmpdir(), `penpot.resource.${type}.resource-id`),
    filename: `board.${type}`,
    mtype: type === "png" ? "image/png" : "application/zip",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("create", () => {
  it("names the file after the resource and mimes it", () => {
    const resource = create("png", "my/board:1");

    expect(resource.id).toMatch(UUID);
    expect(resource.name).toBe("my/board:1");
    expect(resource.filename).toBe("my_board_1.png");
    expect(resource.mtype).toBe("image/png");
    expect(resource.path.endsWith(`penpot.resource.png.${resource.id}`)).toBe(true);
    expect(resource.path.startsWith(path.join(os.tmpdir(), "penpot-exporter-resources"))).toBe(true);
  });

  it("uses the extension and mime of each export type", () => {
    expect(create("jpeg", "board")).toMatchObject({ filename: "board.jpg", mtype: "image/jpeg" });
    expect(create("webp", "board")).toMatchObject({ filename: "board.webp", mtype: "image/webp" });
    expect(create("svg", "board")).toMatchObject({
      filename: "board.svg",
      mtype: "image/svg+xml",
    });
    expect(create("pdf", "board")).toMatchObject({
      filename: "board.pdf",
      mtype: "application/pdf",
    });
    expect(create("zip", "board")).toMatchObject({ filename: "board.zip", mtype: "application/zip" });
  });

  it("gives every resource its own id", () => {
    expect(create("png", "board").id).not.toBe(create("png", "board").id);
  });
});

describe("zip", () => {
  function setup(): { zip: FakeZipArchive; module: unknown } {
    const zip = new FakeZipArchive();
    // A constructor that returns an object hands that object to `new`.
    const ZipArchive = function ZipArchive() {
      return zip;
    } as unknown as new () => FakeZipArchive;
    return { zip, module: { ZipArchive } };
  }

  afterEach(() => {
    setArchiverModule(undefined);
  });

  it("pipes the archive to the resource file and reports the entries", async () => {
    const { zip, module } = setup();
    setArchiverModule(module as never);
    const progress: Array<{ done: number; filename: string }> = [];
    const complete = vi.fn();

    const archive = createZip({
      resource: handle("zip"),
      onProgress: (item) => progress.push(item),
      onComplete: complete,
    });

    expect(archive).toBe(zip as never);
    expect(zip.piped).toEqual([fakeFs.stream]);

    zip.emit("entry", { name: "a.png" });
    zip.emit("entry", { name: "b.png" });
    expect(progress).toEqual([
      { done: 1, filename: "a.png" },
      { done: 2, filename: "b.png" },
    ]);

    addToZip(archive, "/tmp/a.png", "renamed.png");
    expect(zip.files).toEqual([{ path: "/tmp/a.png", options: { name: "renamed.png" } }]);

    await closeZip(archive);
    expect(zip.finalized).toBe(true);

    zip.emit("end");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("routes an archive error to the caller", () => {
    const { zip, module } = setup();
    setArchiverModule(module as never);
    const onError = vi.fn();

    createZip({ resource: handle("zip"), onError });
    zip.emit("error", new Error("disk full"));

    expect(onError).toHaveBeenCalledWith(new Error("disk full"));
  });
});

describe("uploadResource", () => {
  const filePath = path.join(os.tmpdir(), `penpot-upload-${process.pid}.bin`);

  async function response(body: unknown, status = 200): Promise<Response> {
    return new Response(encode(body), {
      status,
      headers: { "content-type": "application/transit+json" },
    });
  }

  it("posts the file as a form and merges the backend fields", async () => {
    await writeFileP(filePath, "png-bytes");
    const resource = { ...handle("png"), path: filePath };
    const fetchMock = vi.fn(async (_uri: URL, _init: RequestInit) =>
      response({ id: "server-id", uri: "/assets/by-id/abc", size: 9, name: "board" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const uploaded = await uploadResource("token", resource);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [uri, init] = fetchMock.mock.calls[0];
    expect(uri.toString()).toBe("http://backend:6060/api/management/methods/upload-tempfile");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "X-Shared-Key": "exporter shared-key",
      Authorization: "Bearer token",
    });
    expect("dispatcher" in init).toBe(false);

    const form = init.body as FormData;
    const content = form.get("content") as File;
    expect(content.name).toBe("board.png");
    expect(content.type).toBe("image/png");
    expect(content.size).toBe(9);

    expect(uploaded).toMatchObject({
      id: "resource-id",
      uri: "/assets/by-id/abc",
      size: 9,
      name: "board",
      filename: "board.png",
      mtype: "image/png",
    });

    await rmP(filePath, { force: true });
  });

  it("reports a non 200 response with its status", async () => {
    await writeFileP(filePath, "png-bytes");
    vi.stubGlobal("fetch", vi.fn(async () => response({}, 500)));

    let data;
    try {
      await uploadResource(undefined, { ...handle("png"), path: filePath });
    } catch (cause) {
      data = errorData(cause);
    }

    expect(data).toMatchObject({
      type: "internal",
      code: "unable-to-upload-resource",
      "response-status": 500,
    });

    await rmP(filePath, { force: true });
  });
});
