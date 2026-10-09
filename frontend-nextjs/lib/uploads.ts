// Chunked uploads (F5.4). Port of app.main.data.uploads: the purpose-agnostic
// three-step session API any feature that uploads large binary blobs uses —
// create-upload-session, then upload-chunk per slice (at most
// max-parallel-chunk-uploads requests in flight), leaving the caller's own
// third step (assemble-file-media-object, create-font-variant, ...) to run
// against the returned session id.

import { cmd, cmdUpload } from "@/lib/rpc";

// cf/upload-chunk-size: 25 MiB. Fonts pass their own 10 MiB
// (font-upload-chunk-size in app.main.data.fonts).
export const DEFAULT_UPLOAD_CHUNK_SIZE = 25 * 1024 * 1024;

// max-parallel-chunk-uploads
const MAX_PARALLEL_CHUNK_UPLOADS = 2;

export interface UploadChunkRange {
  index: number;
  start: number;
  end: number;
}

// The slice table of a blob: ceil(size / chunk-size) ranges. Exported so the
// tests can pin the arithmetic without talking to the RPC.
export function chunkRanges(size: number, chunkSize: number): UploadChunkRange[] {
  const total = Math.ceil(size / chunkSize);
  const ranges: UploadChunkRange[] = [];
  for (let index = 0; index < total; index++) {
    const start = index * chunkSize;
    ranges.push({ index, start, end: Math.min(start + chunkSize, size) });
  }
  return ranges;
}

// upload-blob-chunked: create the session, upload every chunk through a
// two-worker pool, and resolve with the session id the caller needs for its
// final step. The chunk travels as a [Blob, "chunk-N"] multipart part
// ((list chunk ...) in the CLJS original), which cmdUpload understands.
export async function uploadBlobChunked(
  blob: Blob,
  options: { chunkSize?: number } = {},
): Promise<{ sessionId: string }> {
  const chunkSize = options.chunkSize ?? DEFAULT_UPLOAD_CHUNK_SIZE;
  const ranges = chunkRanges(blob.size, chunkSize);

  const created = await cmd<{ "session-id": string }>("create-upload-session", {
    "total-chunks": ranges.length,
  });
  const sessionId = created["session-id"];

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const range = ranges[next];
      next += 1;
      if (range === undefined) return;
      const chunk = blob.slice(range.start, range.end);
      await cmdUpload("upload-chunk", {
        "session-id": sessionId,
        index: range.index,
        content: [chunk, `chunk-${range.index}`],
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL_CHUNK_UPLOADS, ranges.length) }, () => worker()),
  );

  return { sessionId };
}
