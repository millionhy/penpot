// app.common.uri, reduced to the operations the exporter performs. The CLJS
// version wraps lambdaisland.uri; here the same four moves run on WHATWG URL:
// ensure a trailing path slash, resolve a relative path, read/write a query
// string, and build the render.html query of the browser renderers.

export function parse(value: string): URL {
  return new URL(value);
}

// u/ensure-path-slash: the internal URI is used as a base, so it needs the
// trailing slash or `new URL` would replace the last segment.
export function ensurePathSlash(value: string | URL): URL {
  const url = typeof value === "string" ? new URL(value) : value;
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

export function join(base: string | URL, path: string): URL {
  return new URL(path, base);
}

export function getDomain(url: URL): string {
  return url.port.length > 0 ? `${url.hostname}:${url.port}` : url.hostname;
}

function encodeValue(value: unknown): string {
  return String(value);
}

// u/map->query-string: nil values are dropped and a sequential value repeats
// the key (the render URL carries one object-id per exported object).
export function mapToQueryString(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) search.append(key, encodeValue(item));
      }
    } else {
      search.append(key, encodeValue(value));
    }
  }
  return search.toString();
}

export function queryStringToMap(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  const params = new URLSearchParams(query);
  for (const [key, value] of params) out[key] = value;
  return out;
}

export function withQuery(url: URL, query: string): URL {
  const result = new URL(url.toString());
  result.search = query.length > 0 ? `?${query}` : "";
  return result;
}