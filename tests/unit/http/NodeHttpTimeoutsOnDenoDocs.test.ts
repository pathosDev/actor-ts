/**
 * What the Express and Fastify pages say holds on Deno, in both languages.
 *
 * The Express page enumerated only the header deadline, `max-connections` and
 * `max-header-bytes` as not holding on Deno, which implied that `idle-timeout`
 * and `request-timeout` did.  Neither does: Deno's `node:http` shim accepts
 * `keepAliveTimeout` and `requestTimeout` and applies neither (measured on
 * deno 2.6.8 — `TimeoutsOnDeno.test.ts` and smoke case
 * `55-node-http-timeouts-on-deno.mjs` hold the behaviour).  The Fastify page
 * said nothing about Deno and the timeouts at all.
 *
 * Prose is read as rendered: MDX and HTML comments are stripped and whitespace
 * collapsed, so a re-wrapped paragraph still matches and a sentence inside a
 * comment does not count.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const DOCS = new URL('../../../docs/src/content/docs/', import.meta.url);

function renderedProse(page: string): string {
  return readFileSync(new URL(page, DOCS), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ');
}

const statements = [
  {
    page: 'http/backends/express.mdx',
    says: 'So there none of the connection-level bounds holds — `idle-timeout`, `header-timeout`, `request-timeout` and '
      + '`max-connections` — nor `max-header-bytes`, and `bind()` names each one that is set in a warning.',
  },
  {
    page: 'de/http/backends/express.mdx',
    says: 'Dort greift also keine der Verbindungsschranken — `idle-timeout`, `header-timeout`, `request-timeout` und '
      + '`max-connections` — und auch `max-header-bytes` nicht, und `bind()` nennt jede davon, die gesetzt ist, in einer Warnung.',
  },
  {
    page: 'http/backends/fastify.mdx',
    says: 'None of them holds under Deno, which this backend does not support: its `node:http` shim accepts '
      + '`keepAliveTimeout` and `requestTimeout` without applying either',
  },
  {
    page: 'de/http/backends/fastify.mdx',
    says: 'Unter Deno, das dieses Backend nicht unterstützt, greift keine davon: sein `node:http`-Shim nimmt '
      + '`keepAliveTimeout` und `requestTimeout` an, ohne eines davon anzuwenden',
  },
] as const;

describe('the Express and Fastify pages say idle-timeout and request-timeout do not hold on Deno', () => {
  for (const { page, says } of statements) {
    test(page, () => {
      expect(renderedProse(page)).toContain(says);
    });
  }

  test('the Express pages no longer list three bounds as the whole of what Deno misses', () => {
    expect(renderedProse('http/backends/express.mdx')).not.toContain('there neither the header deadline, `max-connections` nor `max-header-bytes` holds');
    expect(renderedProse('de/http/backends/express.mdx')).not.toContain('dort greift also weder die Header-Deadline noch `max-connections` noch `max-header-bytes`');
  });
});
