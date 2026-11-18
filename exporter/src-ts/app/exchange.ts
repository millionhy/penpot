// The exchange shape shared by the http adapter, the router and the handlers.
// The CLJS code carries one map with request/* and response/* keys; the TS port
// groups them, which keeps the handler signatures readable without changing the
// wire contract.

export interface ExchangeRequest {
  method: string;
  path: string;
  url: URL;
  headers: Record<string, string | undefined>;
  queryParams: Record<string, string>;
  // Query params merged with the decoded body params.
  params: Record<string, unknown>;
  cookies: Map<string, string>;
  authToken?: string;
  // Decoded application/transit+json body, when the request carries one.
  body?: unknown;
}

export interface ExchangeResponse {
  status?: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface Exchange {
  request: ExchangeRequest;
  response: ExchangeResponse;
}

export type Handler = (exchange: Exchange) => Exchange | Promise<Exchange>;

export function createExchange(request: ExchangeRequest): Exchange {
  return { request, response: { headers: {} } };
}