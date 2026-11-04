import type { Metadata, Viewport } from "next";
import { Literata, Schibsted_Grotesk } from "next/font/google";
import { getDictionary, getPrefs, getT, themeAttribute } from "@/lib/i18n";
import { I18nProvider } from "@/lib/i18n/client";
import "./globals.css";

const sans = Schibsted_Grotesk({ subsets: ["latin", "latin-ext"], variable: "--font-schibsted", display: "swap" });
const read = Literata({ subsets: ["latin", "latin-ext"], variable: "--font-literata", display: "swap" });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: { default: "My Graph", template: "%s · My Graph" },
    description: t("shell.meta.description", undefined, "Your private graph, with a source for every fact."),
    manifest: "/manifest.webmanifest",
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f1f3ef" },
    { media: "(prefers-color-scheme: dark)", color: "#121513" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const prefs = await getPrefs();
  return (
    <html lang={prefs.locale} data-theme={themeAttribute(prefs.theme)} className={`${sans.variable} ${read.variable}`}>
      <body>
        <I18nProvider locale={prefs.locale} timeZone={prefs.timeZone} messages={getDictionary(prefs.locale)}>{children}</I18nProvider>
      </body>
    </html>
  );
}
