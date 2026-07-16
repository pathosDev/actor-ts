/**
 * Wraps `@fastify/static` registration via `FastifyBackend.withPlugin`,
 * so `main.ts` doesn't have to know about Fastify itself.
 *
 * Path layout the chat sample uses:
 *
 *   examples/chat/static/<framework>/   ← built frontend assets
 *
 * The plugin serves everything under `/static/<framework>/...`.  If
 * the directory doesn't exist yet (first run before any frontend has
 * been built) it's created empty so Fastify doesn't 404 the entire
 * subtree.  Individual missing files still 404 the standard way.
 */
import * as fs from 'node:fs';
import type { FastifyBackend } from '../../../../src/http/backend/FastifyBackend.js';

export interface StaticFilesOptions {
  /** Absolute path to the static-files root (`examples/chat/static`). */
  readonly root: string;
  /** URL prefix.  Default `/static/`. */
  readonly prefix?: string;
}

export async function registerStaticFiles(
  backend: FastifyBackend,
  options: StaticFilesOptions,
): Promise<void> {
  if (!fs.existsSync(options.root)) {
    fs.mkdirSync(options.root, { recursive: true });
  }
  // `@fastify/static` ships with both default and named exports
  // depending on the bundler — normalise.
  const mod = (await import('@fastify/static')) as {
    default?: unknown;
    fastifyStatic?: unknown;
  };
  const plugin = mod.default ?? mod.fastifyStatic ?? mod;
  await backend.withPlugin(plugin, {
    root: options.root,
    prefix: options.prefix ?? '/static/',
    decorateReply: false,
  });
}
