/**
 * What the pages say about HSTS, held to what the code does (#1462).
 *
 * Two claims went out with the `actor-ts.http.hsts` block that the code did
 * not bear out.  The first, that a configuration file cannot switch HSTS off,
 * held for `max-age = 0` only: a `1` un-pinned every client a second later.
 * The reader now refuses everything below a day, so each page that states
 * the rule has to state that floor — the number taken from the constant the
 * reader checks, not from a second copy.  The second, that the backend's own
 * 404 carries the server-wide policy, was never true: a path no route
 * matches is answered by the backend, outside every decorator, and carries
 * no Strict-Transport-Security at all (#1059).  The body-parse 413 half of
 * the same sentence does hold.  Both halves are bound below on every
 * backend, so the day #1059 is fixed this file says which sentence to change.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { REFERENCE_CONF } from '../../../../src/config/Reference.js';
import { ExpressBackend } from '../../../../src/http/backend/ExpressBackend.js';
import { FastifyBackend } from '../../../../src/http/backend/FastifyBackend.js';
import { HonoBackend } from '../../../../src/http/backend/HonoBackend.js';
import type { HttpServerBackend, ServerBinding } from '../../../../src/http/backend/HttpServerBackend.js';
import { MINIMUM_CONFIGURED_HSTS_MAX_AGE_SECONDS } from '../../../../src/http/Constants.js';
import { HttpExtensionId } from '../../../../src/http/HttpExtension.js';
import { SecurityHeadersOptions } from '../../../../src/http/middleware/SecurityHeadersOptions.js';
import { complete, concat, fallback, path, post, type Route } from '../../../../src/http/Route.js';
import { Status } from '../../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', '..', 'docs', 'src', 'content', 'docs');

/**
 * A docs page by its path under `docs/src/content/docs`, line breaks and HOCON
 * comment markers folded away.  An MDX comment renders nothing, so it is cut
 * first: a sentence that lives only in one does not count as said.
 */
function prose(relativeOrText: string, isText = false): string {
  const text = isText ? relativeOrText : readFileSync(join(DOCS_ROOT, relativeOrText), 'utf8');
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*#[ \t]?/gm, '')
    .replace(/\s+/g, ' ');
}

describe('the floor a configured max-age is held to, as the pages state it', () => {
  test('is one day', () => {
    expect(MINIMUM_CONFIGURED_HSTS_MAX_AGE_SECONDS).toBe(86_400);
  });

  // Every place that states the rule names the floor, and none still says
  // that refusing 0 keeps switching HSTS off code-only — a 1 did it too.
  test.each([
    ['reference.conf', prose(REFERENCE_CONF, true), `a max-age below ${MINIMUM_CONFIGURED_HSTS_MAX_AGE_SECONDS} (one day) is refused with a ConfigError naming the key and the floor`, 'so switching HSTS off is code-only'],
    ['reference/configuration.mdx', prose('reference/configuration.mdx'), `A \`max-age\` below \`${MINIMUM_CONFIGURED_HSTS_MAX_AGE_SECONDS}\` — one day — is refused with a \`ConfigError\` naming the key and the floor`, 'switching HSTS off stays code-only'],
    ['de/reference/configuration.mdx', prose('de/reference/configuration.mdx'), `Ein \`max-age\` unter \`${MINIMUM_CONFIGURED_HSTS_MAX_AGE_SECONDS}\` — einem Tag — wird mit einem \`ConfigError\` abgelehnt, der den Key und die Untergrenze nennt`, 'HSTS abschalten bleibt dem Code vorbehalten'],
    ['http/middleware/security-headers.mdx', prose('http/middleware/security-headers.mdx'), `A \`max-age\` below \`${MINIMUM_CONFIGURED_HSTS_MAX_AGE_SECONDS}\` — one day — is refused there with a \`ConfigError\``, 'switching HSTS off stays code-only'],
    ['de/http/middleware/security-headers.mdx', prose('de/http/middleware/security-headers.mdx'), `Ein \`max-age\` unter \`${MINIMUM_CONFIGURED_HSTS_MAX_AGE_SECONDS}\` — einem Tag — wird dort mit einem \`ConfigError\` abgelehnt`, 'HSTS abschalten bleibt also dem Code vorbehalten'],
  ])('%s', (_where, text, floorSentence, retired) => {
    expect(text).toContain(floorSentence);
    expect(text).not.toContain(retired);
  });

  test.each([
    ['reference/configuration.mdx', `\`0\` and anything below \`${MINIMUM_CONFIGURED_HSTS_MAX_AGE_SECONDS}\` (a day) are refused here; code may set any value.`],
    ['de/reference/configuration.mdx', `\`0\` und alles unter \`${MINIMUM_CONFIGURED_HSTS_MAX_AGE_SECONDS}\` (einem Tag) werden hier abgelehnt; Code darf jeden Wert setzen.`],
  ])('%s: the max-age row', (path, clause) => {
    const rows = readFileSync(join(DOCS_ROOT, path), 'utf8').split(/\r?\n/).filter((line) => line.startsWith('| `http.hsts.max-age` |'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(clause);
    expect(rows[0]).not.toContain('`0` is refused. |');
    expect(rows[0]).not.toContain('`0` wird abgelehnt. |');
  });
});

describe('the responses the server-wide policy reaches (#1059)', () => {
  test.each([
    ['http/middleware/security-headers.mdx', 'a body-parse `413`, say — carry the server-wide policy. The backend\'s own `404` for a path no route matches carries none', 'the backend\'s own 404, a body-parse 413 — carry'],
    ['de/http/middleware/security-headers.mdx', 'ein `413` aus dem Body-Parsing etwa —, tragen die serverweite Policy. Der eigene `404` des Backends für einen Pfad, auf den keine Route passt, trägt keine', 'der eigene 404 des Backends, ein Body-Parse-413 —, tragen'],
  ])('%s says an unrouted 404 carries none, and points at #1059', (path, sentence, retired) => {
    const text = prose(path);
    expect(text).toContain(sentence);
    expect(text).toContain('#1059');
    expect(text).not.toContain(retired);
  });

  const backends: ReadonlyArray<readonly [string, () => HttpServerBackend]> = [
    ['fastify', () => new FastifyBackend({ logger: false })],
    ['express', () => new ExpressBackend()],
    ['hono', () => new HonoBackend()],
  ];

  const live: Array<{ readonly binding: ServerBinding; readonly system: ActorSystem }> = [];
  afterEach(async () => {
    while (live.length > 0) {
      const { binding, system } = live.shift()!;
      await binding.unbind();
      await system.terminate();
    }
  });

  /** A server with the bundle's HSTS on, `max-age=100`, over `routes`; its base URL. */
  async function serverWithBundle(makeBackend: () => HttpServerBackend, routes: Route): Promise<string> {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('hsts-emission-paths', systemOptions);
    const serverWide = SecurityHeadersOptions.create().withHsts({ maxAge: 100 });
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(makeBackend())
      .withSecurityHeaders(serverWide)
      .bind(routes);
    live.push({ binding, system });
    return `http://${binding.host}:${binding.port}`;
  }

  test.each(backends)('%s: a body-parse 413 carries the server-wide policy, an unrouted 404 does not', async (_name, makeBackend) => {
    const url = await serverWithBundle(makeBackend, path('upload', post(() => complete(Status.OK, 'stored'))));

    const tooLarge = await fetch(`${url}/upload`, { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024) });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers.get('strict-transport-security')).toBe('max-age=100; includeSubDomains');

    const unrouted = await fetch(`${url}/nowhere`);
    await unrouted.arrayBuffer();
    expect(unrouted.status).toBe(404);
    // If this turns red, #1059 is fixed: the unrouted 404 carries the
    // server-wide policy, and the 'Two emission paths' sentences of
    // security-headers.mdx (EN + DE) have to say so.  (Express's own final
    // handler puts a nosniff on that 404 by itself, so only the policy the
    // sentence is about is asserted.)
    expect(unrouted.headers.get('strict-transport-security')).toBeNull();
  });

  test.each(backends)('%s: a tree that ends in fallback(...) answers that 404 itself, with the policy', async (_name, makeBackend) => {
    const url = await serverWithBundle(makeBackend, concat(
      path('upload', post(() => complete(Status.OK, 'stored'))),
      fallback(() => complete(Status.NotFound, 'nothing here')),
    ));

    const missed = await fetch(`${url}/nowhere`);
    await missed.arrayBuffer();
    expect(missed.status).toBe(404);
    expect(missed.headers.get('strict-transport-security')).toBe('max-age=100; includeSubDomains');
  });
});
