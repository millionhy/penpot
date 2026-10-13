import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "@/lib/session";
import { UrlCompat } from "@/components/url-compat";
import { NotificationsProvider } from "@/components/notifications";
import { ModalProvider } from "@/components/modal";
import { PluginRuntime } from "@/components/plugin-runtime";
import { ThemeManager } from "@/components/theme";
import { LocaleGate } from "@/components/locale-gate";

export const metadata: Metadata = {
  title: "Penpot",
  description:
    "Penpot Next.js shell - Strangler Fig migration of the ClojureScript frontend.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="default">
      <body>
        <SessionProvider>
          <ThemeManager />
          <ModalProvider>
            <NotificationsProvider>
              <UrlCompat />
              <PluginRuntime />
              <LocaleGate>{children}</LocaleGate>
            </NotificationsProvider>
          </ModalProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
