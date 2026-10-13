// The viewer slice of the static exception page (app.main.ui.static):
// error-container*, not-found* and the request-access* flow. The CLJS
// raises :not-found from viewer-content* when the page id does not resolve,
// and the bundle fetch failing with :not-found / :authentication assigns
// the same exception; both paths land on this page.
//
// Deviations from the CLJS original, documented:
// - The anonymous branch shows the not-found content with a Login button
//   instead of the login-modal* dialog; the auth dialog stack (login,
//   register, recovery) is out of scope for the viewer port.
// - The "just logged in" loader branch is dropped: the session refresh
//   remounts the page, so initial-authenticated? never flips mid-mount.
// - load-info failures fall back to an empty info instead of bubbling to
//   a global handler, so the page still resolves.

import { RpcError } from "./errors";
import { cmd } from "./rpc";

// load-info in static.cljs: get-file-info / get-team-info resolve whether
// the URL names an existing file / team. The file-id branch wins over the
// team-id branch; an absent answer still counts as loaded, so the
// request-access decision keys off the id being missing. Both commands
// carry ::rpc/auth false, so anonymous callers get an answer too.
export interface AccessInfo {
  fileId?: string;
  teamId?: string;
  teamDefault?: boolean;
}

// rx/timeout 3000 in load-info: the page resolves to the default after
// three seconds instead of staying blank.
const ACCESS_INFO_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface FileInfoRow {
  id?: string;
}

interface TeamInfoRow {
  id?: string;
  "is-default"?: boolean;
}

export async function loadAccessInfo(params: {
  fileId?: string | null;
  teamId?: string | null;
}): Promise<AccessInfo> {
  if (params.fileId !== undefined && params.fileId !== null) {
    const info = await withTimeout(
      cmd<FileInfoRow | null>("get-file-info", { id: params.fileId }),
      ACCESS_INFO_TIMEOUT_MS,
    );
    // (:file-id info) in the CLJS: a missing file yields no file-id.
    return info === undefined || info === null ? {} : { fileId: info.id };
  }
  if (params.teamId !== undefined && params.teamId !== null) {
    const info = await withTimeout(
      cmd<TeamInfoRow | null>("get-team-info", { id: params.teamId }),
      ACCESS_INFO_TIMEOUT_MS,
    );
    if (info === undefined || info === null) return {};
    return { teamId: info.id, teamDefault: info["is-default"] };
  }
  return {};
}

export type ExceptionStage = "not-found" | "pending" | "request-access";

// exception-page* in static.cljs: a not-found/authentication exception
// with a resolved file-id or team-id becomes the request-access dialog;
// while the info loads the page stays blank (the CLJS renders nil); an
// anonymous visitor keeps the not-found content (see the deviation note).
export function exceptionStage(authenticated: boolean, info: AccessInfo | null): ExceptionStage {
  if (!authenticated) return "not-found";
  if (info === null) return "pending";
  if (info.fileId !== undefined || info.teamId !== undefined) return "request-access";
  return "not-found";
}

export type RequestAccessStage =
  | "default-team"
  | "already-file"
  | "already-project"
  | "sent"
  | "file"
  | "team";

// request-access* in static.cljs: the cond order is part of the behavior.
// `sent` / `alreadyRequested` come from the local submission state; the
// already-requested copy shows when the command rejects (the CLJS on-error).
export function requestAccessStage(opts: {
  isDefault: boolean | undefined;
  fileId: string | undefined;
  teamId: string | undefined;
  sent: boolean;
  alreadyRequested: boolean;
}): RequestAccessStage {
  if (opts.isDefault === true) return "default-team";
  if (opts.fileId !== undefined && opts.alreadyRequested) return "already-file";
  if (opts.alreadyRequested) return "already-project";
  if (opts.sent) return "sent";
  if (opts.fileId !== undefined) return "file";
  return "team";
}

// on-request-access in static.cljs: a file request carries is-viewer (the
// owner's email uses the viewer template); otherwise the team id travels.
// The viewer caller passes isWorkspace false, like the static page.
export function requestAccessParams(opts: {
  fileId: string | undefined;
  teamId: string | undefined;
  isWorkspace: boolean;
}): { fileId: string; isViewer: boolean } | { teamId: string } {
  if (opts.fileId !== undefined) {
    return { fileId: opts.fileId, isViewer: !opts.isWorkspace };
  }
  return { teamId: opts.teamId as string };
}

export async function createTeamAccessRequest(
  params: { fileId: string; isViewer: boolean } | { teamId: string },
): Promise<unknown> {
  return cmd("create-team-access-request", params);
}

// The bundle fetch failure of viewer-content*: the CLJS assigns the
// exception page for :not-found and :authentication causes; every other
// failure keeps the generic message (a toast in the CLJS, the full-page
// message here).
export function isExceptionCause(error: unknown): boolean {
  if (!(error instanceof RpcError)) return false;
  const type = String(error.data.type);
  return type === "not-found" || type === "authentication";
}
