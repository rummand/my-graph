/** Formatting for the admin console (pure). */

/** 0 → "0 B", 1536 → "1.5 KB", 5_300_000 → "5.1 MB" (binary units, one decimal under 10). */
export function formatBytes(n: number, locale: "en" | "da" = "en"): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = i === 0 || v >= 10 ? 0 : 1;
  return `${v.toLocaleString(locale === "da" ? "da-DK" : "en-GB", { maximumFractionDigits: digits, minimumFractionDigits: 0 })} ${units[i]}`;
}
