// app.handlers.jobs: REST surface for export jobs, under /api/export/jobs.
//
// Ownership always comes from the session (see app/auth.ts), never from the
// request body.

import { checkOwner, requireProfileId } from "../auth.js";
import { raise } from "../errors.js";
import type { Exchange, Handler } from "../exchange.js";
import * as jobs from "../jobs.js";
import { createLogger, setLevel } from "../logging.js";
import type { ExportService } from "./export.js";

const log = createLogger("app.handlers.jobs");
setLevel("app.handlers.jobs", "debug");

export interface JobHandlerOptions {
  service: ExportService;
}

function withBody(exchange: Exchange, body: unknown): Exchange {
  return { ...exchange, response: { ...exchange.response, body } };
}

export function createJobHandlers(options: JobHandlerOptions): {
  create: Handler;
  fetch: (exchange: Exchange, id: string) => Promise<Exchange>;
  cancel: (exchange: Exchange, id: string) => Promise<Exchange>;
} {
  const create: Handler = async (exchange) => {
    const profileId = await requireProfileId(exchange.request.authToken);
    const params = options.service.conformParams({
      ...exchange.request.params,
      "profile-id": profileId,
    });

    log.debug({ hint: "create export job", cmd: params.cmd, "profile-id": profileId });

    const created = await options.service.createJob(exchange.request.authToken, params);

    // A failure is reported through the job record, so the promise must not
    // surface as an unhandled rejection.
    void created.pending.catch(() => undefined);

    const current = jobs.lookup(String(created.job.id)) ?? created.job;
    return withBody(exchange, {
      ...current,
      filename: created.resource.filename,
      mtype: created.resource.mtype,
    });
  };

  const fetch = async (exchange: Exchange, id: string): Promise<Exchange> => {
    const profileId = await requireProfileId(exchange.request.authToken);
    const job = checkOwner(await jobs.fetch(id), profileId);
    return withBody(exchange, job);
  };

  const cancel = async (exchange: Exchange, id: string): Promise<Exchange> => {
    const profileId = await requireProfileId(exchange.request.authToken);
    checkOwner(await jobs.fetch(id), profileId);

    await jobs.cancel(id);
    const job = await jobs.fetch(id);
    if (job === undefined) {
      return raise({ type: "not-found", code: "object-not-found", hint: "job does not exist" });
    }

    return withBody(exchange, job);
  };

  return { create, fetch, cancel };
}