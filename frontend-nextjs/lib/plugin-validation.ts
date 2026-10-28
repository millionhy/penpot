// Plugin value validation (F7.4). Port of u/not-valid and the number
// predicates of app.plugins.utils / app.common.schema that the proxies use.
//
// Kept apart from lib/plugin-context so the proxy modules can validate
// without importing the context that builds them (the context imports the
// proxies in turn).

import { THROW_VALIDATION_ERRORS, getPluginFlag } from "@/lib/plugin-flags";

// u/not-valid: a plugin with throwValidationErrors on gets a thrown error; an
// older one only a console error and a null answer.
export function notValid(pluginId: string, code: string, value?: unknown): null {
  const message =
    value === undefined || value === null
      ? `[PENPOT PLUGIN] Value not valid. Code: ${code}`
      : `[PENPOT PLUGIN] Value not valid: ${String(value)}. Code: ${code}`;
  if (getPluginFlag(pluginId, THROW_VALIDATION_ERRORS) === true) {
    throw new Error(message);
  }
  console.error(message);
  return null;
}

// sm/valid-safe-number?: a finite number; the plugin API never accepts
// Infinity or NaN as a coordinate, size or opacity.
export function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// sm/valid-non-negative-safe-number?.
export function validNonNegativeNumber(value: unknown): value is number {
  return validNumber(value) && value >= 0;
}
