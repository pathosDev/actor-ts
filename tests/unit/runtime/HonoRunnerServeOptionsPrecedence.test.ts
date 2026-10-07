/**
 * The precedence `serveOptions` takes on Bun and Deno — the one it takes on
 * Node (`NodeHonoRunnerServeOptions.test.ts`, #1486): the bag goes in beneath
 * the runner's own fields, and the listener's TLS and HTTP/2 shape is decided
 * by `tls` and `http2` alone, set or unset.
 *
 * Both runners used to spread the bag last, so a key in it overrode what the
 * runner had computed.  On Bun it could strip `tls` or switch `http2` on —
 * with TLS gone, the h2c listener #1522 refuses.  Latent, since the only
 * producer is the runners' own WebSocket bridge, but a precedence that holds
 * on one runtime only is not a precedence.
 *
 * No sockets: the runtime's `serve()` is a stand-in that records the bag it is
 * handed.  `globalThis.Bun` is not configurable, so the Bun stand-in goes in
 * through the runner's constructor.
 */
import { describe, expect, test } from 'bun:test';
import { BunHonoRunner } from '../../../src/runtime/http/BunHonoRunner.js';
import type { HonoServeOptions } from '../../../src/runtime/http/HonoServerRunner.js';

/** Stand-in TLS material: nothing parses it here, the cases follow where it ends up. */
const TLS = { cert: 'the configured certificate', key: 'the configured key' } as const;

const hello = (): Response => new Response('hello');
const foreignFetch = (): Response => new Response('not the runner\'s handler');

type BunStandIn = NonNullable<ConstructorParameters<typeof BunHonoRunner>[0]>;

/** A stand-in `Bun` past the `http2` floor, whose `serve()` records every bag and binds nothing. */
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

/** Serve through a fresh stand-in `Bun` and return the one bag `Bun.serve` recorded. */
async function bunBagFor(options: Omit<HonoServeOptions, 'host' | 'port' | 'fetch'>): Promise<Record<string, unknown>> {
  const { bun, bags } = capturingBun();
  await new BunHonoRunner(bun).serve({ host: '127.0.0.1', port: 0, fetch: hello, ...options });
  expect(bags).toHaveLength(1);
  return bags[0]!;
}

describe('BunHonoRunner — serveOptions go in beneath the runner\'s own fields (#1486)', () => {
  test('the bag\'s other keys arrive, and host, port and fetch stay the runner\'s', async () => {
    const websocket = { maxPayloadLength: 1024 };
    const bag = await bunBagFor({ serveOptions: { websocket, hostname: '0.0.0.0', port: 9, fetch: foreignFetch } });

    expect(bag.websocket).toBe(websocket);
    expect(bag.hostname).toBe('127.0.0.1');
    expect(bag.port).toBe(0);
    expect(bag.fetch).toBe(hello);
  });

  test('under tls the bag can neither strip the certificate nor switch http2 on', async () => {
    const bag = await bunBagFor({ tls: TLS, serveOptions: { tls: undefined, http2: true } });

    expect(bag.tls).toEqual({ cert: TLS.cert, key: TLS.key });
    expect(bag.http2).toBeUndefined();
  });

  test('without tls the bag can switch neither TLS nor HTTP/2 on — no h2c through the back door', async () => {
    const bag = await bunBagFor({ serveOptions: { tls: { cert: 'a certificate of the bag\'s', key: 'a key of the bag\'s' }, http2: true } });

    expect(bag.tls).toBeUndefined();
    expect(bag.http2).toBeUndefined();
  });
});
