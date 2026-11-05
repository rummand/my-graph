import type { NextConfig } from "next";

/** Baseline security headers for every response (the file route adds its own stricter CSP). */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  // Same-origin framing only: the library page embeds PDFs from /api/files.
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: ["tesseract.js", "unpdf", "mammoth", "postgres"],
  experimental: { serverActions: { bodySizeLimit: "50mb" }, webpackMemoryOptimizations: true },
  /** Old addresses: the wiki became Pages under Artifacts, design sets became Styles. Links in stored pages still work. */
  async redirects() {
    return [
      { source: "/wiki", destination: "/artifacts/pages", permanent: true },
      { source: "/wiki/:path*", destination: "/artifacts/pages/:path*", permanent: true },
      { source: "/artifacts/design-sets", destination: "/artifacts/styles", permanent: true },
      { source: "/artifacts/design-sets/:path*", destination: "/artifacts/styles/:path*", permanent: true },
    ];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
