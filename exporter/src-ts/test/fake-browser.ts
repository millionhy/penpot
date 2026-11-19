// A playwright stand-in for the renderer tests.
//
// The fake page records every call and lets a test script what the page
// returns, so the renderers can be checked for the order of their playwright
// calls, their options and the objects they report, without a browser.

import type {
  Executor,
  LocatorLike,
  PageLike,
  PdfRequest,
  ScreenshotOptions,
} from "../app/browser.js";

export interface RecordedCall {
  name: string;
  args: unknown[];
}

export interface FakePageOptions {
  evaluate?: (target: string, fn: unknown) => unknown;
  screenshot?: (target: string, options: ScreenshotOptions) => Uint8Array;
  pdf?: (options: PdfRequest) => Uint8Array;
  waitForFunction?: (expression: string) => Promise<unknown>;
  children?: (selector: string) => LocatorLike[];
}

export interface FakePage extends PageLike {
  calls: RecordedCall[];
}

export function createFakePage(options: FakePageOptions = {}): FakePage {
  const calls: RecordedCall[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };

  const locatorFor = (selector: string): LocatorLike => ({
    waitFor: async (request) => {
      record("locator.waitFor", selector, request);
    },
    screenshot: async (request) => {
      record("locator.screenshot", selector, request);
      return options.screenshot?.(selector, request) ?? new Uint8Array([1]);
    },
    evaluate: async (fn) => {
      record("locator.evaluate", selector, fn);
      return options.evaluate?.(selector, fn);
    },
  });

  return {
    calls,
    goto: async (url, request) => {
      record("goto", url, request);
    },
    waitForTimeout: async (ms) => {
      record("waitForTimeout", ms);
    },
    waitForFunction: async (expression, _arg, request) => {
      record("waitForFunction", expression, request);
      return options.waitForFunction?.(expression);
    },
    locator: (selector) => {
      record("locator", selector);
      return locatorFor(selector);
    },
    $$: async (selector) => {
      record("$$", selector);
      return options.children?.(selector) ?? [];
    },
    evaluate: async (fn, arg) => {
      record("evaluate", fn, arg);
      return options.evaluate?.("page", fn);
    },
    screenshot: async (request) => {
      record("screenshot", request);
      return options.screenshot?.("page", request) ?? new Uint8Array([1]);
    },
    pdf: async (request) => {
      record("pdf", request);
      return options.pdf?.(request) ?? new Uint8Array([1]);
    },
    emulateMedia: async (request) => {
      record("emulateMedia", request);
    },
    waitFor: async (request) => {
      record("waitFor", request);
    },
  };
}

export interface FakeExecutor extends Executor {
  configs: unknown[];
}

export function createFakeExecutor(page: PageLike): FakeExecutor {
  const configs: unknown[] = [];

  return {
    configs,
    exec: async (config, handle) => {
      configs.push(config);
      return handle(page);
    },
  };
}

export function names(page: FakePage): string[] {
  return page.calls.map((call) => call.name);
}

export function callsNamed(page: FakePage, name: string): RecordedCall[] {
  return page.calls.filter((call) => call.name === name);
}