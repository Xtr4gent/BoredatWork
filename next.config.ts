import type { NextConfig } from "next";

// No blanket CORS header: the app is same-origin, and /api/status sets its
// own Access-Control-Allow-Origin for external consumers. Opening every
// route to cross-origin callers invites third-party traffic (= egress cost).
const nextConfig: NextConfig = {};

export default nextConfig;
