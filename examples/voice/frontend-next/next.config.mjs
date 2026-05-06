/**
 * Next.js produces an entirely-static export so the actor-ts chat
 * backend's @fastify/static plugin can serve the bundle as-is.
 *
 * `basePath` + `assetPrefix` make every internal link target
 * `/static/next/...`, matching where the backend mounts the
 * directory.  `trailingSlash: true` keeps Next from emitting
 * extension-less URLs that would 404 against `@fastify/static`.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath: '/static/next',
  assetPrefix: '/static/next/',
  trailingSlash: true,
  images: { unoptimized: true },
  // Keeps the production build self-contained — no need for a server
  // runtime when the actor-ts backend is the one serving HTML.
  reactStrictMode: true,
};

export default nextConfig;
