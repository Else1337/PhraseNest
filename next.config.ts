import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  devIndicators: false,
  headers(){return [{source:"/:path*",headers:[
    {key:"X-Content-Type-Options",value:"nosniff"},
    {key:"X-Frame-Options",value:"DENY"},
    {key:"Referrer-Policy",value:"strict-origin-when-cross-origin"},
    {key:"Content-Security-Policy",value:"object-src 'none'; base-uri 'self'; frame-ancestors 'none'"}
  ]}];},
  // Local Webpack should not repeatedly bundle the entire agent runtime. The
  // Cloudflare build does not set this flag and still bundles its dependencies.
  ...((process.env.ZHIBI_LOCAL_PREVIEW === "1" || process.env.ZHIBI_NODE_DEPLOY === "1") ? { serverExternalPackages: ["@mastra/core", "@mastra/memory", "@mastra/libsql", "@mastra/pg", "@mastra/cloudflare-d1", "@ai-sdk/deepseek", "ai", "postgres", "minio", "unpdf", "@napi-rs/canvas"] } : {}),
  experimental: {
    // Keep the existing 10MB file allowance plus multipart framing intact.
    // Proxy still rejects envelopes above 12MB; business file limits stay 10MB.
    proxyClientMaxBodySize:"12mb",
    serverActions: {
      bodySizeLimit: "8mb"
    }
  }
};

export default nextConfig;
