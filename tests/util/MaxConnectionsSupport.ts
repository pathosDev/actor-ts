import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { enforceMaxConnections } from '../../src/http/backend/HttpServerBackend.js';

/**
 * Ask *this* runtime how it treats a connection past `server.maxConnections`,
 * so a failing cap assertion can say which layer let it through (#1505).
 *
 * The three end-to-end cases that assert the documented cap have been red on
 * GitHub's Linux runners and green on Windows — measured on the same bun
 * 1.4.0, in two independent workflows, five runs of five, so not a flake. What
 * the assertion says when it fails is `expect(true).toBe(false)`, which names
 * neither the layer nor the platform and sends the next reader to the wrong
 * file.
 *
 * There are exactly three ways the cap can fail to close a connection, and
 * they want three different fixes:
 *
 *  1. **The runtime honours the property by closing** — the socket is accepted
 *     and destroyed, the client sees a close. Node and bun both do this on
 *     Windows, measured. Nothing to fix.
 *  2. **The runtime honours it by not accepting** — the connection sits in the
 *     listen backlog, never accepted, never closed. The client's `connect()`
 *     still succeeds, so from the outside this is indistinguishable from an
 *     unenforced cap; and because no `'connection'` event is emitted, the
 *     framework's own {@link enforceMaxConnections} never sees the socket
 *     either. Writing the property would then *disable* the portable guard.
 *  3. **The runtime ignores the property** — the connection is accepted and
 *     served, `'connection'` fires, and the guard alone can hold the cap.
 *
 * This probe distinguishes them, against a bare `node:http` server so nothing
 * of the framework's own wiring is in the way. It is diagnosis, never a gate:
 * no assertion is conditioned on the result, because a cap that does not hold
 * is a defect in a control `http/security.mdx` offers as the connection-flood
 * answer, whatever the reason.
 */
export type MaxConnectionsSupport = {
  /** The client saw its connection closed when the property was set. */
  readonly runtimeClosesPastCap: boolean;
  /** The server emitted `'connection'` for that socket, so a guard could see it. */
  readonly runtimeEmitsConnectionPastCap: boolean;
  /** With the property unset, the framework's own guard closed the connection. */
  readonly guardClosesPastCap: boolean;
};

/** Long enough for a close made on accept; short enough not to pad a red run. */
const VERDICT_MS = 1_000;

/** Close a server and wait for it, tolerating one that never opened. */
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
}

/**
 * Bind, run `body`, and release every handle **on every path** — the rule
 * `tests/smoke/` learned the hard way (#1196), and it applies harder here
 * because this helper runs inside a suite that is already failing.
 */
async function withServer<T>(
  configure: (server: Server) => void,
  body: (port: number, server: Server) => Promise<T>,
): Promise<T> {
  const server = createServer((_request, response) => response.end('ok'));
  configure(server);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return await body(address.port, server);
  } finally {
    await closeServer(server);
  }
}

function open(port: number, opened: Socket[]): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => resolve(socket));
    socket.once('error', reject);
    opened.push(socket);
  });
}

function closedWithin(socket: Socket, withinMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    socket.on('data', () => { /* drain, or 'close' never arrives */ });
    socket.once('close', () => resolve(true));
    const timer = setTimeout(() => resolve(false), withinMs);
    (timer as { unref?: () => void }).unref?.();
  });
}

/** Open `cap + 1` connections and report what happened to the last one. */
async function pastCap(
  port: number,
  cap: number,
): Promise<boolean> {
  const opened: Socket[] = [];
  try {
    for (let index = 0; index < cap; index++) await open(port, opened);
    const excess = await open(port, opened);
    return await closedWithin(excess, VERDICT_MS);
  } finally {
    for (const socket of opened) socket.destroy();
  }
}

/** Measure this runtime. Costs about two seconds, so call it only on a failure. */
export async function probeMaxConnectionsSupport(): Promise<MaxConnectionsSupport> {
  let sawConnectionPastCap = false;
  const runtimeClosesPastCap = await withServer(
    (server) => {
      server.maxConnections = 1;
      let accepted = 0;
      server.on('connection', () => {
        accepted++;
        if (accepted > 1) sawConnectionPastCap = true;
      });
    },
    (port) => pastCap(port, 1),
  );
  const guardClosesPastCap = await withServer(
    // No `maxConnections` here on purpose: with the property unset, the only
    // thing that can close the connection is the code in this repository.
    (server) => { enforceMaxConnections(server, 1); },
    (port) => pastCap(port, 1),
  );
  return {
    runtimeClosesPastCap,
    runtimeEmitsConnectionPastCap: sawConnectionPastCap,
    guardClosesPastCap,
  };
}

/** One paragraph naming which of the three cases this machine is in. */
export function explainMaxConnections(support: MaxConnectionsSupport): string {
  const reading = `runtime closes past the cap: ${support.runtimeClosesPastCap}; `
    + `runtime emits 'connection' past the cap: ${support.runtimeEmitsConnectionPastCap}; `
    + `the framework's own guard closes past the cap: ${support.guardClosesPastCap}`;
  const diagnosis = support.runtimeClosesPastCap
    ? 'This runtime DOES enforce the cap on a bare node:http server, so the '
      + 'failure is in how the framework reaches the backend\'s server — not in '
      + 'the runtime. Look at applyServerOptions and what the backend hands it.'
    : support.runtimeEmitsConnectionPastCap
      ? 'This runtime ignores server.maxConnections but does emit \'connection\', '
        + 'so enforceMaxConnections can hold the cap and something stopped it '
        + 'from being installed.'
      : 'This runtime neither closes the connection nor emits \'connection\' for '
        + 'it — the socket is left in the listen backlog. enforceMaxConnections '
        + 'cannot see a socket the server never accepts, so writing '
        + 'server.maxConnections DISABLES the portable guard rather than adding '
        + 'to it. The fix is to stop writing the property where this holds.';
  return `\n\nmax-connections support on ${process.platform}`
    + `${process.versions.bun ? ` / bun ${process.versions.bun}` : ''} — ${reading}.\n${diagnosis}\n`
    + 'See #1505 and tests/unit/http/MaxConnectionsGuard.test.ts.';
}

/** The probe and its explanation, for use directly as an assertion message. */
export async function diagnoseMaxConnections(): Promise<string> {
  return explainMaxConnections(await probeMaxConnectionsSupport());
}
