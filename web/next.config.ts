import type { NextConfig } from "next";
import path from "node:path";

const isIpfs = process.env.NEXT_PUBLIC_IPFS_BUILD === "true";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  eslint: {
    ignoreDuringBuilds: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  webpack: config => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@farcaster/mini-app-solana": path.resolve(__dirname, "./shims/farcaster-mini-app-solana.ts"),
    };
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
  ...(isIpfs
    ? {}
    : {
        async redirects() {
          return [
            {
              source: "/operator/submissions",
              destination: "/robomata/submissions",
              permanent: false,
            },
            {
              source: "/operator/submissions/:submissionId",
              destination: "/robomata/submissions/:submissionId",
              permanent: false,
            },
            {
              source: "/partner/submissions",
              destination: "/robomata/submissions",
              permanent: false,
            },
            {
              source: "/partner/submissions/:submissionId",
              destination: "/robomata/submissions/:submissionId",
              permanent: false,
            },
          ];
        },
      }),
};

if (isIpfs) {
  nextConfig.output = "export";
  nextConfig.trailingSlash = true;
  nextConfig.images = {
    unoptimized: true,
  };
}

module.exports = nextConfig;
