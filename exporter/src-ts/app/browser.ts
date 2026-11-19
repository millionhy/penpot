// app.browser: the chromium pool and the playwright calls the renderers make.
//
// The CLJS module sits on generic-pool; this port keeps its own small pool so
// the exporter does not add that dependency, with the same knobs: max/min,
// testOnBorrow, a ten second acquire timeout, a ten second idle timeout and an
// eviction pass every five seconds. A browser that fails to serve a page is
// destroyed instead of returned, so the next export starts from a clean
// process.
//
// playwright itself is loaded lazily (see app.deps) because the unit tests run
// without it installed.

import { get } from "./config.js";
import { load } from "./deps.js";
import { AppError, raise } from "./errors.js";
import { createLogger, setLevel } from "./logging.js";
import { getDomain } from "./uri.js";

const log = createLogger("app.browser");
setLevel("app.browser", "trace");

export const defaultTimeout = 30000;
export const defaultViewportWidth = 1920;
export const defaultViewportHeight = 1080;
export const defaultUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/99.0.3729.169 Safari/537.36";

// The pool owns its timeout error: generic-pool exported one, and the error
// translation below keyed off it.
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

// --- BROWSER API

export interface Cookie {
  domain: string;
  path: string;
  name: string;
  value: string;
}

export function createCookies(
  uri: URL,
  options: { name?: string; token?: string } = {},
): Cookie[] {
  return [
    {
      domain: getDomain(uri),
      path: "/",
      name: options.name ?? "auth-token",
      value: String(options.token ?? ""),
    },
  ];
}

export interface NavigationOptions {
  waitUntil?: string;
  timeout?: number;
}

export function navigate(
  page: PageLike,
  url: string | URL,
  options: NavigationOptions = {},
): Promise<unknown> {
  return page.goto(String(url), {
    waitUntil: options.waitUntil ?? "networkidle",
    timeout: options.timeout ?? 20000,
  });
}

export function sleep(page: PageLike, ms: number): Promise<void> {
  return page.waitForTimeout(ms);
}

// Checking `document.fonts.status === 'loaded'` on its own is not enough: the
// render page injects its `@font-face` rules asynchronously and the browser
// only loads a face lazily, when some painted text actually uses it. A face
// that is declared but not yet requested stays in the `unloaded` state, which
// does NOT keep `document.fonts.status` at `loading`, so the check can pass
// before any real font glyphs are available. The export is then captured with a
// (usually wider) fallback font, and auto-width text laid out with the real font
// metrics overflows its bounds and gets clipped. So every declared face is
// requested and `document.fonts.ready` awaited before the status check.
const WAIT_FOR_FONTS = `async () => {
  if (!document.fonts) return true;
  try {
    await Promise.all(Array.from(document.fonts, (face) => face.load()));
  } catch (e) {}
  await document.fonts.ready;
  return document.fonts.status === 'loaded';
}`;

export async function waitForFonts(
  page: PageLike,
  options: { timeout?: number } = {},
): Promise<void> {
  try {
    await page.waitForFunction(WAIT_FOR_FONTS, undefined, {
      timeout: options.timeout ?? 15000,
    });
  } catch (cause) {
    log.warn({
      hint: "wait-for-fonts timed out; continuing anyway",
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export interface WaitForOptions {
  state?: string;
  timeout?: number;
}

export function waitFor(locator: LocatorLike, options: WaitForOptions = {}): Promise<void> {
  return locator.waitFor({
    state: options.state ?? "visible",
    timeout: options.timeout ?? 10000,
  });
}

export interface ScreenshotOptions {
  type?: "png" | "jpeg";
  omitBackground?: boolean;
  quality?: number;
  path?: string;
  fullPage?: boolean;
  clip?: unknown;
}

export function screenshot(frame: FrameLike, options: ScreenshotOptions = {}): Promise<Uint8Array> {
  const type = options.type ?? "png";
  const omitBackground = options.omitBackground ?? false;

  const request: ScreenshotOptions = { type, omitBackground };
  if (options.path !== undefined) request.path = options.path;
  if (type === "jpeg") request.quality = options.quality ?? 95;
  if (options.fullPage === true) {
    request.fullPage = true;
    request.clip = undefined;
  }

  return frame.screenshot(request);
}

export async function emulateMedia(page: PageLike, options: { media: string | null }): Promise<PageLike> {
  await page.emulateMedia({ media: options.media });
  return page;
}

export interface PdfOptions {
  path?: string;
  scale?: number;
  pageRanges?: string;
}

export interface PdfRequest extends PdfOptions {
  printBackground: boolean;
  preferCSSPageSize: boolean;
}

export function pdf(page: PageLike, options: PdfOptions = {}): Promise<Uint8Array> {
  return page.pdf({
    path: options.path,
    scale: options.scale ?? 1,
    pageRanges: options.pageRanges ?? "1",
    printBackground: true,
    preferCSSPageSize: true,
  });
}

export function evaluate<T = unknown>(frame: FrameLike, fn: unknown, arg?: unknown): Promise<T> {
  return frame.evaluate(fn, arg) as Promise<T>;
}

export function select(frame: PageLike, selector: string): LocatorLike {
  return frame.locator(selector);
}

export function selectAll(frame: PageLike, selector: string): Promise<LocatorLike[]> {
  return frame.$$(selector);
}

// --- BROWSER STATE

export interface FrameLike {
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
  screenshot(options: ScreenshotOptions): Promise<Uint8Array>;
}

export interface LocatorLike extends FrameLike {
  waitFor(options: { state: string; timeout: number }): Promise<void>;
}

export interface PageLike extends LocatorLike {
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  waitForFunction(expression: string, arg: unknown, options: { timeout: number }): Promise<unknown>;
  locator(selector: string): LocatorLike;
  $$(selector: string): Promise<LocatorLike[]>;
  pdf(options: PdfRequest): Promise<Uint8Array>;
  emulateMedia(options: { media: string | null }): Promise<void>;
}

export interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface BrowserLike {
  newContext(options: unknown): Promise<ContextLike>;
  isConnected(): boolean;
  close(): Promise<void>;
}

export interface LaunchOptions {
  args: string[];
}

export type Launcher = (options: LaunchOptions) => Promise<BrowserLike>;

export interface PoolOptions {
  max: number;
  min: number;
  testOnBorrow: boolean;
  evictionRunIntervalMillis: number;
  numTestsPerEvictionRun: number;
  acquireTimeoutMillis: number;
  idleTimeoutMillis: number;
}

interface Entry {
  browser: BrowserLike;
  id: number;
  idleSince: number;
}

interface Waiter {
  resolve(): void;
}

export class BrowserPool {
  private readonly launch: Launcher;
  private readonly options: PoolOptions;
  private readonly idle: Entry[] = [];
  private readonly busy = new Set<Entry>();
  private waiters: Waiter[] = [];
  private creating = 0;
  private drained = false;
  private nextId = 1;
  private evictor: NodeJS.Timeout | undefined;

  constructor(launch: Launcher, options: PoolOptions) {
    this.launch = launch;
    this.options = options;

    this.evictor = setInterval(() => this.evict(), options.evictionRunIntervalMillis);
    // The http server keeps the process alive; a maintenance timer must not.
    this.evictor.unref();

    void this.warm();
  }

  private warm(): Promise<void> {
    return this.fill().catch((cause) => {
      log.warn({ hint: "unable to prewarm the browser pool", cause });
    });
  }

  private async fill(): Promise<void> {
    while (!this.drained && this.size() < this.options.min) {
      this.creating += 1;
      try {
        const entry = await this.spawn();
        if (this.drained) {
          await this.close(entry);
          return;
        }
        entry.idleSince = Date.now();
        this.idle.push(entry);
      } finally {
        this.creating -= 1;
      }
    }
  }

  private size(): number {
    return this.idle.length + this.busy.size + this.creating;
  }

  private async spawn(): Promise<Entry> {
    const browser = await this.launch({
      args: ["--allow-insecure-localhost", "--font-render-hinting=none"],
    });
    const id = this.nextId;
    this.nextId += 1;
    log.info({ origin: "factory", action: "create", "browser-id": id });
    return { browser, id, idleSince: 0 };
  }

  private async close(entry: Entry): Promise<void> {
    log.info({ origin: "factory", action: "destroy", "browser-id": entry.id });
    try {
      await entry.browser.close();
    } catch (cause) {
      log.warn({ hint: "unable to close the browser", "browser-id": entry.id, cause });
    }
  }

  private takeIdle(): Entry | undefined {
    while (this.idle.length > 0) {
      const entry = this.idle.pop() as Entry;
      if (!this.options.testOnBorrow) return entry;
      log.info({ origin: "factory", action: "validate", "browser-id": entry.id });
      if (entry.browser.isConnected()) return entry;
      void this.close(entry);
      this.wake();
    }
    return undefined;
  }

  private waitForSlot(): Promise<void> {
    if (this.drained) {
      return Promise.reject(
        new AppError({
          type: "internal",
          code: "browser-not-ready",
          hint: "browser pool is draining",
        }),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new TimeoutError("ResourceRequest timed out"));
      }, this.options.acquireTimeoutMillis);
      timer.unref();

      this.waiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  private wake(): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.resolve();
  }

  async acquire(): Promise<BrowserLike> {
    for (;;) {
      if (this.drained) {
        return raise({
          type: "internal",
          code: "browser-not-ready",
          hint: "browser pool is draining",
        });
      }

      const idle = this.takeIdle();
      if (idle !== undefined) {
        this.busy.add(idle);
        return idle.browser;
      }

      if (this.size() < this.options.max) {
        this.creating += 1;
        try {
          const entry = await this.spawn();
          this.busy.add(entry);
          return entry.browser;
        } finally {
          this.creating -= 1;
          this.wake();
        }
      }

      await this.waitForSlot();
    }
  }

  private entryOf(browser: BrowserLike): Entry | undefined {
    for (const entry of this.busy) if (entry.browser === browser) return entry;
    for (const entry of this.idle) if (entry.browser === browser) return entry;
    return undefined;
  }

  release(browser: BrowserLike): void {
    const entry = this.entryOf(browser);
    if (entry === undefined || !this.busy.has(entry)) return;

    this.busy.delete(entry);
    entry.idleSince = Date.now();
    this.idle.push(entry);
    this.wake();
  }

  async destroy(browser: BrowserLike): Promise<void> {
    const entry = this.entryOf(browser);
    if (entry === undefined) return;

    this.busy.delete(entry);
    const position = this.idle.indexOf(entry);
    if (position >= 0) this.idle.splice(position, 1);
    await this.close(entry);
    this.wake();
  }

  private evict(): void {
    const now = Date.now();
    let tested = 0;
    let removed = 0;

    for (let index = this.idle.length - 1; index >= 0; index -= 1) {
      if (tested >= this.options.numTestsPerEvictionRun) break;
      if (removed >= this.options.numTestsPerEvictionRun) break;
      tested += 1;

      const entry = this.idle[index];
      if (now - entry.idleSince < this.options.idleTimeoutMillis) continue;
      if (this.size() - 1 < this.options.min) break;

      this.idle.splice(index, 1);
      removed += 1;
      void this.close(entry);
    }

    if (removed > 0) this.wake();
    void this.warm();
  }

  // drain: stop handing out browsers and let the checked-out ones come back.
  async drain(): Promise<void> {
    this.drained = true;
    if (this.evictor !== undefined) clearInterval(this.evictor);
    this.waiters = [];
    while (this.busy.size > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  async clear(): Promise<void> {
    const entries = this.idle.splice(0);
    await Promise.all(entries.map((entry) => this.close(entry)));
  }

  async exec<T>(config: unknown, handle: (page: PageLike) => Promise<T>): Promise<T> {
    let browser: BrowserLike;
    try {
      browser = await this.acquire();
    } catch (cause) {
      throw translateBrowserError(cause);
    }

    const entry = this.entryOf(browser);

    try {
      const context = await browser.newContext(config);
      log.trace({ hint: "exec:handle:start", "browser-id": entry?.id });
      const page = await context.newPage();
      const result = await handle(page);
      await context.close();
      this.release(browser);
      log.trace({ hint: "exec:handle:end", "browser-id": entry?.id });
      return result;
    } catch (cause) {
      await this.destroy(browser);
      throw translateBrowserError(cause);
    }
  }
}

function translateBrowserError(cause: unknown): unknown {
  if (cause instanceof TimeoutError || (cause instanceof Error && cause.name === "TimeoutError")) {
    return new AppError(
      {
        type: "internal",
        code: "timeout",
        hint: cause instanceof Error ? cause.message : String(cause),
      },
      { cause },
    );
  }
  return cause;
}

export function createPool(launch: Launcher, options: PoolOptions): BrowserPool {
  return new BrowserPool(launch, options);
}

export function defaultLaunchOptions(): PoolOptions {
  return {
    max: get("browser-pool-max", 5),
    min: get("browser-pool-min", 0),
    testOnBorrow: true,
    evictionRunIntervalMillis: 5000,
    numTestsPerEvictionRun: 5,
    acquireTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
  };
}

function playwrightLauncher(): Launcher {
  return async (options) => {
    const playwright = load<{ chromium: { launch(request: LaunchOptions): Promise<BrowserLike> } }>(
      "playwright",
    );
    return playwright.chromium.launch(options);
  };
}

let pool: BrowserPool | undefined;

export async function init(): Promise<void> {
  const options = defaultLaunchOptions();
  log.info({ hint: "initializing browser pool", opts: options });
  pool = createPool(playwrightLauncher(), options);
}

export async function stop(): Promise<void> {
  if (pool === undefined) return;
  log.info({ hint: "finalizing browser pool" });
  const current = pool;
  pool = undefined;
  await current.drain();
  await current.clear();
}

// exec!: nil when the pool is not up, which the handlers surface as a 503.
export async function exec<T>(config: unknown, handle: (page: PageLike) => Promise<T>): Promise<T> {
  if (pool === undefined) {
    return raise({
      type: "internal",
      code: "browser-not-ready",
      hint: "browser pool is not initialized",
    });
  }
  return pool.exec(config, handle);
}

// Tests drive a pool they build themselves; the entry point still owns the
// module level one.
export function currentPool(): BrowserPool | undefined {
  return pool;
}

// Swaps the module level pool for a stand-in. The exec surface is all the
// renderers use, so a fake executor can drive them without playwright.
export interface Executor {
  exec<T>(config: unknown, handle: (page: PageLike) => Promise<T>): Promise<T>;
}

export function setExecutor(next: Executor | undefined): void {
  pool = next as BrowserPool | undefined;
}