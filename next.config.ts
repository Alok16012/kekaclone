import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // bulk import uploads .xlsx files (capped at 5 MB in the importer)
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  partialPrefetching: true,
  // receipt OCR runs tesseract.js (WebAssembly + worker threads) in the Node process; keep it out of the bundler
  serverExternalPackages: ["tesseract.js"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
