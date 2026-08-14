/**
 * Smoke case: `TcpSocketLike.destroy()` is real on every runtime, and the
 * refusal path that uses it does not take the listener with it (#1096).
 *
 * `destroy()` is a different native call in each adapter — `socket.destroy()`
 * on Node, `socket.terminate()` on Bun, `Deno.Conn.close()` under Deno's
 * wrapper — and a wrong name is not a type error, because the adapters hand
 * back a hand-written object literal.  It would surface as a `TypeError`
 * swallowed by the refusal path's `catch`, which then silently reverts to the
 * half-close this fix removed.  The unit test cannot see that: it drives a
 * fake socket, so it proves the actor *chooses* `destroy()`, not that the
 * runtime under it has one.
 *
 * So the socket the adapter actually produced is fetched from the listener and
 * `destroy()` called on it directly — outside any `catch`, so a missing native
 * method fails the case instead of degrading quietly.
 *
 * **What this case cannot do is tell an abort from a half-close.**  Measured
 * both ways against a real listener: an `allowHalfOpen: true` peer sees `end`
 * fire, `close` not fire and `writable` stay true either way, and a further
 * `write()` succeeds in both.  The only signal that separates them is the
 * server socket's own `close`, which is not reachable from out here.  Running
 * the refusal path with `end()` restored passes every assertion below — so
 * these prove the call exists and works per runtime, and the unit test proves
 * it is the one the refusal makes.  Neither is redundant, and neither alone is
 * enough.
 */
export const name = 'TCP refusal aborts';
export const description = 'TcpSocketLike.destroy() is implemented per runtime and the listener survives a refusal';

const TIMEOUT_MS = 5_000;

export async function run({ actorTs, loadEntry }) {
  const { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { TcpServerActor, TcpServerOptions } = await loadEntry('io');
  const net = await import('node:net');

  class CollectingTarget extends Actor {
    constructor() { super(); this.opened = 0; }
    onReceive(message) { if (message.kind === 'connectionOpened') this.opened++; }
  }

  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('smoke-tcp-refusal', systemOptions);

  const holder = { actor: null };
  const clients = [];
  try {
    const target = new CollectingTarget();
    const targetRef = system.spawn(() => target, 'target');
    const serverOptions = TcpServerOptions.create()
      .withBindHost('127.0.0.1')
      .withBindPort(0)
      .withMaxConnections(1)
      .withTarget(targetRef);
    system.spawn(() => {
      holder.actor = new TcpServerActor(serverOptions);
      return holder.actor;
    }, 'tcp-server');

    await until(() => (holder.actor?.boundPort ?? 0) > 0, 'the listener reported a bound port');
    const port = holder.actor.boundPort;

    const admitted = dial(net, port, clients);
    await until(() => holder.actor.connectionCount === 1, 'the first connection was admitted');

    // The refusal path is the caller of this, but it wraps the call in a
    // `catch` — so exercise the adapter's socket directly, where a missing
    // native method is an error rather than a silent downgrade.
    const live = [...holder.actor.connections.values()][0];
    if (!live) throw new Error('the listener registered no connection to read the socket from');
    if (typeof live.socket.destroy !== 'function') {
      throw new Error('this runtime\'s TcpSocketLike has no destroy() — the refusal path would half-close');
    }
    live.socket.destroy();
    await until(() => admitted.settled(), 'destroy() tore the admitted connection down');

    // Now the refusal itself, on a listener that is back under its cap.
    await until(() => holder.actor.connectionCount === 0, 'the destroyed connection was deregistered');
    const readmitted = dial(net, port, clients);
    await until(() => holder.actor.connectionCount === 1, 'the listener still accepts after a destroy()');

    const refused = dial(net, port, clients);
    await until(() => refused.settled(), 'the over-cap connection was torn down');

    if (holder.actor.connectionCount !== 1) {
      throw new Error(`refused connection was counted: connectionCount=${holder.actor.connectionCount}`);
    }
    if (target.opened !== 2) {
      throw new Error(`refused connection was announced: ${target.opened} connectionOpened messages, expected 2`);
    }
    if (readmitted.settled()) {
      throw new Error('the refusal tore down the admitted connection as well');
    }
    if ((holder.actor.boundPort ?? 0) === 0) {
      throw new Error('the listener unbound while refusing a connection');
    }
  } finally {
    for (const client of clients) client.socket.destroy();
    await system.terminate();
  }
}

/** Dial and report whether the connection has ended, however it ended. */
function dial(net, port, clients) {
  const socket = net.createConnection({ host: '127.0.0.1', port, allowHalfOpen: true });
  let settled = false;
  const done = () => { settled = true; };
  socket.once('close', done);
  socket.once('end', done);
  socket.once('error', done); // an abort is the expected outcome, not a failure
  const entry = { socket, settled: () => settled };
  clients.push(entry);
  return entry;
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
