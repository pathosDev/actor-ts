/**
 * Static site serving — a whole directory plus a single-file route.
 *
 *   bun run examples/http/static-site.ts
 *   open http://localhost:8080/           # index.html
 *   open http://localhost:8080/sub/       # directory listing (browsing on)
 *   curl -I http://localhost:8080/logo.svg
 *
 * `getFromBrowseableDirectory` maps the URL onto the assets directory
 * (index resolution + a listing where there is no index); `getFromFile`
 * serves one file with the right MIME type.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActorSystem,
  concat,
  getFromBrowseableDirectory,
  getFromFile,
  path,
} from '../../src/index.js';

const assets = join(fileURLToPath(new URL('.', import.meta.url)), 'static-site-assets');

async function main(): Promise<void> {
  const system = ActorSystem.create('static-site');

  const routes = concat(
    // A single file at an explicit route, served with its detected MIME type.
    path('logo.svg', getFromFile(join(assets, 'logo.svg'))),
    // The whole assets tree at the root, with directory browsing enabled.
    getFromBrowseableDirectory(assets),
  );

  const binding = await system.http(8080, { host: '127.0.0.1' }).bind(routes);
  system.log.info(`static site on http://${binding.host}:${binding.port}/`);

  process.on('SIGINT', async () => {
    await binding.unbind();
    await system.terminate();
    process.exit(0);
  });
}

void main();
