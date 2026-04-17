import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: true, // gzip responses — important for mobile/cellular
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
    proxyClientMaxBodySize: 50 * 1024 * 1024, // 50MB — default is 10MB, truncates large screenshots
  },
};

export default nextConfig;
