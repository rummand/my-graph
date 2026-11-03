import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "My Graph", template: "%s · My Graph" },
  description: "Your family's private brain, with a source for every fact.",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = { themeColor: "#2f6f5e", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
