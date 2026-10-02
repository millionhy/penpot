"use client";

// Toast notifications. Port of the app.main.data.notifications surface the
// migrated pages use: a single notification slot (a new show replaces the
// previous one), 7s auto-hide for success/info/warning, errors that persist
// until dismissed, and an implicit hide on route change.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";

export type NotificationLevel = "success" | "error" | "info" | "warning";

export const defaultTimeout = 7000;

export interface Notification {
  level: NotificationLevel;
  content: string;
  // Omitted for errors, which stay until dismissed (see ntf/error).
  timeout?: number;
}

export interface NotificationsApi {
  notification: Notification | null;
  show: (notification: Notification) => void;
  hide: () => void;
  success: (content: string, timeout?: number) => void;
  info: (content: string, timeout?: number) => void;
  warn: (content: string, timeout?: number) => void;
  error: (content: string) => void;
}

const defaultValue: NotificationsApi = {
  notification: null,
  show: () => undefined,
  hide: () => undefined,
  success: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const NotificationsContext = createContext<NotificationsApi>(defaultValue);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notification, setNotification] = useState<Notification | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathname = usePathname();

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    setNotification(null);
  }, [clearTimer]);

  const show = useCallback(
    (next: Notification) => {
      clearTimer();
      setNotification(next);
      if (next.timeout !== undefined && next.timeout > 0) {
        timer.current = setTimeout(() => setNotification(null), next.timeout);
      }
    },
    [clearTimer],
  );

  // ntf/show also hides on navigation to a different route.
  useEffect(() => {
    clearTimer();
    setNotification(null);
  }, [pathname, clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  // The level helpers are stable so callers can put them in effect deps.
  const success = useCallback(
    (content: string, timeout: number = defaultTimeout) => show({ level: "success", content, timeout }),
    [show],
  );
  const info = useCallback(
    (content: string, timeout: number = defaultTimeout) => show({ level: "info", content, timeout }),
    [show],
  );
  const warn = useCallback(
    (content: string, timeout: number = defaultTimeout) => show({ level: "warning", content, timeout }),
    [show],
  );
  const error = useCallback((content: string) => show({ level: "error", content }), [show]);

  const value = useMemo<NotificationsApi>(
    () => ({ notification, show, hide, success, info, warn, error }),
    [notification, show, hide, success, info, warn, error],
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
      {notification !== null ? (
        <div className="pp-toast-region" role="status" aria-live="polite">
          <div className={"pp-toast pp-toast-" + notification.level}>
            <span className="pp-toast-content">{notification.content}</span>
            <button
              type="button"
              className="pp-toast-close"
              aria-label="Close notification"
              onClick={hide}
            >
              &times;
            </button>
          </div>
        </div>
      ) : null}
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): NotificationsApi {
  return useContext(NotificationsContext);
}
