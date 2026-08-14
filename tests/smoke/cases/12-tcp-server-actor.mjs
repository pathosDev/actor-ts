/**
 * Smoke case: the TCP listener actor binds and serves on every runtime (#158).
 *
 * `TcpServerActor` is the first consumer of `TcpBackend.listen()` outside the
 * cluster transport, and each runtime reaches it through a different adapter —
 * `Bun.listen`, `net.createServer`, `Deno.listen`.  The accept callback, the
 * chunk shape handed to `onData` and the socket wrapper all differ per
 * adapter, so a listener that works under Bun proves nothing about Node or
 * Deno.  That is exactly the class of defect a unit suite pinned to one
 * runtime cannot see.
 *
 * The case is a full round-trip on a real socket — bind on port 0, dial with
 * `node:net`, write a framed line, read the echo back — because every
 * cheaper check (does `listen` resolve? is the port non-zero?) passes on an
 * adapter whose data path is broken.
 */
export const name = 'TCP server actor';
export const description = 'bind, accept, frame and echo over a real socket';

const TIMEOUT_MS = 5_000;

export async function run({ actorTs, loadEntry }) {
  const { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { TcpServerActor, TcpServerOptions } = await loadEntry('io');
  const net = await import('node:net');

  // Echoes every inbound frame back to the connection it came from — the
  // canonical listener shape, and it exercises inbound and outbound at once.
  class EchoHandler extends Actor {
    constructor(serverHolder) { super(); this.serverHolder = serverHolder; }
    onReceive(message) {
      if (message.kind !== 'frame') return;
      this.serverHolder.ref.tell({
        kind: 'send',
        connectionId: message.connectionId,
        payload: `echo:${message.payload}\n`,
      });
    }
  }

  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('smoke-tcp-server', systemOptions);

  const serverHolder = { ref: null, actor: null };
  let client = null;
  try {
    const handlerRef = system.spawn(() => new EchoHandler(serverHolder), 'echo');
    const serverOptions = TcpServerOptions.create()
      .withBindHost('127.0.0.1')
      .withBindPort(0)
      .withFraming({ kind: 'lines' })
      .withTarget(handlerRef);
    serverHolder.ref = system.spawn(() => {
      serverHolder.actor = new TcpServerActor(serverOptions);
      return serverHolder.actor;
    }, 'tcp-server');

    await until(() => (serverHolder.actor?.boundPort ?? 0) > 0, 'the listener reported a bound port');
    const port = serverHolder.actor.boundPort;

    client = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });

    let seen = '';
    client.on('data', (chunk) => { seen += chunk.toString('utf8'); });
    // Split across two writes: re-assembling a frame from arbitrary chunk
    // boundaries is the part each adapter's onData could get wrong.
    client.write('ping');
    client.write('-me\n');

    await until(() => seen.includes('\n'), 'the echo came back framed');
    if (seen !== 'echo:ping-me\n') {
      throw new Error(`echo mismatch: got ${JSON.stringify(seen)}`);
    }
    if (serverHolder.actor.connectionCount !== 1) {
      throw new Error(`expected 1 live connection, got ${serverHolder.actor.connectionCount}`);
    }
  } finally {
    if (client) client.destroy();
    await system.terminate();
  }

  // The port must actually be released by the unbind, on every runtime: a
  // listener that only *looks* closed leaks a descriptor per restart.
  const port = serverHolder.actor?.boundPort;
  if (port) throw new Error(`boundPort still ${port} after terminate — the listener did not unbind`);
}

/** Poll until `predicate` holds; a smoke case has no test harness to lean on. */
async function until(predicate, label) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start >= TIMEOUT_MS) {
      throw new Error(`${label} did not happen within ${TIMEOUT_MS}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
