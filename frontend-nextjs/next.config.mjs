// Next.js configuration for the Penpot Next.js shell.
//
// Strangler Fig seam: the browser talks to a single origin. In dev, Next
// rewrites proxy /api/* to the running Clojure backend (backend:6060),
// /assets/* and /internal/* to PENPOT_ASSETS_ORIGIN. In production the
// existing nginx already proxies all three, so the same relative URLs work
// unchanged.
//
// NOTE: WebSocket (/ws/notifications) is NOT proxied by Next rewrites (they do
// not forward the HTTP upgrade). The collab socket connects directly to the
// backend origin configured in lib/config.ts. This keeps the backend untouched.

import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const backendOrigin = process.env.PENPOT_BACKEND_ORIGIN ?? "http://localhost:6060";
// With PENPOT_OBJECTS_STORAGE_BACKEND=fs the backend answers /assets/* with an
// empty 204 plus an x-accel-redirect header (serve-object-from-fs in
// backend/src/app/http/assets.clj). Only nginx turns that into the file: its
// internal /assets location aliases the storage directory
// (docker/images/files/nginx.conf.template). Next rewrites cannot, so in dev
// point this at the running penpot frontend nginx to get real bytes. Leave it
// unset in production, where nginx already sits in front of the shell.
const assetsOrigin = process.env.PENPOT_ASSETS_ORIGIN ?? backendOrigin;

const nextConfig = {
  reactStrictMode: true,
  // @penpot/api-types ships raw TS sources (generated contract types).
  transpilePackages: ["@penpot/api-types"],
  // frontend-nextjs is a self-contained workspace with its own lockfile; pin the
  // tracing root here so Next does not infer the monorepo root (silences the
  // "multiple lockfiles" warning and keeps output tracing local).
  outputFileTracingRoot: currentDir,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${backendOrigin}/api/:path*`,
      },
      {
        source: "/assets/:path*",
        destination: `${assetsOrigin}/assets/:path*`,
      },
      {
        // The Google Fonts provider (the compiled render-wasm fetches text
        // fonts under this prefix; enabled by default). nginx answers it in
        // production through its own upstream (nginx-external-locations
        // .conf), so point dev at the same frontend origin as the assets.
        source: "/internal/:path*",
        destination: `${assetsOrigin}/internal/:path*`,
      },
    ];
  },
  // The @penpot/* renderer dependencies are `link:` packages that live outside
  // this workspace (../frontend/packages/...). webpack resolves a linked file
  // from its own directory, so the bare imports inside those trees (draft-js,
  // draft-js/lib/..., immutable, the tokenscript interpreter) walk up
  // ../frontend — which has no node_modules here — and fail. Redirect exactly
  // those specifiers to this workspace's copies.
  webpack: (config) => {
    const linkedTreeSpecifiers = [
      "draft-js",
      "immutable",
      "@tokens-studio/tokenscript-interpreter",
    ];
    config.resolve.alias = {
      ...config.resolve.alias,
      ...Object.fromEntries(
        linkedTreeSpecifiers.map((name) => [name, path.join(currentDir, "node_modules", name)]),
      ),
    };
    return config;
  },
};

export default nextConfig;