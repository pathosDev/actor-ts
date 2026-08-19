import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import { idempotent } from '../../../../src/http/cache/IdempotencyKey.js';
import { rateLimit } from '../../../../src/http/cache/RateLimit.js';
import { complete } from '../../../../src/http/Route.js';
import { Status, type HttpRequest } from '../../../../src/http/Types.js';

/**
 * The rate limiter shipped an **absolute** security claim that is false, and
 * this is what stops it coming back (#607).
 *
 * `src/http/cache/RateLimit.ts` and the rate-limit page in both languages
 * told the reader that the flooding client's own counter "is never the
 * victim", because `incr` bumps it to most-recently-used on every request.
 * The premise is right and the conclusion does not follow: `rateLimit` calls
 * `incr` in exactly one place, inside the handler it wraps, so a flood that
 * does **not** travel through the limiter never bumps anything.  A client
 * answered 429 by `max: 2` was answered 200 again after twenty off-limiter
 * `Idempotency-Key` requests through one shared `maxEntries: 4` cache.
 *
 * An inaccurate mitigation note is worse than an absent one — a reader who
 * believes it stops looking — so the correction needs a gate, and prose has
 * none of its own.  Two assertions, in the shape
 * `tests/unit/devtools/ExampleWiringClaims.test.ts` uses for the DevTools
 * chapter: one re-runs the reproduction so the *fact* the text now states
 * stays a measured fact, and one reads the three files so restoring the
 * unqualified wording turns a test red rather than only a reviewer's head.
 *
 * What the second one cannot catch is a *new* absolute phrasing that happens
 * to miss these substrings.  That is the accepted ceiling: the failure mode
 * worth catching is the specific sentence that was there for a release, and
 * anything stronger would need to understand the prose.  The behavioural test
 * below covers the other direction — if the exposure is ever actually closed,
 * it fails and forces the text to be revisited rather than left stale.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..', '..');

/**
 * The three places the claim was stated.  Each pairs the wording that must
 * not return with the qualifier the corrected text has to carry, so the guard
 * fails on a silent revert in either direction.
 */
const CLAIM_SITES: ReadonlyArray<readonly [label: string, path: string, absolute: RegExp, qualifier: RegExp]> = [
  [
    'RateLimit JSDoc',
    'src/http/cache/RateLimit.ts',
    /never the victim|safe either way/,
    /only from outside the\s+\*\s+limiter/,
  ],
  [
    'rate-limit page (English)',
    'docs/src/content/docs/http/middleware/rate-limit.mdx',
    /never the victim|safe either way/,
    /only from outside the\s+limiter/,
  ],
  [
    'rate-limit page (German)',
    'docs/src/content/docs/de/http/middleware/rate-limit.mdx',
    /nie das Opfer|in beiden Fällen/,
    /nur von\s+außerhalb des Limiters/,
  ],
] as const;

function readUtf8(relativePath: string): string {
  return readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function makeRequest(headers: Record<string, string> = {}, path = '/api'): HttpRequest {
  return { method: 'POST', path, headers, query: {}, params: {}, body: null, remoteAddress: '192.0.2.5' };
}

describe('the flooder-immunity claim is qualified, and the qualification is measured', () => {
  test.each(CLAIM_SITES)('%s no longer states it absolutely', (_label, path, absolute, qualifier) => {
    const text = readUtf8(path);
    // Report the offending lines, not the file: an `expect(text).not.toMatch`
    // over a 300-line page prints the whole page on failure and buries the
    // one line that matters.
    expect(text.split('\n').filter((line) => absolute.test(line))).toEqual([]);
    expect(qualifier.test(text)).toBe(true);
  });

  test('the off-limiter self-reset the corrected text describes still reproduces', async () => {
    const shared = new InMemoryCache({ maxEntries: 4, cleanupMs: 0 });
    const limited = rateLimit({
      cache: shared,
      windowMs: 60_000,
      max: 2,
      key: (request) => request.remoteAddress ?? 'unknown',
    })(() => complete(Status.OK, { ok: true }));
    const pay = idempotent({ cache: shared })(() => complete(Status.OK, { ok: true }));

    expect((await limited(makeRequest())).status).toBe(Status.OK);
    expect((await limited(makeRequest())).status).toBe(Status.OK);
    expect((await limited(makeRequest())).status).toBe(Status.TooManyRequests);

    for (let i = 0; i < 20; i++) {
      await pay(makeRequest({ 'idempotency-key': `flood-${i}` }, '/payments'));
    }

    expect((await limited(makeRequest())).status).toBe(Status.OK);
    await shared.close();
  });
});
