// app.renderer.pdf: one pdf per object.
//
// Each object reloads render.html with a single `object-id`, so the page has
// one measurable node. Before printing, a style block pins the page size to the
// node's width/height: the pdf has to be exactly the shape of the exported
// object, and `preferCSSPageSize` makes playwright honour that block.

import * as browser from "../browser.js";
import { getInternalUri } from "../config.js";
import { createLogger, setLevel } from "../logging.js";
import type { RenderObject, RenderParams } from "../renderer.js";
import { ensurePathSlash, join, mapToQueryString, withQuery } from "../uri.js";
import { getExtension } from "../util/mime.js";
import { tempfile } from "../util/shell.js";

const log = createLogger("app.renderer.pdf");
setLevel("app.renderer.pdf", "trace");

export function prepareOptions(uri: URL, scale: number, token: string | undefined): unknown {
  return {
    screen: { width: browser.defaultViewportWidth, height: browser.defaultViewportHeight },
    viewport: { width: browser.defaultViewportWidth, height: browser.defaultViewportHeight },
    locale: "en-US",
    storageState: { cookies: browser.createCookies(uri, { token }) },
    deviceScaleFactor: scale,
    userAgent: browser.defaultUserAgent,
  };
}

export function renderUri(params: RenderParams, baseUri: string | URL, objectId: string): URL {
  const query = mapToQueryString({
    "file-id": params["file-id"],
    "page-id": params["page-id"],
    "share-id": params["share-id"],
    "object-id": objectId,
    route: "objects",
  });

  return withQuery(join(baseUri, "render.html"), query);
}

// Runs in the page. No library runtime is available there: only browser
// primitives, and the only input is the node playwright passes as the first
// argument.
const SYNC_PAGE_SIZE = `(elem) => {
  var width = elem.getAttribute("width");
  var height = elem.getAttribute("height");
  var node = document.createElement("style");
  document.head.appendChild(node);
  node.textContent =
    "@page { size: " + width + "px " + height + "px; margin: 0; }\\n" +
    "html, body, #app { margin: 0; padding: 0; width: " + width +
    "px; height: " + height + "px; overflow: visible; }";
}`;

export function syncPageSize(dom: browser.LocatorLike): Promise<unknown> {
  return browser.evaluate(dom, SYNC_PAGE_SIZE);
}

async function renderObject(
  page: browser.PageLike,
  params: RenderParams,
  baseUri: URL,
  onObject: (object: RenderObject) => void,
  object: RenderObject,
): Promise<void> {
  const uri = renderUri(params, baseUri, object.id);
  const path = tempfile({ prefix: "penpot.tmp.pdf.", suffix: getExtension("pdf") });

  log.info({ uri: uri.toString() });
  await browser.navigate(page, uri);

  const dom = browser.select(page, `#screenshot-${object.id}`);
  await browser.waitFor(dom);
  await syncPageSize(dom);
  await browser.screenshot(dom, { fullPage: true });
  await browser.sleep(page, 2000); // the good old fix with sleep
  await browser.waitForFonts(page);
  await browser.pdf(page, { path });

  onObject({ ...object, path });
}

export async function render(params: RenderParams, onObject: (object: RenderObject) => void): Promise<void> {
  const baseUri = ensurePathSlash(getInternalUri());

  return browser.exec(prepareOptions(baseUri, params.scale, params.token), async (page) => {
    for (const object of params.objects) {
      await renderObject(page, params, baseUri, onObject, object);
    }
  });
}