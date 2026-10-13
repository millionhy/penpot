// Plugin flags store. Port of frontend/src/app/plugins/flags.cljs: the CLJS
// keeps {:plugins {:flags {id {...}}} in the global state, the shell keeps the
// same nested map in module state. The proxy exposed to plugin code
// (flags-proxy, with the naturalChildOrdering / throwValidationErrors
// accessors) belongs to the runtime slice (F7.3); this module is the storage
// those accessors read and write.

// The flag keys, spelled like the CLJS keywords.
export const NATURAL_CHILD_ORDERING = "natural-child-ordering";
export const THROW_VALIDATION_ERRORS = "throw-validation-errors";

let flags: Record<string, Record<string, boolean>> = {};

// initialize: default flag values for a plugin. Version >= 2 hardens the
// contract by throwing errors on validation failures.
export function initPluginFlags(pluginId: string, version: number | null | undefined = 1): void {
  const resolved = version ?? 1;
  flags = {
    ...flags,
    [pluginId]: {
      [NATURAL_CHILD_ORDERING]: false,
      [THROW_VALIDATION_ERRORS]: resolved >= 2,
    },
  };
}

export function getPluginFlag(pluginId: string, key: string): boolean | undefined {
  return flags[pluginId]?.[key];
}

// set-flag: (update-in state [:plugins :flags id] assoc key value). A flag on
// an id that was never initialized starts a fresh map, like the CLJS update-in.
export function setPluginFlag(pluginId: string, key: string, value: boolean): void {
  flags = {
    ...flags,
    [pluginId]: { ...flags[pluginId], [key]: value },
  };
}
