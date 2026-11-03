import type { Metadata, Viewport } from "next";
import { Literata, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";

const sans = Schibsted_Grotesk({ subsets: ["latin", "latin-ext"], variable: "--font-schibsted", display: "swap" });
const read = Literata({ subsets: ["latin", "latin-ext"], variable: "--font-literata", display: "swap" });

export const metadata: Metadata = {
  title: { default: "My Graph", template: "%s · My Graph" },
  description: "Your family's private brain, with a source for every fact.",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f1f3ef" },
    { media: "(prefers-color-scheme: dark)", color: "#121513" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${read.variable}`}>
      <body>{children}</body>
    </html>
  );
}
