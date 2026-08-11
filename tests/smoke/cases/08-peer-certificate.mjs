/**
 * Smoke case: the TCP backend's peer-certificate accessor behaves on every
 * runtime (#912).
 *
 * The cluster binds a peer's claimed `hello` identity to its TLS certificate,
 * and it reads that certificate through `TcpSocketLike.peerCertificate()`.
 * The three runtimes disagree about what exists there — Node and Bun expose a
 * Node-style `getPeerCertificate()`, Deno exposes nothing at all — so the
 * accessor is the kind of surface that compiles everywhere and works in one
 * place.
 *
 * What is checked here is the contract the transport actually relies on: on a
 * *plaintext* connection the answer must be "no certificate", delivered as
 * `undefined` and never as a throw.  That is the branch every non-TLS cluster
 * takes, and a throw in it would break plain TCP on the runtime that has no
 * accessor.  Whether a real certificate parses correctly is unit-tested
 * against captured runtime output in `tests/unit/runtime/tcp/`.
 */
export const name = 'peer certificate';
export const description = 'TcpSocketLike.peerCertificate() is safe on a plaintext socket';

export async function run() {
  // The TCP backend is runtime plumbing, not public API, so it is not on the
  // harness's root barrel — reach it the way the DevTools case does.
  const fromBuild = globalThis.process?.env?.ACTOR_TS_SMOKE_USE_DIST === '1'
    || globalThis.Deno?.env?.get?.('ACTOR_TS_SMOKE_USE_DIST') === '1';
  const tcpPath = fromBuild ? '../../../dist/runtime/tcp/index.js' : '../../../src/runtime/tcp/index.ts';
  const { getTcpBackend } = await import(new URL(tcpPath, import.meta.url).href);

  const backend = await getTcpBackend();
  if (!backend) throw new Error('no TCP backend detected for this runtime');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const serverSockets = [];
  const noop = () => {};

  const listener = await backend.listen({
    host: '127.0.0.1',
    port: 0,
    handlers: {
      onOpen: (s) => serverSockets.push(s),
      onData: noop,
      onClose: noop,
      onError: noop,
    },
  });

  const client = await backend.connect({
    host: '127.0.0.1',
    port: listener.port,
    handlers: { onOpen: noop, onData: noop, onClose: noop, onError: noop },
  });

  // Give the accept callback a turn — it is a socket event on every runtime.
  for (let i = 0; i < 40 && serverSockets.length === 0; i++) await sleep(25);
  if (serverSockets.length === 0) throw new Error('server never saw the connection');

  for (const [label, socket] of [['server', serverSockets[0]], ['client', client]]) {
    // The method is optional by design: Deno has nothing to implement it
    // with, and its absence is what makes the transport skip the identity
    // check rather than treat a blank answer as "no certificate presented".
    if (socket.peerCertificate === undefined) continue;

    let certificate;
    try {
      certificate = socket.peerCertificate();
    } catch (err) {
      throw new Error(`${label} socket: peerCertificate() threw on a plaintext socket: ${err}`);
    }
    if (certificate !== undefined) {
      throw new Error(
        `${label} socket: expected no certificate on a plaintext socket, got ${JSON.stringify(certificate)}`,
      );
    }
  }

  client.end();
  await listener.close();
}
