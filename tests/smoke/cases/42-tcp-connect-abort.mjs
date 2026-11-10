/**
 * Smoke case: a dial that is given up stops, on every runtime (#1475).
 *
 * `TcpBackend.connect` takes a signal, and each adapter honours it through a
 * different native call: `destroy()` on the pending `node:net` socket on Node,
 * the same through Bun's own `node:net` on Bun (native `Bun.connect` takes no
 * signal), and `Deno.connect({ signal })` on Deno.  The unit tests reach the
 * Deno adapter through a stubbed global and the Node one partly through its
 * module seam, so neither can say that the real runtime's connect stops.
 * This case dials an address nothing answers and aborts the dial while it is
 * still connecting.
 *
 * **The handle is the real assertion, and the harness makes it.**  An abort
 * that merely rejected the promise would pass every check below and leave the
 * connect running until the OS gave up on it — about 21 s on Windows, longer
 * on Linux — which holds the event loop open past the last case, and the
 * runner's exit watchdog then reports the leak (#1196).  Everything this case
 * opens itself — its timers, and any socket a broken abort hands back after
 * all — is released in `finally`, on every path, so that the only handle that
 * can be left over is the one the adapter failed to release.
 *
 * Plaintext only, deliberately.  Deno cannot cancel a TLS dial at all
 * (`Deno.connectTls` takes no signal), so a pending one would hold this process
 * for the OS timeout by design; that combination is documented on the contract
 * and unit-tested against a stub.
 */
export const name = 'TCP connect abort';
export const description = 'an aborted dial to an unroutable address rejects at once and leaves nothing behind';

/** TEST-NET-1 (RFC 5737): assigned to nobody, so a SYN to it is never answered. */
const UNROUTABLE = '192.0.2.1';
const PORT = 25_999;
/** Long enough that the dial is genuinely in its TCP connect when it is aborted. */
const ABORT_AFTER_MS = 150;
/** How long the aborted dial may take to settle: Node measured 2 ms, Deno 7 ms, Bun 1 ms. */
const SETTLE_AFTER_ABORT_MS = 1_000;
/** How long to give a runtime to deliver anything it still would on a dial given up. */
const QUIET_PERIOD_MS = 100;

export async function run() {
  // The TCP backend is runtime plumbing, not public API — reach it the way the
  // peer-certificate case does.
  const fromBuild = globalThis.process?.env?.ACTOR_TS_SMOKE_USE_DIST === '1'
    || globalThis.Deno?.env?.get?.('ACTOR_TS_SMOKE_USE_DIST') === '1';
  const tcpPath = fromBuild ? '../../../dist/runtime/tcp/index.js' : '../../../src/runtime/tcp/index.ts';
  const { getTcpBackend } = await import(new URL(tcpPath, import.meta.url).href);
  const backend = await getTcpBackend();

  const calls = [];
  const handlers = {
    onOpen: () => { calls.push('open'); },
    onData: () => { calls.push('data'); },
    onClose: () => { calls.push('close'); },
    onError: () => { calls.push('error'); },
  };
  const timers = [];
  const handedBack = [];

  try {
    // A signal aborted before the dial: nothing may be dialled at all.
    const early = new AbortController();
    early.abort();
    const refused = await within(settle(backend.connect({
      host: UNROUTABLE, port: PORT, handlers, signal: early.signal,
    }), handedBack), SETTLE_AFTER_ABORT_MS, timers);
    if (refused === null) {
      throw new Error(`a dial whose signal was already aborted had not settled after ${SETTLE_AFTER_ABORT_MS} ms`);
    }
    if (!refused.rejected || refused.reason !== early.signal.reason) {
      throw new Error(`a dial whose signal was already aborted ${describe(refused)} instead of rejecting with the signal's reason`);
    }

    // A signal aborted while the dial is still connecting.
    const controller = new AbortController();
    const pending = settle(backend.connect({
      host: UNROUTABLE, port: PORT, handlers, signal: controller.signal,
    }), handedBack);
    let abortedAt = -1;
    timers.push(setTimeout(() => { abortedAt = Date.now(); controller.abort(); }, ABORT_AFTER_MS));

    const outcome = await within(pending, ABORT_AFTER_MS + SETTLE_AFTER_ABORT_MS, timers);
    if (outcome === null) {
      throw new Error(
        `the dial was aborted after ${ABORT_AFTER_MS} ms and had still not settled `
        + `${SETTLE_AFTER_ABORT_MS} ms later — the abort did not stop it`,
      );
    }
    if (abortedAt < 0) {
      // The route was refused before the abort went out (no default route, a
      // firewall that answers with a reject).  Nothing here can make the dial
      // pend, so say so instead of claiming the abort path was exercised.
      console.warn(
        `  ! ${name}: ${UNROUTABLE} ${describe(outcome)} before it could be aborted; `
        + 'this network does not leave a dial pending, so the abort path went unexercised',
      );
      return;
    }
    if (!outcome.rejected || outcome.reason !== controller.signal.reason) {
      throw new Error(`the aborted dial ${describe(outcome)} instead of rejecting with the signal's reason`);
    }

    // Anything the runtime still delivers for the given-up socket must reach
    // no handler.  A wait, not a poll: the assertion is that nothing happens.
    await new Promise((resolve) => { timers.push(setTimeout(resolve, QUIET_PERIOD_MS)); });
    if (calls.length > 0) {
      throw new Error(`a handler fired for a dial that was given up: ${calls.join(', ')}`);
    }
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of handedBack) {
      // Written out: `destroy()` returns undefined, so `destroy?.() ?? end()`
      // would half-close every socket it had just destroyed.
      try {
        if (socket.destroy) socket.destroy();
        else socket.end();
      } catch { /* already gone */ }
    }
  }
}

/**
 * Watch a dial from the start, so a rejection is never unhandled, and keep any
 * socket it hands back so `finally` can release it.
 */
function settle(dial, handedBack) {
  return dial.then(
    (socket) => { handedBack.push(socket); return { rejected: false, socket }; },
    (reason) => ({ rejected: true, reason }),
  );
}

/** `outcome` if it settles within `ms`, otherwise `null`; the timer is the caller's to release. */
function within(outcome, ms, timers) {
  return Promise.race([
    outcome,
    new Promise((resolve) => { timers.push(setTimeout(() => resolve(null), ms)); }),
  ]);
}

function describe(outcome) {
  if (!outcome.rejected) return 'resolved with a socket';
  const reason = outcome.reason;
  const label = reason?.code ?? reason?.name ?? 'an error';
  return `rejected with ${label}${reason?.message ? ` (${reason.message})` : ''}`;
}
