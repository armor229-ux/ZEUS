import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // ZEUS is a static multi-page site served verbatim from /public.
  // Serve its own index.html at the root URL (no URL change, no React wrapper).
  // Clean-route rewrites mirror public/_redirects (Cloudflare Pages):
  // /anime, /genre, /discover resolve to their pages so nav-pill
  // clicks, direct loads and refreshes never 404 on this server.
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/index.html" },
        { source: "/anime", destination: "/anime.html" },
        { source: "/genre", destination: "/genre.html" },
        { source: "/discover", destination: "/browse.html" },
      ],
    };
  },
};

export default nextConfig;
