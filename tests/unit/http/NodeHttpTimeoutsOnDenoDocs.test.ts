/**
 * What the Express and Fastify pages say holds on Deno, in both languages.
 *
 * The Express page enumerated only the header deadline, `max-connections` and
 * `max-header-bytes` as not holding on Deno, which implied that `idle-timeout`
 * and `request-timeout` did on every Deno.  Neither does before deno 2.7.13:
 * Deno's `node:http` shim accepts `keepAliveTimeout` and `requestTimeout` and
 * applied neither until that release (measured on deno 2.6.8 through 2.7.12,
 * and from 2.7.13 on both hold as on Node — `TimeoutsOnDeno.test.ts` and smoke
 * case `55-node-http-timeouts-on-deno.mjs` hold the behaviour, #1793).  The
 * Fastify page said nothing about Deno and the timeouts at all.
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
    says: 'so there `header-timeout`, `max-connections` and `max-header-bytes` do not hold, and `bind()` names each one '
      + 'that is set in a warning. `idle-timeout` and `request-timeout` hold from deno 2.7.13 on, as on Node; before it Deno '
      + 'accepts `keepAliveTimeout` and `requestTimeout` without applying either, and both are reported not in effect too.',
  },
  {
    page: 'de/http/backends/express.mdx',
    says: 'dort greifen also `header-timeout`, `max-connections` und `max-header-bytes` nicht, und `bind()` nennt jede '
      + 'davon, die gesetzt ist, in einer Warnung. `idle-timeout` und `request-timeout` greifen ab deno 2.7.13 wie unter Node; '
      + 'davor nimmt Deno `keepAliveTimeout` und `requestTimeout` an, ohne eines davon anzuwenden, und beide werden ebenfalls '
      + 'als nicht wirksam gemeldet.',
  },
  {
    page: 'http/backends/fastify.mdx',
    says: '`idle-timeout` and `request-timeout` hold from deno 2.7.13 on, as on Node; before it the shim accepts '
      + '`keepAliveTimeout` and `requestTimeout` without applying either.',
  },
  {
    page: 'de/http/backends/fastify.mdx',
    says: '`idle-timeout` und `request-timeout` greifen ab deno 2.7.13 wie unter Node; davor nimmt der Shim '
      + '`keepAliveTimeout` und `requestTimeout` an, ohne eines davon anzuwenden.',
  },
] as const;

describe('the Express and Fastify pages say idle-timeout and request-timeout hold on Deno only from 2.7.13', () => {
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
