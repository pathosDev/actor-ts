/**
 * Smoke case: a **binary** frame survives the round-trip on every runtime.
 *
 * `04-websocket-roundtrip.mjs` next door proves the upgrade and the typed JSON
 * path, and that is exactly the gap this fills: every WebSocket test in the
 * repository sent text, so nothing noticed that `WebsocketClientActor` could
 * not receive a binary frame at all on Node or Deno.  The runtimes differ in
 * how they hand a binary payload to the `message` listener — measured, Bun
 * 1.4.0 gives a `Buffer`, Node 26.7.0 and Deno 2.6.8 give a `Blob` — and a
 * `Blob` matched no branch of `normalizeInbound`, so every binary frame was
 * dropped as "unrecognised" whatever its size.  That silently took the #750
 * oversize cap with it: an over-cap binary frame never reached the size check.
 *
 * This case is deliberately end-to-end rather than a fake socket: the whole
 * defect lived in a difference between real runtimes, so only a real socket on
 * each of the three can show it.  A unit test with a fake socket pins the
 * mechanism (`tests/unit/http/websocket/WebsocketClientBinaryFrames.test.ts`);
 * this pins the behaviour on the runtime the user actually runs.
 *
 * Like case 04, it skips when the backend cannot upgrade on this runtime — but
 * once a server binds, the round-trip MUST succeed.
 */
export const name = 'websocket binary frames';
export const description = 'binary round-trip through rawCodec() on every runtime';

export async function run({ actorTs, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const {
    HttpExtensionId,
    WebsocketServerActor,
    WebsocketClientActor,
    WebsocketClientOptions,
    WebsocketRouteOptions,
    rawCodec,
    websocket,
  } = await loadEntry('http');

  const PAYLOAD = new Uint8Array([0xac, 0x70, 0x72, 0x00, 0xff, 0x2a]);

  /** Polls `predicate` for up to 5 s, then fails naming what never happened. */
  const until = async (predicate, label, hint) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out after 5s waiting for: ${label} ${hint}`);
  };

  /** Echoes the raw frame back, so the client sees a binary frame it can check. */
  class BinaryEcho extends WebsocketServerActor {
    onMessage(frame) { this.reply(frame); }
  }

  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create('smoke-ws-binary', sysOptions);
  let binding;
  try {
    const server = sys.spawn(BinaryEcho, 'binary-echo');
    const routeOptions = WebsocketRouteOptions.create().withCodec(rawCodec());
    try {
      binding = await sys.extension(HttpExtensionId)
        .newServerAt('127.0.0.1', 0)
        .bind(websocket('/ws', server, routeOptions));
    } catch (e) {
      console.log(`  (skipped: websocket server unsupported on this runtime — ${e.message})`);
      return;
    }

    const url = `ws://127.0.0.1:${binding.port}/ws`;

    /* --- 1. a binary frame within the cap arrives, bytes intact ---------- */

    const received = [];
    class BinaryClient extends WebsocketClientActor {
      constructor() {
        const clientOptions = WebsocketClientOptions.create()
          .withUrl(url)
          .withCodec(rawCodec())
          .withReconnect({ maxAttempts: 5, initialDelayMs: 50 });
        super(clientOptions);
      }
      onConnected() { this.sendRaw({ kind: 'binary', data: PAYLOAD }); }
      onMessage(frame) { received.push(frame); }
    }
    sys.spawn(BinaryClient, 'client');

    await until(() => received.length > 0, 'a binary frame reached onMessage',
      '(a Blob payload dropped as unrecognised looks exactly like this)');
    const frame = received[0];
    if (frame.kind !== 'binary') throw new Error(`expected a binary frame, got kind '${frame.kind}'`);
    const bytes = [...frame.data];
    const expected = [...PAYLOAD];
    if (bytes.length !== expected.length || bytes.some((byte, i) => byte !== expected[i])) {
      throw new Error(`binary payload round-tripped wrong: [${bytes}] != [${expected}]`);
    }

    /* --- 2. an oversize binary frame reaches the #750 cap, not the drop --- */

    // The half that was silently reopened.  A `Blob` never reached the size
    // check at all, so on Node and Deno `maxFrameBytes` bounded nothing for
    // binary traffic and the peer could repeat the allocation for free.  The
    // echo makes the *server* send the over-cap frame, so this is the client's
    // own inbound cap and not the route's.
    const capped = { disconnects: [], frames: [] };
    class CappedClient extends WebsocketClientActor {
      constructor() {
        const clientOptions = WebsocketClientOptions.create()
          .withUrl(url)
          .withCodec(rawCodec())
          .withMaxFrameBytes(64)
          .withReconnect(false);
        super(clientOptions);
      }
      onConnected() { this.sendRaw({ kind: 'binary', data: new Uint8Array(4096).fill(0xab) }); }
      onMessage(f) { capped.frames.push(f); }
      onDisconnected(cause) { capped.disconnects.push(cause?.message); }
    }
    sys.spawn(CappedClient, 'capped');

    await until(() => capped.disconnects.length > 0, 'the oversize binary frame closed the connection',
      '(before the fix it was dropped as unrecognised and the socket stayed open)');
    if (capped.disconnects[0] !== 'oversize inbound frame') {
      throw new Error(`oversize binary frame produced the wrong cause: ${capped.disconnects[0]}`);
    }
    if (capped.frames.length !== 0) {
      throw new Error(`an over-cap frame was delivered to onMessage: ${capped.frames.length} frame(s)`);
    }
  } finally {
    if (binding) await binding.unbind();
    await sys.terminate();
  }
}
