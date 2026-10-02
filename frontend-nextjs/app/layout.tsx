import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "@/lib/session";
import { UrlCompat } from "@/components/url-compat";

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
          <UrlCompat />
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}