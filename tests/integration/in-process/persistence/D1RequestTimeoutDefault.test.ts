import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_D1_TIMEOUT_MS } from '../../../../src/persistence/Constants.js';
import { buildD1Client, type D1Connection } from '../../../../src/persistence/journals/D1Client.js';

/**
 * The per-request deadline `buildD1Client` arms is the one
 * `DEFAULT_D1_TIMEOUT_MS` names (#1490).
 *
 * Waiting out 30 s is not a test, so the deadline is read where it is armed:
 * `HttpClient` schedules one `setTimeout(abort, timeoutMs)` per request, and
 * the delay handed to it is the deadline the transport holds.  A literal of the
 * same value at the read site would pass the first case as well — what the
 * case pins is that the two cannot drift apart, which is the property a
 * published `timeout` leaf will rest on: move the constant and the armed
 * deadline moves with it, or this goes red.
 */

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

const credentials = { accountId: 'acct', databaseId: 'db-uuid', apiToken: 'token' };

/** Run one statement against a stubbed D1 endpoint and return every timer delay it armed. */
async function deadlinesArmedBy(connection: D1Connection): Promise<number[]> {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ success: true, result: [{ success: true, results: [], meta: { changes: 0 } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch;
  const armed: number[] = [];
  globalThis.setTimeout = ((handler: () => void, delayMs?: number) => {
    armed.push(delayMs ?? 0);
    return realSetTimeout(handler, delayMs);
  }) as typeof setTimeout;
  try {
    await buildD1Client(connection).query('SELECT 1', []);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  return armed;
}

describe('buildD1Client — the per-request deadline', () => {
  test('a connection that names no timeout arms the named default', async () => {
    expect(await deadlinesArmedBy(credentials)).toEqual([DEFAULT_D1_TIMEOUT_MS]);
    // The value the bare literal at the read site carried before it was named.
    expect(DEFAULT_D1_TIMEOUT_MS).toBe(30_000);
  });

  test('an explicit timeoutMs is the deadline instead of the default', async () => {
    expect(await deadlinesArmedBy({ ...credentials, timeoutMs: 1_234 })).toEqual([1_234]);
  });
});
