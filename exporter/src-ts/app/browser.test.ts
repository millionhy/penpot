// app.browser: cookies, the playwright call wrappers, and the pool rules
// (max/min, borrow validation, acquire timeout, exec close/destroy, drain).

import { afterEach, describe, expect, it } from "vitest";

process.env.PENPOT_SECRET_KEY = "test-secret";

import {
  BrowserPool,
  TimeoutError,
  createCookies,
  createPool,
  navigate,
  pdf,
  screenshot,
  waitFor,
  waitForFonts,
  type BrowserLike,
  type ContextLike,
  type PageLike,
  type PoolOptions,
} from "./browser.js";
import { errorData } from "./errors.js";
import { createFakePage } from "../test/fake-browser.js";

interface FakeBrowser {
  browser: BrowserLike;
  state: { closed: boolean; contexts: number; connected: boolean; contextClosed: boolean[] };
}

function fakeBrowser(options: { connected?: boolean } = {}): FakeBrowser {
  const state = {
    closed: false,
    contexts: 0,
    connected: options.connected ?? true,
    contextClosed: [] as boolean[],
  };
  const page = createFakePage();

  const browser: BrowserLike = {
    newContext: async (): Promise<ContextLike> => {
      state.contexts += 1;
      const index = state.contextClosed.push(false) - 1;
      return {
        newPage: async (): Promise<PageLike> => page,
        close: async () => {
          state.contextClosed[index] = true;
        },
      };
    },
    isConnected: () => state.connected,
    close: async () => {
      state.closed = true;
    },
  };

  return { browser, state };
}

function poolOptions(overrides: Partial<PoolOptions> = {}): PoolOptions {
  return {
    max: 2,
    min: 0,
    testOnBorrow: true,
    evictionRunIntervalMillis: 1_000_000,
    numTestsPerEvictionRun: 5,
    acquireTimeoutMillis: 2000,
    idleTimeoutMillis: 10000,
    ...overrides,
  };
}

const pools: BrowserPool[] = [];

function pool(launch: () => Promise<BrowserLike>, options: Partial<PoolOptions> = {}): BrowserPool {
  const created = createPool(launch, poolOptions(options));
  pools.push(created);
  return created;
}

afterEach(async () => {
  for (const created of pools.splice(0)) {
    await created.clear();
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("cookies", () => {
  it("carries the token for the internal host, port included", () => {
    const [cookie] = createCookies(new URL("http://backend:6060/render.html"), { token: "abc" });

    expect(cookie).toEqual({ domain: "backend:6060", path: "/", name: "auth-token", value: "abc" });
  });

  it("takes a custom name and tolerates a missing token", () => {
    const [cookie] = createCookies(new URL("http://backend/render.html"), {
      name: "auth-token",
      token: undefined,
    });

    expect(cookie.domain).toBe("backend");
    expect(cookie.value).toBe("");
  });
});

describe("playwright wrappers", () => {
  it("navigates with the networkidle default", async () => {
    const page = createFakePage();

    await navigate(page, "http://backend/render.html");

    expect(page.calls[0]).toMatchObject({
      name: "goto",
      args: ["http://backend/render.html", { waitUntil: "networkidle", timeout: 20000 }],
    });
  });

  it("lets the caller change the wait and the timeout", async () => {
    const page = createFakePage();

    await navigate(page, "http://backend/", { waitUntil: "load", timeout: 5 });

    expect(page.calls[0]).toMatchObject({
      name: "goto",
      args: ["http://backend/", { waitUntil: "load", timeout: 5 }],
    });
  });

  it("keeps the export going when the font wait times out", async () => {
    const failure = new Error("Timeout 15000ms exceeded");
    failure.name = "TimeoutError";
    const page = createFakePage({ waitForFunction: async () => Promise.reject(failure) });

    await expect(waitForFonts(page)).resolves.toBeUndefined();
  });

  it("requests every declared face before checking the status", async () => {
    const page = createFakePage();

    await waitForFonts(page);

    const [call] = page.calls;
    expect(call.name).toBe("waitForFunction");
    expect(String(call.args[0])).toContain("document.fonts.ready");
    expect(call.args[1]).toEqual({ timeout: 15000 });
  });

  it("waits for a visible locator by default", async () => {
    const page = createFakePage();
    const node = page.locator("#screenshot-1");
    page.calls.length = 0;

    await waitFor(node);

    expect(page.calls[0]).toMatchObject({
      name: "locator.waitFor",
      args: ["#screenshot-1", { state: "visible", timeout: 10000 }],
    });
  });

  it("builds the png screenshot request", async () => {
    const page = createFakePage();

    await screenshot(page, { path: "/tmp/a.png" });

    expect(page.calls[0]).toMatchObject({
      name: "screenshot",
      args: [{ type: "png", omitBackground: false, path: "/tmp/a.png" }],
    });
  });

  it("adds the quality for jpeg and drops the clip for a full page", async () => {
    const page = createFakePage();

    await screenshot(page, { type: "jpeg", fullPage: true });

    const options = page.calls[0].args[0] as Record<string, unknown>;
    expect(options).toMatchObject({ type: "jpeg", quality: 95, fullPage: true });
    expect(options.clip).toBeUndefined();
  });

  it("prints with the background and the css page size", async () => {
    const page = createFakePage();

    await pdf(page, { path: "/tmp/a.pdf" });

    expect(page.calls[0]).toMatchObject({
      name: "pdf",
      args: [
        {
          path: "/tmp/a.pdf",
          scale: 1,
          pageRanges: "1",
          printBackground: true,
          preferCSSPageSize: true,
        },
      ],
    });
  });
});

describe("the pool", () => {
  it("reuses the browser that came back", async () => {
    let launched = 0;
    const { browser } = fakeBrowser();
    const created = pool(async () => {
      launched += 1;
      return browser;
    });

    const first = await created.acquire();
    created.release(first);
    const second = await created.acquire();

    expect(second).toBe(first);
    expect(launched).toBe(1);
  });

  it("stops handing out browsers at max", async () => {
    const { browser } = fakeBrowser();
    const created = pool(async () => browser, { max: 1 });

    await created.acquire();

    await expect(created.acquire()).rejects.toBeInstanceOf(TimeoutError);
  });

  it("replaces a disconnected browser when it borrows", async () => {
    let launched = 0;
    const browsers = [fakeBrowser({ connected: false }), fakeBrowser()];
    const created = pool(async () => {
      const next = browsers[Math.min(launched, browsers.length - 1)];
      launched += 1;
      return next.browser;
    });

    const first = await created.acquire();
    created.release(first);
    const second = await created.acquire();

    expect(second).not.toBe(first);
    expect(browsers[0].state.closed).toBe(true);
    expect(launched).toBe(2);
  });

  it("closes the context and releases the browser after a good run", async () => {
    const { browser, state } = fakeBrowser();
    const created = pool(async () => browser);

    const result = await created.exec({ locale: "en-US" }, async (page) => {
      expect(page).toBeDefined();
      return 42;
    });

    expect(result).toBe(42);
    expect(state.contextClosed).toEqual([true]);
    expect(state.closed).toBe(false);
  });

  it("destroys the browser when the handler throws", async () => {
    const { browser, state } = fakeBrowser();
    const created = pool(async () => browser);

    await expect(
      created.exec({}, async () => {
        throw new Error("page blew up");
      }),
    ).rejects.toThrow(/page blew up/);

    expect(state.closed).toBe(true);
  });

  it("turns a pool timeout into an internal timeout error", async () => {
    const { browser } = fakeBrowser();
    const created = pool(async () => browser, { max: 1, acquireTimeoutMillis: 20 });
    await created.acquire();

    try {
      await created.exec({}, async () => undefined);
      throw new Error("expected a rejection");
    } catch (cause) {
      expect(errorData(cause)).toMatchObject({ type: "internal", code: "timeout" });
    }
  });

  it("keeps the original error when it is not a timeout", async () => {
    const created = pool(async () => {
      throw new Error("cannot launch");
    });

    await expect(created.exec({}, async () => undefined)).rejects.toThrow(/cannot launch/);
  });

  it("refuses new browsers once it is draining", async () => {
    const { browser } = fakeBrowser();
    const created = pool(async () => browser);

    await created.drain();

    await expect(created.acquire()).rejects.toMatchObject({
      data: { code: "browser-not-ready" },
    });
  });

  it("closes what sits idle when cleared", async () => {
    const { browser, state } = fakeBrowser();
    const created = pool(async () => browser);
    const acquired = await created.acquire();
    created.release(acquired);

    await created.clear();

    expect(state.closed).toBe(true);
  });

  it("prewarms the requested minimum", async () => {
    let launched = 0;
    const created = pool(
      async () => {
        launched += 1;
        return fakeBrowser().browser;
      },
      { min: 2, max: 2 },
    );

    await wait(10);

    expect(launched).toBe(2);
    const first = await created.acquire();
    expect(launched).toBe(2);
    created.release(first);
  });
});

describe("the module pool", () => {
  it("answers browser-not-ready before init", async () => {
    const { exec } = await import("./browser.js");

    await expect(exec({}, async () => undefined)).rejects.toMatchObject({
      data: { code: "browser-not-ready" },
    });
  });
});