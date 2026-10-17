import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import { headers } from "next/headers";

import { AnalyticsProvider } from "@/components/analytics-provider";
import { assertContactProvider } from "@/lib/contacts/provider";
import { htmlLangFromPath } from "@/lib/http/html-lang";

import "./globals.css";
import "./midnight.css";
import "./screens.css";
import "./v2-screens.css";

/** Archivo is the product face. next/font self-hosts it at build time. */
const archivo = Archivo({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-archivo",
});

export const metadata: Metadata = {
  title: {
    default: "theugc.life",
    template: "%s · theugc.life",
  },
  description: "The operating system for travel UGC creators.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  assertContactProvider();
  // Dynamic on purpose. Middleware puts the per-request CSP on the forwarded
  // request; Next stamps that nonce onto its scripts only when this layout
  // renders per request. A static shell would ship scripts the policy blocks.
  const headerList = await headers();
  const lang = htmlLangFromPath(headerList.get("x-pathname"));
  return (
    <html lang={lang}>
      <body
        className={`${archivo.className} ${archivo.variable} min-h-dvh bg-background text-text antialiased`}
      >
        <AnalyticsProvider />
        {children}
      </body>
    </html>
  );
}
