import type { NextConfig } from "next";


// Page CSP is nonce-based and set per request in src/middleware.ts (E2EE-67).
const apiCsp = "default-src 'none'; frame-ancestors 'none'";

const nextConfig: NextConfig = {
  productionBrowserSourceMaps: false, // ARCH-003
  poweredByHeader: false,
  // /api/* is served by the route handler at src/app/api/[...path]/route.ts (E2EE-68).
  async headers() {
    return [
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: apiCsp }] },
      {
        source: "/:path*",
        headers: [
                    { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};
export default nextConfig;
