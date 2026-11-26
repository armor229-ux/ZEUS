import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // ZEUS is a static multi-page site served verbatim from /public.
  // Serve its own index.html at the root URL (no URL change, no React wrapper).
  // Clean-route rewrites mirror public/_redirects (Cloudflare Pages) 1:1 so
  // every clean URL resolves identically on this dev server and in production:
  // beforeFiles carries the 16 explicit routes, and the /* -> /index.html
  // fallback lives in afterFiles — after the /public files are checked — so
  // real assets (css/js/images) still win, exactly like Cloudflare Pages
  // evaluates _redirects only for paths that match no existing file.
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/index.html" },
        { source: "/anime", destination: "/anime.html" },
        { source: "/genre", destination: "/genre.html" },
        { source: "/discover", destination: "/browse.html" },
        { source: "/search", destination: "/search.html" },
        { source: "/watchlist", destination: "/watchlist.html" },
        { source: "/library", destination: "/watchlist.html" },
        { source: "/settings", destination: "/settings.html" },
        { source: "/account", destination: "/account.html" },
        { source: "/login", destination: "/login.html" },
        { source: "/movie", destination: "/movie.html" },
        { source: "/tv", destination: "/tv.html" },
        { source: "/watch", destination: "/watch.html" },
        { source: "/party", destination: "/party.html" },
        { source: "/terms", destination: "/terms.html" },
        { source: "/privacy", destination: "/privacy.html" },
        { source: "/dmca", destination: "/dmca.html" },
      ],
      afterFiles: [
        { source: "/:path*", destination: "/index.html" },
      ],
    };
  },
};

export default nextConfig;
