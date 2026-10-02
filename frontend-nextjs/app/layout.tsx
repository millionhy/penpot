import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "@/lib/session";
import { UrlCompat } from "@/components/url-compat";
import { NotificationsProvider } from "@/components/notifications";

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
    <html lang="en" className="light">
      <body>
        <SessionProvider>
          <NotificationsProvider>
            <UrlCompat />
            {children}
          </NotificationsProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
