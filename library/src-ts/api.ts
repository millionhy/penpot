// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// The public `BuildContext` object. Mirrors `lib.builder`: same method
// names, same getters, same `BuilderError` shape.

import type { BuilderOptions, BuilderState, Shape, Uuid } from "./model.ts";
import { BuilderFailure } from "./errors.ts";
import * as core from "./builder.ts";
import { next } from "./uuid.ts";

export class BuilderError extends Error {
  readonly type: string;
  readonly code: string;
  readonly hint: string;

  constructor(type: string, code: string, hint: string, cause?: unknown) {
    super(hint);

    this.name = `Exception: ${hint}`;
    this.type = type;
    this.code = code;
    this.hint = hint;

    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, BuilderError);
    }

    // The CLJS error exposes both members through enumerable getters.
    Object.defineProperty(this, "cause", {
      enumerable: true,
      configurable: true,
      get: () => cause,
    });

    Object.defineProperty(this, "explain", {
      enumerable: true,
      configurable: true,
      get: () => undefined,
    });
  }
}

function rethrow(cause: unknown): never {
  if (cause instanceof BuilderError) throw cause;

  if (cause instanceof BuilderFailure) {
    throw new BuilderError(cause.type, cause.code, cause.hint, cause);
  }

  const message = cause instanceof Error ? cause.message : String(cause);
  throw new BuilderError("unknown", "unknown", message, cause);
}

/** Converts plain JS params to the internal shape; keys already match. */
function decodeParams<T>(params: T): T {
  return params;
}

function assertBlob(blob: unknown): asserts blob is Blob {
  if (typeof Blob === "undefined" || !(blob instanceof Blob)) {
    throw new BuilderError(
      "validation",
      "invalid-media",
      "only Blob instance are soported",
    );
  }
}

function normalizeOptions(options: unknown): BuilderOptions | null {
  if (options == null) return null;

  if (typeof options !== "object") {
    throw new BuilderError(
      "assertion",
      "data-validation",
      "invalid context options",
    );
  }

  const referer = (options as { referer?: unknown }).referer;
  if (referer != null && typeof referer !== "string") {
    throw new BuilderError(
      "assertion",
      "data-validation",
      "invalid context options",
    );
  }

  return options as BuilderOptions;
}

export interface BuildContext {
  readonly currentFileId: string;
  readonly currentFrameId: string;
  readonly currentPageId: string;
  readonly lastId: string;

  addFile(params: Record<string, unknown>): string;
  closeFile(): void;

  addPage(params?: Record<string, unknown>): string;
  closePage(): void;

  addBoard(params: Record<string, unknown>): string;
  closeBoard(): void;

  addGroup(params: Record<string, unknown>): string;
  closeGroup(): void;

  addBool(params: Record<string, unknown>): string;

  addRect(params: Record<string, unknown>): string;
  addCircle(params: Record<string, unknown>): string;
  addPath(params: Record<string, unknown>): string;
  addText(params: Record<string, unknown>): string;

  addLibraryColor(params: Record<string, unknown>): string;
  addLibraryTypography(params: Record<string, unknown>): string;
  addComponent(params: Record<string, unknown>): string;

  addFileMedia(params: Record<string, unknown>, blob: Blob): string;
  getMediaAsImage(id: string): Record<string, unknown> | null;

  addTokensLib(data: unknown): void;
  addRelation(fileId: string, libraryId: string): boolean;

  genId(): string;
  getInternalState(): Record<string, unknown>;

  deleteShape(id: string): void;
  updateShape(id: string, f: (shape: Shape) => Shape): void;
}

export function createBuildContext(options?: unknown): BuildContext {
  let state: BuilderState = core.createState(normalizeOptions(options));

  const update = (fn: (current: BuilderState) => BuilderState): void => {
    state = fn(state);
  };

  const context: BuildContext = {
    get currentFileId() {
      return state.currentFileId ?? "";
    },

    get currentFrameId() {
      return state.currentFrameId ?? "";
    },

    get currentPageId() {
      return state.currentPageId ?? "";
    },

    get lastId() {
      return state.lastId ?? "";
    },

    addFile(params) {
      try {
        update((current) => core.addFile(current, decodeParams(params ?? {})));
        return state.currentFileId ?? "";
      } catch (cause) {
        rethrow(cause);
      }
    },

    closeFile() {
      update(core.closeFile);
    },

    addPage(params) {
      try {
        update((current) => core.addPage(current, decodeParams(params ?? {})));
        return state.currentPageId ?? "";
      } catch (cause) {
        rethrow(cause);
      }
    },

    closePage() {
      update(core.closePage);
    },

    addBoard(params) {
      try {
        update((current) => core.addBoard(current, decodeParams(params ?? {})));
        return state.lastId ?? "";
      } catch (cause) {
        rethrow(cause);
      }
    },

    closeBoard() {
      update(core.closeBoard);
    },

    addGroup(params) {
      try {
        update((current) => core.addGroup(current, decodeParams(params ?? {})));
        return state.lastId ?? "";
      } catch (cause) {
        rethrow(cause);
      }
    },

    closeGroup() {
      update(core.closeGroup);
    },

    addBool(params) {
      try {
        update((current) => core.addBool(current, decodeParams(params ?? {})));
        return state.lastId ?? "";
      } catch (cause) {
        rethrow(cause);
      }
    },

    addRect(params) {
      try {
        update((current) =>
          core.addShape(current, { ...decodeParams(params ?? {}), type: "rect" }),
        );
        return state.lastId ?? "";
      } catch (cause) {
        rethrow(cause);
      }
    },

    addCircle(params) {
      try {
        update((current) =>
          core.addShape(current, {
            ...decodeParams(params ?? {}),
            type: "circle",
          }),
        );
        return state.lastId ?? "";
      } catch (cause) {
        rethrow(cause);
      }
    },

    addPath(params) {
      try {
        update((current) =>
          core.addShape(current, { ...decodeParams(params ?? {}), type: "path" }),
        );
        return state.lastId ?? "";
      } catch (cause) {
        rethrow(cause);
      }
    },

    addText(params) {
      try {
        update((current) =>
          core.addShape(current, { ...decodeParams(params ?? {}), type: "text" }),
        );
        return state.lastId ?? "";
      } catch (cause) {
        rethrow(cause);
      }
    },

    addLibraryColor(params) {
      try {
        update((current) =>
          core.addLibraryColor(current, decodeParams(params ?? {})),
        );
        return state.lastId ?? "";
      } catch (cause) {
        rethrow(cause);
      }
    },

    addLibraryTypography(params) {
      try {
        update((current) =>
          core.addLibraryTypography(current, decodeParams(params ?? {})),
        );
        return state.lastId ?? "";
      } catch (cause) {
        rethrow(cause);
      }
    },

    addComponent(params) {
      try {
        update((current) =>
          core.addComponent(current, decodeParams(params ?? {})),
        );
        return state.lastId ?? "";
      } catch (cause) {
        rethrow(cause);
      }
    },

    addFileMedia(params, blob) {
      assertBlob(blob);
      try {
        const wrapper = {
          mtype: blob.type,
          size: blob.size,
          blob,
        };
        update((current) =>
          core.addFileMedia(current, decodeParams(params ?? {}), wrapper),
        );
        return state.lastId ?? "";
      } catch (cause) {
        rethrow(cause);
      }
    },

    getMediaAsImage(id) {
      return core.getMediaAsImage(state, id);
    },

    addTokensLib(data) {
      try {
        update((current) => core.addTokensLib(current, data));
      } catch (cause) {
        rethrow(cause);
      }
    },

    addRelation(fileId, libraryId) {
      const result = core.addRelation(state, fileId, libraryId);
      if (result == null) return false;
      state = result;
      return true;
    },

    genId() {
      return next();
    },

    getInternalState() {
      return core.toInternalState(state);
    },

    deleteShape(id: Uuid) {
      update((current) => core.deleteShape(current, id));
    },

    updateShape(id: Uuid, f: (shape: Shape) => Shape) {
      update((current) => core.updateShape(current, id, f));
    },
  };

  return context;
}
