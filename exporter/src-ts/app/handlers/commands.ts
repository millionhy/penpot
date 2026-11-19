// The command table the legacy `POST /api/export` entry point multiplexes on.
//
// `app.handlers.export` dispatches `cmd` through a multimethod in CLJS; here
// each command owns its params validation and its `prepare`, and this module
// only maps the name to it. The service is assembled in the process entry
// point (G2.7).

import type { ExportCommand } from "./export.js";
import { exportFrames } from "./export-frames.js";
import { exportShapes } from "./export-shapes.js";

export function createExportCommands(): Record<string, ExportCommand> {
  return {
    "export-shapes": {
      conform: exportShapes.conform,
      prepare: exportShapes.prepare,
    },
    "export-frames": {
      conform: exportFrames.conform,
      prepare: exportFrames.prepare,
    },
  };
}
