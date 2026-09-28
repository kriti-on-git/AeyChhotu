import type { NextConfig } from "next";

/* Security headers applied to every response. The backend (Express/helmet)
   owns its own set; these cover the page shell. CSP is deliberately not set
   here yet: the app inlines Tailwind and Next's bootstrap scripts, so a
   real policy needs nonce plumbing — a wrong one blanks the whole app. */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
