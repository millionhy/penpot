// Browser storage with the CLJS key layout. Port of app.util.storage:
// a storage is (backend, prefix) and a namespaced keyword ::name is stored
// under "<prefix>:<namespace>/<name>" with a transit-encoded value, so a shell
// tab and a CLJS tab on the same origin read each other's entries.
//
// The CLJS version is a debounced atom; the shell writes synchronously because
// every use here happens right before a navigation (login-redirect must survive
// the redirect, register email must survive the trip to the success page).

import { decodeTransit, encodeTransit } from "./transit";

export interface NamespacedStorage {
  get<T = unknown>(namespace: string, name: string): T | null;
  set(namespace: string, name: string, value: unknown): void;
  remove(namespace: string, name: string): void;
}

export function storageKey(prefix: string, namespace: string, name: string): string {
  return prefix + ":" + namespace + "/" + name;
}

function backend(kind: "local" | "session"): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    // Storage is disabled (private mode, sandboxed frame, data: URL).
    return null;
  }
}

export function createStorage(kind: "local" | "session", prefix: string): NamespacedStorage {
  return {
    get<T = unknown>(namespace: string, name: string): T | null {
      const store = backend(kind);
      if (store === null) return null;
      const raw = store.getItem(storageKey(prefix, namespace, name));
      if (raw === null) return null;
      try {
        return decodeTransit<T>(raw);
      } catch {
        return null;
      }
    },
    set(namespace: string, name: string, value: unknown): void {
      const store = backend(kind);
      if (store === null) return;
      store.setItem(storageKey(prefix, namespace, name), encodeTransit(value));
    },
    remove(namespace: string, name: string): void {
      const store = backend(kind);
      if (store === null) return;
      store.removeItem(storageKey(prefix, namespace, name));
    },
  };
}

// Same prefixes as the defonce storages in app.util.storage.
export const userStorage = createStorage("local", "penpot-user");
export const sessionStorage = createStorage("session", "penpot");

// Namespaces the shell writes to, matching the CLJS keyword namespaces.
export const REGISTER_NS = "app.main.ui.auth.register";
export const AUTH_NS = "app.main.data.auth";

// store-login-redirect / clear-login-redirect in app.main.ui.auth.login.
export function storeLoginRedirect(href: string): void {
  sessionStorage.set(AUTH_NS, "login-redirect", href);
}

export function clearLoginRedirect(): void {
  sessionStorage.remove(AUTH_NS, "login-redirect");
}

export function takeLoginRedirect(): string | null {
  const href = sessionStorage.get<string>(AUTH_NS, "login-redirect");
  clearLoginRedirect();
  return typeof href === "string" && href.length > 0 ? href : null;
}
