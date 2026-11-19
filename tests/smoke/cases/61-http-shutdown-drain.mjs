/**
 * Smoke case: the shutdown pipeline drains an HTTP request in flight on the
 * shipped default, and readiness says "draining" while it does (#997).
 *
 * Cross-runtime because the drain is the runtime's: the default Fastify
 * backend stops accepting through `node:http`'s `close()`, which each runtime
 * implements itself, and what a server does with a request whose handler is
 * still working when it is told to close is exactly the kind of thing the
 * three disagree on.  The shipped `shutdown-grace-period` used to be `0`, so
 * the request was cut with a reset on every runtime.
 *
 * Asserted:
 *
 *  1. the request in flight when `CoordinatedShutdown.run()` starts completes
 *     with its `200` and body;
 *  2. the readiness registry `/ready` reads carries a failing `shutdown`
 *     check by the time the servers stop accepting;
 *  3. once the run is over, the port takes no new connection (Bun and Node;
 *     see the note at the assertion for Deno).
 *
 * Handle hygiene (#1196): the run terminates the actor system, which closes
 * the listener; the probe socket is destroyed and its timer cleared on every
 * path, and a failure before the run still terminates the system in
 * `finally`.
 */
import { connect } from 'node:net';

export const name = 'http shutdown drain';
export const description = 'a coordinated shutdown lets a request in flight finish on the default grace period, with readiness failing while it drains';

/** How long the slow handler works once entered: long enough to start the shutdown inside it, well under the 4 s default. */
const HANDLER_WORK_MS = 800;
const RESPONSE_WITHIN_MS = 10_000;

/** Whether a fresh connection to `port` is refused; the socket and timer are released on every path. */
function connectionRefused(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2_000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    socket.once('error', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
  });
}

export async function run({ actorTs, runtime, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, CoordinatedShutdownId, LogLevel, NoopLogger, Phases } = actorTs;
  const { HttpExtensionId, completeText, get, path } = await loadEntry('http');
  const { healthChecksOf } = await loadEntry('management');

  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('smoke-http-shutdown-drain', systemOptions);
  let ran = false;
  try {
    let signalEntered;
    const entered = new Promise((resolve) => { signalEntered = resolve; });
    const route = path('slow', get(async () => {
      signalEntered();
      await new Promise((resolve) => setTimeout(resolve, HANDLER_WORK_MS));
      return completeText(200, 'drained');
    }));
    const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(route);
    const health = healthChecksOf(system);

    const shutdown = system.extension(CoordinatedShutdownId);
    let readinessWhileUnbinding;
    shutdown.addTask(Phases.ServiceUnbind, 'smoke-readiness-probe', async () => {
      readinessWhileUnbinding = await health.checkReadiness();
    });

    const response = fetch(`http://127.0.0.1:${binding.port}/slow`, { signal: AbortSignal.timeout(RESPONSE_WITHIN_MS) });
    await entered;
    ran = true;
    const pipeline = shutdown.run();

    let answered;
    try {
      answered = await response;
    } catch (e) {
      throw new Error(`the request in flight was cut by the shutdown instead of drained: ${e.message}`);
    }
    const body = await answered.text();
    if (answered.status !== 200 || body !== 'drained') {
      throw new Error(`the request in flight got ${answered.status} ${JSON.stringify(body)}, not 200 "drained"`);
    }
    await pipeline;

    const draining = (readinessWhileUnbinding ?? []).find((result) => result.name === 'shutdown');
    if (draining === undefined || draining.status !== false) {
      throw new Error(`readiness did not fail while the server unbound: ${JSON.stringify(readinessWhileUnbinding)}`);
    }
    // Not on Deno: measured on deno 2.6.8 (Windows), the port still took a TCP
    // connection after a run whose unbind had resolved, at a grace period of
    // 0 as at the default — so it is not the drain, and it is recorded as a
    // finding of its own rather than asserted here.
    if (runtime !== 'deno' && !(await connectionRefused(binding.port))) {
      throw new Error('the port still accepted a connection after the shutdown ran');
    }
  } finally {
    if (!ran) await system.terminate();
    await system.whenTerminated();
  }
}
