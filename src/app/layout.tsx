import type { Metadata } from "next";

import { AnalyticsProvider } from "@/components/analytics-provider";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "theugc.life",
    template: "%s · theugc.life",
  },
  description: "The operating system for travel UGC creators.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-background text-text antialiased">
        <AnalyticsProvider />
        {children}
      </body>
    </html>
  );
}
