// Inline banner used by the auth pages (context-notification* in
// app.main.ui.auth.login). Distinct from the toast in
// components/notifications.tsx: this one is part of the page flow.

import type { ReactNode } from "react";

export type ContextNotificationLevel = "error" | "warning" | "info" | "success";

export interface ContextNotificationProps {
  level: ContextNotificationLevel;
  children: ReactNode;
}

export function ContextNotification({ level, children }: ContextNotificationProps) {
  return (
    <div className={"auth-context-notification auth-context-notification-" + level} role="alert">
      {children}
    </div>
  );
}
