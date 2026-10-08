/**
 * `Bun.serve`'s `idleTimeout`, as the Bun runner writes it (#1487).
 *
 * `Bun.serve` wants whole seconds, `0` for off and nothing past 255: measured
 * on bun 1.4.2, a fraction (`1.5`) and anything above the ceiling (`256`)
 * throw a `TypeError` at bind rather than being rounded or clamped.  The
 * actor-ts setting is milliseconds, so the conversion is the whole risk —
 * a plain division throws on most values, and a floor turns 1–999 ms into
 * `0`, which is "never close".  It has to round up.
 *
 * Bun checks idleness on a 4 s sweep: a value of `X` seconds is held as
 * `ceil(X / 4)` sweeps, and a silent connection is cut somewhere in the last
 * of them — up to one sweep before `X`.  Unset, the runner therefore derives
 * the timeout from the server's request deadline as the smallest multiple of
 * the sweep whose earliest cut still lands two seconds past the deadline, so
 * a `requestTimeout()` 503 is written before Bun closes the connection under
 * a silent handler.  36 s for the built-in 30 s deadline.
 *
 * No sockets: the `Bun` global is a stand-in that records the bag `serve()`
 * is handed, passed through the runner's constructor because `globalThis.Bun`
 * is not configurable (the `HonoRunnerServeOptionsPrecedence.test.ts` shape).
 */
import { describe, expect, test } from 'bun:test';
import { BunHonoRunner } from '../../../src/runtime/http/BunHonoRunner.js';
import type { HonoServeOptions, HonoServerHandle } from '../../../src/runtime/http/HonoServerRunner.js';

const hello = (): Response => new Response('hello');

type BunStandIn = NonNullable<ConstructorParameters<typeof BunHonoRunner>[0]>;

/** A stand-in `Bun` whose `serve()` records every bag and binds nothing. */
function capturingBun(): { readonly bun: BunStandIn; readonly bags: Record<string, unknown>[] } {
  const bags: Record<string, unknown>[] = [];
  const bun: BunStandIn = {
    version: '1.4.2',
    serve(options) {
      bags.push(options);
      return { port: 4321, hostname: '127.0.0.1', stop: () => {} };
    },
  };
  return { bun, bags };
}

type Served = { readonly bag: Record<string, unknown>; readonly handle: HonoServerHandle };

/** Serve through a fresh stand-in `Bun`; the one bag it recorded, and the handle. */
async function serveWith(options: Omit<HonoServeOptions, 'host' | 'port' | 'fetch'>): Promise<Served> {
  const { bun, bags } = capturingBun();
  const handle = await new BunHonoRunner(bun).serve({ host: '127.0.0.1', port: 0, fetch: hello, ...options });
  expect(bags).toHaveLength(1);
  return { bag: bags[0]!, handle };
}

/** Bun's sweep, and where in it a value of `seconds` can cut a silent connection at the earliest. */
const SWEEP_SECONDS = 4;
const earliestCutSeconds = (seconds: number): number => SWEEP_SECONDS * (Math.ceil(seconds / SWEEP_SECONDS) - 1);

describe('BunHonoRunner — an explicit idleTimeoutMs reaches Bun.serve in whole seconds, rounded up', () => {
  test.each([
    [0, 0],
    [100, 1],
    [1_500, 2],
    [5_000, 5],
    [255_000, 255],
  ])('%d ms -> idleTimeout %d', async (milliseconds, seconds) => {
    const { bag } = await serveWith({ idleTimeoutMs: milliseconds });

    expect(bag.idleTimeout).toBe(seconds);
  });

  test('no value under a second becomes 0 — Bun reads 0 as never closing', async () => {
    for (const milliseconds of [1, 499, 999]) {
      const { bag } = await serveWith({ idleTimeoutMs: milliseconds });
      expect(bag.idleTimeout, `${milliseconds} ms`).toBe(1);
    }
    // And a whole second stays a whole second rather than gaining one.
    expect((await serveWith({ idleTimeoutMs: 1_000 })).bag.idleTimeout).toBe(1);
    expect((await serveWith({ idleTimeoutMs: 1_001 })).bag.idleTimeout).toBe(2);
  });

  test('what reaches Bun.serve is always an integer — a fraction would throw there', async () => {
    for (const milliseconds of [1, 333, 1_500, 2_250, 12_345, 254_001]) {
      const { bag } = await serveWith({ idleTimeoutMs: milliseconds });
      expect(Number.isInteger(bag.idleTimeout), `${milliseconds} ms gave ${String(bag.idleTimeout)}`).toBe(true);
    }
  });

  test('255001 ms never reaches Bun.serve — it rounds to 256, past the ceiling', async () => {
    const { bun, bags } = capturingBun();
    const runner = new BunHonoRunner(bun);

    await expect(runner.serve({ host: '127.0.0.1', port: 0, fetch: hello, idleTimeoutMs: 255_001 })).rejects.toThrow(/255/);
    expect(bags, 'Bun.serve was called with an idle timeout it would refuse').toEqual([]);
  });

  test('the runner declares the ceiling, so the backend can refuse before serve() with the key\'s name', () => {
    expect(new BunHonoRunner(capturingBun().bun).idleTimeoutCeilingMs).toBe(255_000);
  });

  test('a set idleTimeoutMs is reported applied; the explicit value beats the derived one', async () => {
    const { bag, handle } = await serveWith({ idleTimeoutMs: 5_000, requestDeadlineMs: 30_000 });

    expect(bag.idleTimeout).toBe(5);
    expect(handle.appliedServeOptions?.idleTimeoutMs).toBe(true);
    expect(handle.appliedServeOptions).not.toHaveProperty('idleTimeoutHeldAtCeilingMs');
  });
});

describe('BunHonoRunner — unset, the idle timeout is derived from the request deadline', () => {
  test.each([
    [30_000, 36],
    [10_000, 16],
    [14_000, 20],
    [2_000, 8],
    [300_000, 255],
  ])('a %d ms deadline -> idleTimeout %d', async (requestDeadlineMs, seconds) => {
    const { bag, handle } = await serveWith({ requestDeadlineMs });

    expect(bag.idleTimeout).toBe(seconds);
    // The member was not set, so nothing of it was applied — the derived
    // value is the runner's own choice, not the deployment's.
    expect(handle.appliedServeOptions?.idleTimeoutMs).toBe(false);
  });

  test('every derived value lets the 503 win: its earliest cut lands at least 2 s past the deadline', async () => {
    // The smallest such multiple of the sweep, too — one sweep less would cut
    // before the deadline's margin, which is the whole reason the number is
    // not simply rounded.
    for (let deadlineMs = 500; deadlineMs <= 250_000; deadlineMs += 3_700) {
      const { bag } = await serveWith({ requestDeadlineMs: deadlineMs });
      const seconds = bag.idleTimeout as number;
      const needed = deadlineMs / 1_000 + 2;
      expect(earliestCutSeconds(seconds), `deadline ${deadlineMs} ms -> ${seconds} s`).toBeGreaterThanOrEqual(needed);
      if (seconds < 255) {
        expect(seconds % SWEEP_SECONDS, `deadline ${deadlineMs} ms -> ${seconds} s`).toBe(0);
        expect(earliestCutSeconds(seconds - SWEEP_SECONDS), `deadline ${deadlineMs} ms -> ${seconds} s is not the smallest`).toBeLessThan(needed);
      }
    }
  });

  test('a deadline 255 s still covers is not reported — 255 is held as 64 sweeps, cutting at 252 s at the earliest', async () => {
    const { bag, handle } = await serveWith({ requestDeadlineMs: 250_000 });

    expect(bag.idleTimeout).toBe(255);
    expect(handle.appliedServeOptions).not.toHaveProperty('idleTimeoutHeldAtCeilingMs');
  });

  test('a deadline past what 255 s covers is held at the ceiling and says so', async () => {
    for (const requestDeadlineMs of [250_001, 300_000, 3_600_000]) {
      const { bag, handle } = await serveWith({ requestDeadlineMs });
      expect(bag.idleTimeout, `${requestDeadlineMs} ms`).toBe(255);
      expect(handle.appliedServeOptions?.idleTimeoutHeldAtCeilingMs, `${requestDeadlineMs} ms`).toBe(255_000);
    }
  });

  test('with neither set, Bun keeps its own default — nothing is written', async () => {
    const { bag } = await serveWith({});

    expect(bag).not.toHaveProperty('idleTimeout');
  });
});

describe('BunHonoRunner — the typed members decide the idle timeout, never the serveOptions bag', () => {
  test('an explicit idleTimeoutMs wins over a bag that carries idleTimeout', async () => {
    const { bag } = await serveWith({ idleTimeoutMs: 5_000, serveOptions: { idleTimeout: 99 } });

    expect(bag.idleTimeout).toBe(5);
  });

  test('so does the derived value', async () => {
    const { bag } = await serveWith({ requestDeadlineMs: 30_000, serveOptions: { idleTimeout: 0 } });

    expect(bag.idleTimeout).toBe(36);
  });

  test('a bag idleTimeout with neither member set is dropped, not passed by the ceiling and the conversion', async () => {
    // 300 would be a TypeError inside Bun.serve; 0 would switch the bound off
    // through a channel nothing validates.
    for (const idleTimeout of [300, 0]) {
      const { bag } = await serveWith({ serveOptions: { idleTimeout } });
      expect(bag, `bag idleTimeout ${idleTimeout}`).not.toHaveProperty('idleTimeout');
    }
  });

  test('the bag\'s other keys still arrive', async () => {
    const websocket = { maxPayloadLength: 1024 };
    const { bag } = await serveWith({ idleTimeoutMs: 2_000, serveOptions: { websocket } });

    expect(bag.websocket).toBe(websocket);
    expect(bag.idleTimeout).toBe(2);
  });
});
