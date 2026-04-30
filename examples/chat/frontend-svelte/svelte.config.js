import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      // Static export — the chat backend's @fastify/static plugin
      // serves the bundle.  No SSR runtime needed.
      pages: 'build',
      assets: 'build',
      fallback: 'index.html',
      precompress: false,
      strict: true,
    }),
    paths: {
      base: '/static/svelte',
      relative: false,
    },
    prerender: {
      handleHttpError: 'warn',
    },
  },
};

export default config;
