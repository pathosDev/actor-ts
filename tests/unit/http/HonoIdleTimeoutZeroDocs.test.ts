/**
 * #1487 — what the Hono and request-timeout pages say about
 * `idle-timeout = 0` on the Hono backend under Bun, in both languages.
 *
 * There the idle timeout is the one bound on a request whose body stops
 * arriving and on a connection left idle: `header-timeout`, `request-timeout`
 * and `max-connections` cannot be installed on that pair.  Measured on bun
 * 1.4.2, a body announced at 10 bytes that stopped after 1 was still open
 * after 40 s under `0`.  The request-timeout page used to offer `0` as the way
 * past the 255 s ceiling without saying so; both pages now say what `0` does
 * there, and the offer is gone.
 *
 * Prose is read as rendered: MDX and HTML comments are stripped first, since a
 * sentence inside one renders nothing, and whitespace is collapsed so a
 * re-wrapped paragraph still matches.  The `0` mentions are counted, so an
 * offer added back in another sentence shows up as one more.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const DOCS = new URL('../../../docs/src/content/docs/', import.meta.url);

/** A page's prose as it renders: comments removed, whitespace collapsed. */
function renderedProse(page: string): string {
  return readFileSync(new URL(page, DOCS), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ');
}

/** How many times `` `0` `` appears in a page's rendered prose. */
const zeroMentions = (prose: string): number => prose.split('`0`').length - 1;

const pages = [
  {
    page: 'http/backends/hono.mdx',
    exposure: '`0` turns it off, and on Hono under Bun it is the only bound on a request whose body stops arriving and '
      + 'on a connection left idle between requests, since none of the other three is installed: with `0` such a '
      + 'connection stays open until the client closes it.',
    zeroMentions: 3,
  },
  {
    page: 'de/http/backends/hono.mdx',
    exposure: '`0` schaltet ihn ab, und unter Hono auf Bun ist er die einzige Schranke für einen Request, dessen Body '
      + 'nicht mehr weiterkommt, und für eine Verbindung, die zwischen zwei Requests untätig ist, weil keine der '
      + 'anderen drei installiert wird: mit `0` bleibt eine solche Verbindung offen, bis der Client sie schließt.',
    zeroMentions: 3,
  },
  {
    page: 'http/middleware/timeout.mdx',
    exposure: '`0` turns it off, and it is the only bound there on a request whose body stops arriving and on a '
      + 'connection left idle between requests — `header-timeout`, `request-timeout` and `max-connections` cannot be '
      + 'installed on that pair — so with `0` such a connection stays open until the client closes it.',
    zeroMentions: 3,
  },
  {
    page: 'de/http/middleware/timeout.mdx',
    exposure: '`0` schaltet ihn ab, und er ist dort die einzige Schranke für einen Request, dessen Body nicht mehr '
      + 'weiterkommt, und für eine Verbindung, die zwischen zwei Requests untätig ist — `header-timeout`, '
      + '`request-timeout` und `max-connections` lassen sich auf diesem Paar nicht installieren —, mit `0` bleibt '
      + 'eine solche Verbindung also offen, bis der Client sie schließt.',
    zeroMentions: 3,
  },
] as const;

describe('idle-timeout = 0 on Hono under Bun is described, not offered (#1487)', () => {
  for (const { page, exposure, zeroMentions: expected } of pages) {
    test(`${page} says what 0 does there, and mentions it nowhere else`, () => {
      const prose = renderedProse(page);

      expect(prose).toContain(exposure);
      expect(zeroMentions(prose)).toBe(expected);
    });
  }

  test('the request-timeout pages no longer offer 0 as the way past the ceiling', () => {
    expect(renderedProse('http/middleware/timeout.mdx')).not.toContain('or `0` for none');
    expect(renderedProse('de/http/middleware/timeout.mdx')).not.toContain('oder `0` für keinen');
  });
});

describe('the Hono pages say what abort() does on each runtime', () => {
  // The adapter hard-closes where the runtime's socket can — Bun and Node —
  // and falls back to a close frame on Deno; `HonoWebsocketTerminate.test.ts`
  // and smoke case 56 hold the behaviour.
  test.each([
    ['http/backends/hono.mdx', 'so `abort()` drops the connection on the spot: the client sees it close with `1006` and no close frame'],
    ['http/backends/hono.mdx', 'so `abort()` falls back to a close frame carrying its code and reason'],
    ['de/http/backends/hono.mdx', '`abort()` lässt die Verbindung also sofort fallen: der Client sieht sie mit `1006` und ohne Close-Frame enden'],
    ['de/http/backends/hono.mdx', 'also fällt `abort()` auf einen Close-Frame mit seinem Code und seinem Grund zurück'],
  ])('%s', (page, says) => {
    expect(renderedProse(page)).toContain(says);
  });
});
