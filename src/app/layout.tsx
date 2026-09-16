import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeScript } from "./theme";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Chaos League",
  description: "Fantasy football, scored on every stat in the box score.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Phones are the primary target; let people zoom anyway.
  maximumScale: 5,
  // The browser chrome cannot follow a theme chosen in localStorage, so
  // it stays on the dark default rather than fighting the page.
  themeColor: "#0b0d10",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: the boot script rewrites data-theme
    // before React hydrates, which is the whole point of it running
    // first, and React would otherwise flag the attribute it changed.
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">
        <ThemeScript />
        {children}
      </body>
    </html>
  );
}
