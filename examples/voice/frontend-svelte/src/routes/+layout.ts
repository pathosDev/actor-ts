// Disable SSR for this client-only chat app — there is no server
// runtime; the build is a fully static export served by the actor-ts
// chat backend's @fastify/static plugin.
export const ssr = false;
export const prerender = true;
