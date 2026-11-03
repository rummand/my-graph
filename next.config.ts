import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["tesseract.js", "unpdf", "mammoth", "postgres"],
  experimental: { serverActions: { bodySizeLimit: "50mb" } },
};

export default config;
