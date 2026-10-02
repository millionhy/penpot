"use client";

// Query parameter access for the auth pages. The CLJS router hands every page
// a :query-params map; the App Router equivalent is useSearchParams, which
// Next.js only allows inside a Suspense boundary when the route is statically
// prerendered. This component is that boundary, so pages can read their params
// on the first render instead of after an effect.

import { Suspense, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

export interface QueryParamsProps {
  children: (params: URLSearchParams) => ReactNode;
  fallback?: ReactNode;
}

function QueryParamsInner({ children }: QueryParamsProps) {
  const params = useSearchParams();
  return <>{children(params)}</>;
}

export function QueryParams({ children, fallback = null }: QueryParamsProps) {
  return <Suspense fallback={fallback}>{<QueryParamsInner>{children}</QueryParamsInner>}</Suspense>;
}
