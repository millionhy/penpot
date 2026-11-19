// app.renderer.bitmap: png, jpeg and webp exports.
//
// One browser context per render call, one page, one render.html load; the
// requested objects are captured one after another from the `#screenshot-<id>`
// nodes. Playwright only writes png and jpeg, so webp goes through ImageMagick
// afterwards, exactly as the CLJS exporter did.

import * as browser from "../browser.js";
import { getInternalUri } from "../config.js";
import { createLogger, setLevel } from "../logging.js";
import type { RenderObject, RenderParams } from "../renderer.js";
import { ensurePathSlash, join, mapToQueryString, withQuery } from "../uri.js";
import { getExtension, type ExportType } from "../util/mime.js";
import { runCmd, tempfile } from "../util/shell.js";

const log = createLogger("app.renderer.bitmap");
setLevel("app.renderer.bitmap", "trace");

const TRANSPARENT_BACKGROUND = "() => { document.body.style.background = 'transparent'; }";

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

export function renderUri(params: RenderParams): URL {
  const query = mapToQueryString({
    "file-id": params["file-id"],
    "page-id": params["page-id"],
    "share-id": params["share-id"],
    "object-id": params.objects.map((object) => object.id),
    route: "objects",
    "skip-children": params["skip-children"],
  });

  return withQuery(join(ensurePathSlash(getInternalUri()), "render.html"), query);
}

async function renderObject(
  page: browser.PageLike,
  type: ExportType,
  onObject: (object: RenderObject) => void,
  object: RenderObject,
): Promise<void> {
  const path = tempfile({ prefix: "penpot.tmp.bitmap.", suffix: getExtension(type) });
  const node = browser.select(page, `#screenshot-${object.id}`);

  await browser.waitFor(node);

  switch (type) {
    case "png":
      await browser.screenshot(node, { omitBackground: true, type: "png", path });
      break;
    case "jpeg":
      await browser.screenshot(node, { omitBackground: false, type: "jpeg", path });
      break;
    case "webp": {
      // playwright only supports jpg and png, convert it afterwards
      const pngPath = tempfile({ prefix: "penpot.tmp.bitmap.", suffix: ".png" });
      await browser.screenshot(node, { omitBackground: true, type: "png", path: pngPath });
      await runCmd("convert", [pngPath, "-quality", "100", `WEBP:${path}`]);
      break;
    }
    default:
      break;
  }

  onObject({ ...object, path });
}

export async function render(params: RenderParams, onObject: (object: RenderObject) => void): Promise<void> {
  const type = params.type as ExportType;
  const uri = renderUri(params);

  return browser.exec(prepareOptions(uri, params.scale, params.token), async (page) => {
    log.info({ uri: uri.toString() });

    await browser.navigate(page, uri);
    await browser.sleep(page, 1000); // the good old fix with sleep
    await browser.waitForFonts(page);
    await browser.evaluate(page, TRANSPARENT_BACKGROUND);

    for (const object of params.objects) {
      await renderObject(page, type, onObject, object);
    }
  });
}