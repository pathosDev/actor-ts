/**
 * Smoke case: a half-configured TLS listener fails closed on every runtime (#144).
 *
 * Each runtime has its own `listen` path — `Bun.listen`, `tls.createServer`,
 * `Deno.listenTls` — and each used to decide "bind TLS?" for itself by testing
 * `cert && key`.  A configuration carrying only one of the two therefore
 * answered "no" and the listener bound in **plaintext**, silently, while the
 * dialing half of the same options object still spoke TLS.  That is the exact
 * shape of a per-adapter defect: three copies of one decision, any of which can
 * regress alone.
 *
 * The rule now lives in one place and every adapter routes through it, so what
 * is worth checking cross-runtime is that the refusal actually reaches the
 * runtime's bind — not that the shared helper returns the right verdict, which
 * the unit tests cover.  A regression here opens a real plaintext port, so the
 * case fails loudly if the listen resolves at all.
 *
 * The plaintext-listener half is checked too: the guard must reject a broken
 * TLS configuration without turning "no TLS" into an error, which is the path
 * every non-TLS cluster takes.
 */
export const name = 'TLS listener fails closed';
export const description = 'a listener given half a TLS credential refuses to bind plaintext';

const CERT = '-----BEGIN CERTIFICATE-----\nnot-a-real-cert\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----';

export async function run() {
  // The TCP backend is runtime plumbing, not public API, so it is not on the
  // harness's root barrel — reach it the way the peer-certificate case does.
  const fromBuild = globalThis.process?.env?.ACTOR_TS_SMOKE_USE_DIST === '1'
    || globalThis.Deno?.env?.get?.('ACTOR_TS_SMOKE_USE_DIST') === '1';
  const tcpPath = fromBuild ? '../../../dist/runtime/tcp/index.js' : '../../../src/runtime/tcp/index.ts';
  const { getTcpBackend } = await import(new URL(tcpPath, import.meta.url).href);

  const backend = await getTcpBackend();
  if (!backend) throw new Error('no TCP backend detected for this runtime');

  const noop = () => {};
  const handlers = { onOpen: noop, onData: noop, onClose: noop, onError: noop };

  // Port 0 lets the OS pick, so a regression really does open a listening
  // socket — which is the point of binding rather than stubbing.
  for (const [label, tls] of [['cert without key', { cert: CERT }], ['key without cert', { key: KEY }]]) {
    let listener;
    try {
      listener = await backend.listen({ host: '127.0.0.1', port: 0, tls, handlers });
    } catch (err) {
      const message = err?.message ?? String(err);
      if (!/PLAINTEXT/.test(message)) {
        throw new Error(`${label}: refused, but not with the fail-open diagnostic: ${message}`);
      }
      continue;
    }
    const port = listener.port;
    await listener.close();
    throw new Error(
      `${label}: the listener bound anyway, in plaintext, on port ${port} — a TLS downgrade`,
    );
  }

  // …and a listener with no TLS at all is still ordinary plain TCP.
  const plaintext = await backend.listen({ host: '127.0.0.1', port: 0, handlers });
  if (!(plaintext.port > 0)) throw new Error('plaintext listener reported no port');
  await plaintext.close();
}
