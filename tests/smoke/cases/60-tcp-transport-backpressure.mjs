/**
 * Smoke case: a burst past the socket buffers crosses `TcpTransport` intact,
 * in both directions, on every runtime (#931).
 *
 * Back-pressure is where the three runtimes' sockets differ most: a native
 * Bun socket — every socket `Bun.listen` accepts — wrote what the kernel would
 * take and dropped the rest, Bun's `node:net` and Node queue, and the Deno
 * adapter queues through a `WritableStream` writer.  The unit tests reach the
 * Deno adapter not at all and the others only on Bun, so this case runs the
 * real transport over loopback: two nodes on this one thread, so the receiver
 * cannot read while the sending loop runs, and a burst of frames far larger
 * than any loopback buffer, first over the accepted side of the connection and
 * then over the dialled side.  Every frame carries its sequence number and a
 * filler derived from it, so a cut stream, a reordering or a corrupted byte
 * fails the comparison — and the queue bound is set above the burst, so a
 * dropped frame fails it too.
 *
 * A burst arriving whole proves nothing lost, not that anyone was told to
 * stop, and a runtime that queued without bound would pass it.  So the case
 * first asks the runtime's own `TcpBackend` directly: an accepted socket
 * written to in 64 KiB chunks must answer `false` well before the bound, and
 * `onDrain` must follow once the reader catches up, with every byte through.
 *
 * Releases everything on every path: the sockets are destroyed, the listener
 * closed, both transports shut down and every timer cleared in `finally`, so
 * the runner's exit watchdog sees nothing left.
 */
export const name = 'TCP transport back-pressure';
export const description = 'a 3000-frame burst crosses TcpTransport whole and in order, both directions';

const HOST = '127.0.0.1';
const COUNT = 3_000;
const FILLER_LENGTH = 2_000;
const DEADLINE_MS = 20_000;
/** What the dialler advertises; it is never dialled. */
const PLACEHOLDER_PORT = 1;
const PORT_RELEASE_MS = 50;
const CHUNK_BYTES = 64 * 1024;
/** Far past any loopback buffer: a socket still answering `true` here never pushes back. */
const MAX_CHUNKS = 256;

export async function run({ actorTs, loadEntry }) {
  const { NoopLogger } = actorTs;
  const { NodeAddress, TcpTransport } = await loadEntry('cluster');
  const timers = [];
  const transports = [];
  const sockets = [];
  const listeners = [];
  try {
    await backendReportsBackPressure(sockets, listeners, timers);

    // Nobody dials the dialler — what comes back to it rides the connection it
    // opened — so it binds whatever port the OS hands it and advertises a
    // placeholder.  Only the acceptor needs a port known in advance.
    const diallerAddress = new NodeAddress('smoke-bp', HOST, PLACEHOLDER_PORT, 'run-a');
    const acceptorAddress = new NodeAddress('smoke-bp', HOST, await freePort(timers), 'run-b');
    const options = { outboundQueueSize: COUNT + 10 };
    const dialler = new TcpTransport(diallerAddress, new NoopLogger(), { ...options, bindPort: 0 });
    const acceptor = new TcpTransport(acceptorAddress, new NoopLogger(), options);
    transports.push(dialler, acceptor);
    const atDialler = [];
    const atAcceptor = [];
    dialler.setHandler((_from, message) => record(atDialler, message));
    acceptor.setHandler((_from, message) => record(atAcceptor, message));
    await dialler.start();
    await acceptor.start();

    dialler.send(acceptorAddress, envelope(-1));
    await until(() => acceptor.peers().some((peer) => peer.equals(diallerAddress)), timers,
      'the acceptor never held the dialler as a peer');

    // Accepted side first: on Bun this is the native socket.
    for (let seq = 0; seq < COUNT; seq++) acceptor.send(diallerAddress, envelope(seq));
    await until(() => atDialler.length >= COUNT, timers,
      () => `the dialler received ${atDialler.length} of ${COUNT} frames sent over the accepted side`);
    check(atDialler, 'over the accepted side');

    for (let seq = 0; seq < COUNT; seq++) dialler.send(acceptorAddress, envelope(seq));
    await until(() => atAcceptor.length >= COUNT, timers,
      () => `the acceptor received ${atAcceptor.length} of ${COUNT} frames sent over the dialled side`);
    check(atAcceptor, 'over the dialled side');
  } finally {
    for (const socket of sockets) {
      try {
        if (socket.destroy) socket.destroy();
        else socket.end();
      } catch { /* already gone */ }
    }
    for (const listener of listeners) {
      try { await listener.close(); } catch { /* already closed */ }
    }
    for (const timer of timers) clearTimeout(timer);
    for (const transport of transports) {
      try { await transport.shutdown(); } catch { /* already down */ }
    }
  }
}

/** This runtime's own TCP backend — runtime plumbing, reached the way the peer-certificate case does. */
async function tcpBackend() {
  const fromBuild = globalThis.process?.env?.ACTOR_TS_SMOKE_USE_DIST === '1'
    || globalThis.Deno?.env?.get?.('ACTOR_TS_SMOKE_USE_DIST') === '1';
  const tcpPath = fromBuild ? '../../../dist/runtime/tcp/index.js' : '../../../src/runtime/tcp/index.ts';
  const { getTcpBackend } = await import(new URL(tcpPath, import.meta.url).href);
  return getTcpBackend();
}

/**
 * An accepted socket answers `false` once it holds more than it should, and
 * reports the drain — the two halves of the contract every adapter now keeps.
 */
async function backendReportsBackPressure(sockets, listeners, timers) {
  const backend = await tcpBackend();
  let accepted;
  let drains = 0;
  let receivedBytes = 0;
  const ignore = () => {};
  const listener = await backend.listen({
    host: HOST,
    port: 0,
    handlers: {
      onOpen: (socket) => { accepted = socket; sockets.push(socket); },
      onData: ignore, onClose: ignore, onError: ignore,
      onDrain: () => { drains += 1; },
    },
  });
  listeners.push(listener);
  const dialled = await backend.connect({
    host: HOST,
    port: listener.port,
    handlers: {
      onOpen: ignore, onClose: ignore, onError: ignore,
      onData: (_socket, chunk) => { receivedBytes += chunk.byteLength; },
    },
  });
  sockets.push(dialled);
  await until(() => accepted !== undefined, timers, 'the dial was never accepted');

  const chunk = new Uint8Array(CHUNK_BYTES).fill(42);
  let written = 0;
  let answer = true;
  while (answer && written < MAX_CHUNKS) {
    answer = accepted.write(chunk);
    written += 1;
  }
  if (answer) throw new Error(`an accepted socket took ${MAX_CHUNKS} chunks of ${CHUNK_BYTES} bytes and never answered false`);
  await until(() => drains > 0, timers, 'write answered false, and onDrain never followed');
  await until(() => receivedBytes === written * CHUNK_BYTES, timers,
    () => `${receivedBytes} of ${written * CHUNK_BYTES} bytes written reached the dialler`);
}

/** A port the OS just handed out, asked of this runtime's own TCP backend. */
async function freePort(timers) {
  const backend = await tcpBackend();
  const listener = await backend.listen({
    host: HOST,
    port: 0,
    handlers: { onOpen: () => {}, onData: () => {}, onClose: () => {}, onError: () => {} },
  });
  const port = listener.port;
  await listener.close();
  // Deno gives the port back once its pending accept has been cancelled, a
  // turn after `close()` returns; binding it at once answers AddrInUse there.
  await new Promise((resolve) => { timers.push(setTimeout(resolve, PORT_RELEASE_MS)); });
  return port;
}

function filler(seq) {
  return String.fromCharCode(97 + (((seq % 26) + 26) % 26)).repeat(FILLER_LENGTH);
}

function envelope(seq) {
  return { kind: 'envelope', to: '/user/sink', from: null, payload: { seq, filler: filler(seq) } };
}

function record(into, message) {
  const payload = message?.payload;
  if (typeof payload?.seq !== 'number' || payload.seq < 0) return;
  into.push({ seq: payload.seq, intact: payload.filler === filler(payload.seq) });
}

function check(received, where) {
  if (received.length !== COUNT) throw new Error(`${received.length} frames arrived ${where}, expected ${COUNT}`);
  for (let i = 0; i < COUNT; i++) {
    if (received[i].seq !== i) throw new Error(`frame ${i} ${where} carried sequence ${received[i].seq}`);
    if (!received[i].intact) throw new Error(`frame ${i} ${where} arrived corrupted`);
  }
}

/** Poll `predicate` every 10 ms until it holds, or throw after {@link DEADLINE_MS}. */
async function until(predicate, timers, failure) {
  const deadline = Date.now() + DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(typeof failure === 'function' ? failure() : failure);
    await new Promise((resolve) => { timers.push(setTimeout(resolve, 10)); });
  }
}
