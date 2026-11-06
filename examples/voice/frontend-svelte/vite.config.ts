import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// SvelteKit 3 takes its configuration through the plugin; a
// `svelte.config.js` beside this file is refused at build time.
export default defineConfig({
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
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
    }),
  ],
});
