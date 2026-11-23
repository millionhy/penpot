import path from "node:path";
import { defineConfig } from "vite";
import { coverageConfigDefaults } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  root: "./src",
  resolve: {
    alias: {
      "~": path.resolve("./src"),
    },
  },
  build: {
    minify: true,
    sourcemap: true,
    lib: {
      entry: "src/editor/TextEditor.js",
      name: "TextEditor",
      fileName: "TextEditor",
      formats: ["es"],
    },
  },
  test: {
    coverage: {
      enabled: true,
      exclude: ["main.js", "**/scripts/**", ...coverageConfigDefaults.exclude],
    },
    singleThread: true,
    environmentOptions: {
      jsdom: {
        resources: "usable",
      },
    },
    browser: {
      name: "chromium",
      provider: playwright(),
    },
    exclude: ["main.js", "**/scripts/**", "**/node_modules/**", "**/dist/**"],
  },
});
