// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// Port of the `app.common.media` helpers the library export relies on.

const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["image/apng", ".apng"],
  ["image/avif", ".avif"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/svg+xml", ".svg"],
  ["image/webp", ".webp"],
  ["application/zip", ".zip"],
  ["application/penpot", ".penpot"],
  ["application/pdf", ".pdf"],
  ["text/plain", ".txt"],
  ["font/woff", ".woff"],
  ["font/woff2", ".woff2"],
  ["font/ttf", ".ttf"],
  ["font/otf", ".otf"],
  ["application/octet-stream", ".bin"],
]);

/** Returns the file extension for a mime type, or an empty string. */
export function mtypeToExtension(mtype: string | null | undefined): string {
  if (mtype == null) return "";
  return EXTENSIONS.get(mtype) ?? "";
}
