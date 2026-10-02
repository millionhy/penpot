// Unit tests for the headless logic the migrated pages depend on: validation
// rules ported from the malli schemas, RPC error mapping, URL compatibility
// resolvers, flag parsing and the i18n helpers.
//
// Everything under lib/ is deliberately free of JSX so the suite runs in a
// plain node environment; the view halves live in components/ and the pages,
// which are exercised against a running backend instead.

import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, ".") },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
