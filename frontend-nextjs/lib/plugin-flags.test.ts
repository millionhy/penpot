// Unit tests for the plugin flags store (app/plugins/flags.cljs): the default
// values per plugin version and the read/write accessors.

import { describe, expect, it } from "vitest";

import {
  NATURAL_CHILD_ORDERING,
  THROW_VALIDATION_ERRORS,
  getPluginFlag,
  initPluginFlags,
  setPluginFlag,
} from "@/lib/plugin-flags";

describe("initPluginFlags", () => {
  it("defaults naturalChildOrdering to false on every version", () => {
    initPluginFlags("flags-v1", 1);
    initPluginFlags("flags-v3", 3);
    expect(getPluginFlag("flags-v1", NATURAL_CHILD_ORDERING)).toBe(false);
    expect(getPluginFlag("flags-v3", NATURAL_CHILD_ORDERING)).toBe(false);
  });

  it("throws validation errors from version 2 on", () => {
    initPluginFlags("flags-v2", 2);
    expect(getPluginFlag("flags-v2", THROW_VALIDATION_ERRORS)).toBe(true);
  });

  it("does not throw validation errors on version 1", () => {
    initPluginFlags("flags-v1b", 1);
    expect(getPluginFlag("flags-v1b", THROW_VALIDATION_ERRORS)).toBe(false);
  });

  it("defaults the version to 1", () => {
    initPluginFlags("flags-default");
    initPluginFlags("flags-null", null);
    expect(getPluginFlag("flags-default", THROW_VALIDATION_ERRORS)).toBe(false);
    expect(getPluginFlag("flags-null", THROW_VALIDATION_ERRORS)).toBe(false);
  });
});

describe("setPluginFlag", () => {
  it("writes a flag on an initialized plugin", () => {
    initPluginFlags("flags-set", 1);
    setPluginFlag("flags-set", NATURAL_CHILD_ORDERING, true);
    expect(getPluginFlag("flags-set", NATURAL_CHILD_ORDERING)).toBe(true);
  });

  it("starts a fresh map for a plugin that was never initialized", () => {
    setPluginFlag("flags-fresh", THROW_VALIDATION_ERRORS, true);
    expect(getPluginFlag("flags-fresh", THROW_VALIDATION_ERRORS)).toBe(true);
  });
});
