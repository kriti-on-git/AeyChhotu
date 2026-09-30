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
  /* Dish photography is resolved in the frontend (lib/diner/food-photos)
     because the menu contract has no image column. Only that host is allowed
     through the optimiser; anything else stays a plain remote URL. */
  images: {
    remotePatterns: [{ protocol: "https", hostname: "images.unsplash.com" }],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
