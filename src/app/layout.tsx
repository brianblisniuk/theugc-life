import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import Script from "next/script";

import { AnalyticsProvider } from "@/components/analytics-provider";
import { assertContactProvider } from "@/lib/contacts/provider";
import { THEME_BOOT_SCRIPT } from "@/lib/ux02/theme";

import "./globals.css";
import "./ux02.css";

/** Archivo is the V1 product face (D053). next/font self-hosts it at build time. */
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

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  assertContactProvider();
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body
        className={`${archivo.className} ${archivo.variable} min-h-dvh bg-background text-text antialiased`}
      >
        <Script id="ux02-theme" strategy="beforeInteractive">
          {THEME_BOOT_SCRIPT}
        </Script>
        <AnalyticsProvider />
        {children}
      </body>
    </html>
  );
}
