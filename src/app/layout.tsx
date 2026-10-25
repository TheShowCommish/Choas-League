import type { Metadata, Viewport } from "next";
import { Inter, Oswald } from "next/font/google";
import "./globals.css";
import { ThemeScript } from "./theme";

// Inter carries the UI and body text: a neutral, highly legible grotesque
// that reads nothing like the create-next-app default it replaces.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
// Oswald is the condensed display face -- the wordmark, headings and every
// score. A sports-broadcast condensed that makes the numbers feel like a
// scoreboard rather than body copy. Variable weight, so no weight list.
const oswald = Oswald({ variable: "--font-oswald", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Chaos League",
  description: "Fantasy football, scored on every stat in the box score.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Phones are the primary target; let people zoom anyway.
  maximumScale: 5,
  // Draw to the screen edges so env(safe-area-inset-*) reports the home
  // indicator and notch; the bottom nav and body pad themselves clear.
  viewportFit: "cover",
  // The browser chrome cannot follow a theme chosen in localStorage, so
  // it stays on the dark default rather than fighting the page. Matched to
  // the retuned --background of the Chaos dark base.
  themeColor: "#090b0e",
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
      className={`${inter.variable} ${oswald.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">
        <ThemeScript />
        {children}
      </body>
    </html>
  );
}
