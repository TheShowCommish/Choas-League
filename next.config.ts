import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Player headshots come from the nflverse player release, which
    // points at the NFL's own CDN for every row we ingest.
    remotePatterns: [
      { protocol: "https", hostname: "static.www.nfl.com", pathname: "/image/**" },
    ],
  },
};

export default nextConfig;
