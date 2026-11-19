// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// The CLJS builder raised `ex-info` from the common layer and wrapped it
// into `BuilderError` at the API boundary. The port keeps the same split:
// the core throws this class, the API turns it into a `BuilderError`.

export class BuilderFailure extends Error {
  readonly type: string;
  readonly code: string;
  readonly hint: string;
  readonly cause?: unknown;

  constructor(type: string, code: string, hint: string, cause?: unknown) {
    super(hint);
    this.name = "BuilderFailure";
    this.type = type;
    this.code = code;
    this.hint = hint;
    this.cause = cause;
  }
}

export function fail(
  type: string,
  code: string,
  hint: string,
  cause?: unknown,
): never {
  throw new BuilderFailure(type, code, hint, cause);
}
