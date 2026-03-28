import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep heic-convert as an external require() so Next.js doesn't bundle its
  // WASM binary — bundling breaks the WASM loader at runtime.
  serverExternalPackages: ['heic-convert'],
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
};

export default nextConfig;
