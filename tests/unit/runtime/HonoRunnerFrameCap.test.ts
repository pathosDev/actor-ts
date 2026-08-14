/**
 * #586 — the Hono runners install `maxFrameBytes` as a *transport* cap.
 *
 * Before this, all three handed the WebSocket bridge to their runtime with no
 * payload limit, so a hostile peer could make the process buffer 16 MiB (Bun's
 * `ServerWebSocket` default) or 100 MiB (`ws`'s `maxPayload` default) per
 * frame before the application-level check in `WebsocketConnectionActor` — which
 * runs on the already-materialised frame — could reject it.  Express and
 * Fastify had passed the cap to `ws` since the WS-3 fix; only Hono had not.
 *
 * `bun test` runs on Bun, so the integration suite only ever selects
 * `BunHonoRunner`.  These are direct unit tests of the runner classes, which
 * is the only way the Node branch is covered at all.
 *
 * Deno is absent by design rather than by omission: `Deno.upgradeWebSocket`
 * takes `protocol` and `idleTimeout` and no payload limit, so `DenoHonoRunner`
 * leaves `transportFrameCapBytes` unset and the gap is stated in its JSDoc and
 * in the docs.  It could not be tested here anyway — `hono/deno` touches the
 * `Deno` global at module scope and throws on import under Bun.
 */
import { describe, expect, test } from 'bun:test';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { BunHonoRunner } from '../../../src/runtime/http/BunHonoRunner.js';
import { buildNodeWebsocketBridge } from '../../../src/runtime/http/NodeHonoRunner.js';
import type { CreateNodeWebSocketFunction } from '../../../src/runtime/http/NodeHonoRunner.js';

const CAP = 64 * 1024;

/** The shape `Bun.serve` receives — handlers plus socket options in one bag. */
type BunServeOptions = { websocket?: Record<string, unknown> };

/** The `ws` server slice the Node bridge writes the cap onto. */
type WebsocketServerLike = { options?: { maxPayload?: number } };

describe('BunHonoRunner — transport frame cap', () => {
  test('folds maxPayloadLength into the websocket bag Bun.serve receives', async () => {
    const bridge = await new BunHonoRunner().webSocket(new Hono(), CAP);

    const { websocket } = bridge.serveOptions as BunServeOptions;
    expect(websocket).toBeDefined();
    expect(websocket!.maxPayloadLength).toBe(CAP);
    expect(bridge.transportFrameCapBytes).toBe(CAP);
  });

  test('keeps every handler hono/bun built — the cap rides along, it does not replace them', async () => {
    // `{ ...websocket, maxPayloadLength }` spreads Hono's handler object;
    // dropping open/message/close would break every upgrade while still
    // satisfying the assertion above.
    const bridge = await new BunHonoRunner().webSocket(new Hono(), CAP);

    const { websocket } = bridge.serveOptions as BunServeOptions;
    expect(typeof websocket!.open).toBe('function');
    expect(typeof websocket!.message).toBe('function');
    expect(typeof websocket!.close).toBe('function');
    expect(typeof bridge.upgradeWebSocket).toBe('function');
  });
});

describe('NodeHonoRunner — transport frame cap', () => {
  /**
   * Drive the real bridge builder against the real `@hono/node-ws`, keeping a
   * handle on the `ws` server it constructs for itself (nothing else can reach
   * it — the adapter builds it internally and every call makes a new one).
   */
  function buildCapturingBridge(maxFrameBytes: number): { server: WebsocketServerLike; capBefore: number | undefined } {
    let captured: WebsocketServerLike | undefined;
    let capBefore: number | undefined;
    const capturing: CreateNodeWebSocketFunction = (options) => {
      const created = createNodeWebSocket(options as { app: Hono });
      captured = created.wss as unknown as WebsocketServerLike;
      capBefore = captured.options?.maxPayload;
      return created as unknown as ReturnType<CreateNodeWebSocketFunction>;
    };
    buildNodeWebsocketBridge(capturing, new Hono(), maxFrameBytes);
    return { server: captured!, capBefore };
  }

  test('writes the cap onto the ws server @hono/node-ws built for itself', () => {
    const { server, capBefore } = buildCapturingBridge(CAP);

    // The pre-state is the point: 100 MiB is `ws`'s own documented default, so
    // seeing it here proves the write lands on the field `ws` actually reads
    // rather than parking the number on an object nobody consults.
    expect(capBefore).toBe(100 * 1024 * 1024);
    expect(server.options!.maxPayload).toBe(CAP);
  });

  test('still injects into the node:http server, and reports the cap it installed', () => {
    const injected: unknown[] = [];
    const wrapping: CreateNodeWebSocketFunction = (options) => {
      const created = createNodeWebSocket(options as { app: Hono });
      return {
        ...created,
        injectWebSocket: (server: unknown) => { injected.push(server); },
      } as unknown as ReturnType<CreateNodeWebSocketFunction>;
    };

    const bridge = buildNodeWebsocketBridge(wrapping, new Hono(), CAP);

    expect(bridge.transportFrameCapBytes).toBe(CAP);
    expect(bridge.serveOptions).toEqual({});
    const fakeServer = { on: (): void => undefined };
    bridge.attach!({ host: '127.0.0.1', port: 0, raw: fakeServer, stop: async () => undefined });
    expect(injected).toEqual([fakeServer]);
  });

  test('refuses to build the bridge when there is no ws option bag to write', () => {
    // The write is a `ws` internal.  A version that stops exposing a numeric
    // options.maxPayload would turn the assignment into a silent no-op and the
    // socket would quietly run uncapped again — so it fails loudly instead.
    const noServer: CreateNodeWebSocketFunction = () => ({
      upgradeWebSocket: () => undefined,
      injectWebSocket: () => undefined,
    });
    const renamedField: CreateNodeWebSocketFunction = () => ({
      upgradeWebSocket: () => undefined,
      injectWebSocket: () => undefined,
      wss: { options: {} },
    });

    expect(() => buildNodeWebsocketBridge(noServer, new Hono(), CAP)).toThrow(/frame cap/);
    expect(() => buildNodeWebsocketBridge(renamedField, new Hono(), CAP)).toThrow(/maxPayload/);
  });
});
