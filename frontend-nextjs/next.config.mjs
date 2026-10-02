// Next.js configuration for the Penpot Next.js shell.
//
// Strangler Fig seam: the browser talks to a single origin. In dev, Next
// rewrites proxy /api/* and /assets/* to the running Clojure backend
// (backend:6060). In production the existing nginx already proxies these to
// backend:6060, so the same relative URLs work unchanged.
//
// NOTE: WebSocket (/ws/notifications) is NOT proxied by Next rewrites (they do
// not forward the HTTP upgrade). The collab socket connects directly to the
// backend origin configured in lib/config.ts. This keeps the backend untouched.

import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const backendOrigin = process.env.PENPOT_BACKEND_ORIGIN ?? "http://localhost:6060";

const nextConfig = {
  reactStrictMode: true,
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
        destination: `${backendOrigin}/assets/:path*`,
      },
    ];
  },
};

export default nextConfig;