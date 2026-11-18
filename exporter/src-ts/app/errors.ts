// app.common.exceptions, Node side. The CLJS code raises plain maps carrying
// :type/:code/:hint and reads them back through ex-data; every handler in
// app.handlers switches on those fields, so the TS error keeps the same ones
// and the same message (ex-message is the :hint).

export interface ErrorData {
  type?: string;
  code?: string;
  hint?: string;
  [key: string]: unknown;
}

export class AppError extends Error {
  readonly data: ErrorData;

  constructor(data: ErrorData, options?: { cause?: unknown }) {
    super(data.hint ?? data.code ?? data.type ?? "error", options);
    this.name = "AppError";
    this.data = data;
  }
}

export function error(data: ErrorData, options?: { cause?: unknown }): AppError {
  return new AppError(data, options);
}

export function raise(data: ErrorData): never {
  throw new AppError(data);
}

export function isAppError(cause: unknown): cause is AppError {
  return cause instanceof AppError;
}

export function errorData(cause: unknown): ErrorData {
  return cause instanceof AppError ? cause.data : {};
}

// ex-message: the hint when present, the thrown message otherwise.
export function errorMessage(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.message;
  if (cause === undefined || cause === null) return undefined;
  return String(cause);
}

// ex/exception? and ex/error?: anything thrown counts for the log handlers.
export function isException(cause: unknown): cause is Error {
  return cause instanceof Error;
}