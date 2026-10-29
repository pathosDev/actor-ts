/**
 * Smoke case: a TLS dial settles on its handshake, on every runtime (#1475).
 *
 * `TcpBackend.connect` promises a socket that is open — over TLS, one whose
 * handshake is done — with `onOpen` run by the time it resolves, and a
 * rejection with no handler run for a dial that never opens.  Two adapters
 * broke it in ways only the real runtime shows.  Native `Bun.connect`
 * resolved at the TCP connect, so a write made at once was dropped: the first
 * batch of a GELF or syslog sink over TLS, every time it connected.
 * `Deno.connectTls` resolved there too, so a peer whose certificate the CA
 * does not sign arrived as `onError` on a dial that had already succeeded, and
 * a peer that stalled the handshake held a dial its connect deadline could no
 * longer give up.  The unit suites reach Deno through a stubbed global, which
 * cannot say what the real `connectTls` does.
 *
 * Three dials against loopback listeners: one that trusts the listener's CA,
 * which must resolve with `onOpen` run and have its first write answered; one
 * that trusts an unrelated CA, which must reject with no handler run; and one
 * into a listener that never speaks TLS, aborted while its handshake waits,
 * which must reject with the abort's reason and close its connection.
 *
 * The certificates are minted here, per run, and kept nowhere: a CA, a leaf it
 * signed for `127.0.0.1`, and a second CA that signed nothing in this case.
 * Two tiers rather than a self-signed leaf, because Deno's TLS stack refuses a
 * leaf as its own trust anchor.  Everything the case opens — listeners, the
 * sockets on both ends, its timers — is released in `finally`, on every path.
 */
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

export const name = 'TCP TLS dial settlement';
export const description =
  'a TLS dial resolves after its handshake; an untrusted peer and an abandoned handshake reject it with no handler run';

/** How long anything here may take: a loopback dial and its handshake land in milliseconds. */
const SETTLE_WITHIN_MS = 3_000;
const POLL_EVERY_MS = 10;

export async function run() {
  // The TCP backend is runtime plumbing, not public API, so it is not on the
  // harness's root barrel — reach it the way the peer-certificate case does.
  const fromBuild = globalThis.process?.env?.ACTOR_TS_SMOKE_USE_DIST === '1'
    || globalThis.Deno?.env?.get?.('ACTOR_TS_SMOKE_USE_DIST') === '1';
  const tcpPath = fromBuild ? '../../../dist/runtime/tcp/index.js' : '../../../src/runtime/tcp/index.ts';
  const { getTcpBackend } = await import(new URL(tcpPath, import.meta.url).href);
  const backend = await getTcpBackend();

  const material = mintTlsMaterial();
  const stranger = mintTlsMaterial();

  const listeners = [];
  const sockets = [];
  let released = false;
  // A socket that turns up after `finally` has run is released on arrival.
  const keep = (socket) => {
    if (released) release(socket);
    else sockets.push(socket);
    return socket;
  };
  const noop = () => {};

  try {
    const tlsListener = await backend.listen({
      host: '127.0.0.1',
      port: 0,
      tls: { cert: material.leaf.cert, key: material.leaf.key },
      handlers: {
        onOpen: keep,
        onData: (socket) => socket.write(Uint8Array.of(0x79)),
        onClose: noop,
        onError: noop,
      },
    });
    listeners.push(tlsListener);

    // 1. A trusted dial is open when it resolves, and its first write arrives.
    const trusted = recordingHandlers();
    const client = keep(await settleWithin(
      backend.connect({ host: '127.0.0.1', port: tlsListener.port, tls: { ca: material.ca }, handlers: trusted.handlers }),
      'the trusted TLS dial',
    ));
    if (trusted.calls.join(',') !== 'open') {
      throw new Error(`a trusted TLS dial resolved with [${trusted.calls}] run, not [open]`);
    }
    client.write(Uint8Array.of(0x78));
    await until(() => trusted.calls.includes('data'), 'the first write after the trusted dial resolved was answered');

    // 2. A peer the CA does not sign rejects the dial, and no handler runs.
    const untrusted = recordingHandlers();
    const outcome = await settleWithin(
      backend.connect({ host: '127.0.0.1', port: tlsListener.port, tls: { ca: stranger.ca }, handlers: untrusted.handlers })
        .then((socket) => { keep(socket); return 'resolved'; }, (error) => error),
      'the untrusted TLS dial',
    );
    if (!(outcome instanceof Error)) {
      throw new Error(`a TLS dial to a peer the CA does not sign ${outcome}; it should have rejected`);
    }
    // A second trusted round trip is the clock: whatever the untrusted dial's
    // socket still had to report has been reported by the time it is answered.
    const clock = recordingHandlers();
    keep(await settleWithin(
      backend.connect({ host: '127.0.0.1', port: tlsListener.port, tls: { ca: material.ca }, handlers: clock.handlers }),
      'the clock dial',
    )).write(Uint8Array.of(0x78));
    await until(() => clock.calls.includes('data'), 'the clock dial was answered');
    if (untrusted.calls.length > 0) {
      throw new Error(`a rejected TLS dial ran [${untrusted.calls}]; a dial that fails runs no handler`);
    }

    // 3. A dial whose handshake never comes is given up by its signal.
    const silentAccepted = [];
    const silentClosed = [];
    const silentListener = await backend.listen({
      host: '127.0.0.1',
      port: 0,
      handlers: {
        onOpen: (socket) => { silentAccepted.push(keep(socket)); },
        onData: noop,
        onClose: (socket) => { silentClosed.push(socket); },
        onError: noop,
      },
    });
    listeners.push(silentListener);
    const controller = new AbortController();
    const stalled = recordingHandlers();
    const stalledOutcome = backend
      .connect({
        host: '127.0.0.1', port: silentListener.port, tls: { ca: material.ca }, handlers: stalled.handlers, signal: controller.signal,
      })
      .then((socket) => { keep(socket); return 'resolved'; }, (error) => error);
    await until(() => silentAccepted.length === 1, 'the stalled dial\'s TCP connect landed');
    const reason = new Error('the dial was given up while its handshake waited');
    controller.abort(reason);
    const settled = await settleWithin(stalledOutcome, 'the abandoned TLS dial');
    if (settled !== reason) {
      throw new Error(`a TLS dial aborted in its handshake settled with ${settled}, not with the abort's reason`);
    }
    // Deno closes the connection too, but does not end the TCP connection
    // under a TLS connection closed while its handshake waits: on Deno 2.6.8
    // the far side saw no end of it within 20 s.  There the rejection is all
    // an abort can show, and the far side keeps the socket until it closes it.
    if (globalThis.Deno === undefined) {
      await until(() => silentClosed.length === 1, 'the listener saw the abandoned dial close');
    }
    if (stalled.calls.length > 0) {
      throw new Error(`an abandoned TLS dial ran [${stalled.calls}]; a dial that is given up runs no handler`);
    }
  } finally {
    released = true;
    for (const socket of sockets.splice(0)) release(socket);
    for (const listener of listeners.splice(0)) await listener.close();
  }
}

function release(socket) {
  try { socket.destroy?.() ?? socket.end(); } catch { /* already gone */ }
}

/** Counts every handler call, so "no handler ran" is an assertion and not a hope. */
function recordingHandlers() {
  const calls = [];
  return {
    calls,
    handlers: {
      onOpen: () => { calls.push('open'); },
      onData: () => { calls.push('data'); },
      onClose: () => { calls.push('close'); },
      onError: () => { calls.push('error'); },
    },
  };
}

/** `promise`, or a failure naming `label` once {@link SETTLE_WITHIN_MS} has passed; the timer never outlives it. */
async function settleWithin(promise, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${SETTLE_WITHIN_MS} ms`)), SETTLE_WITHIN_MS);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(condition, label) {
  for (let waited = 0; waited < SETTLE_WITHIN_MS; waited += POLL_EVERY_MS) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
  }
  if (!condition()) throw new Error(`${label}: not within ${SETTLE_WITHIN_MS} ms`);
}

/* ------------------------------------------------------------------------ */
/* Throwaway certificates — `node:crypto` builds no X.509, so the few DER    */
/* structures one needs are written out.                                     */
/* ------------------------------------------------------------------------ */

function concatenate(parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** DER length octets, in the minimal form DER requires — a strict parser refuses any other. */
function lengthOctets(length) {
  if (length < 0x80) return Uint8Array.of(length);
  const octets = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) octets.unshift(remaining % 256);
  return Uint8Array.of(0x80 | octets.length, ...octets);
}

function element(tag, ...contents) {
  const body = concatenate(contents);
  return concatenate([Uint8Array.of(tag), lengthOctets(body.length), body]);
}

const sequence = (...contents) => element(0x30, ...contents);
const text = (value) => new TextEncoder().encode(value);

function objectIdentifier(dotted) {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const octets = [40 * first + second];
  for (const arc of rest) {
    const base128 = [arc % 128];
    for (let remaining = Math.floor(arc / 128); remaining > 0; remaining = Math.floor(remaining / 128)) {
      base128.unshift(0x80 | (remaining % 128));
    }
    octets.push(...base128);
  }
  return element(0x06, Uint8Array.from(octets));
}

function utcTime(date) {
  const two = (value) => String(value).padStart(2, '0');
  return element(0x17, text(
    two(date.getUTCFullYear() % 100) + two(date.getUTCMonth() + 1) + two(date.getUTCDate())
      + two(date.getUTCHours()) + two(date.getUTCMinutes()) + two(date.getUTCSeconds()) + 'Z',
  ));
}

const distinguishedName = (commonName) =>
  sequence(element(0x31, sequence(objectIdentifier('2.5.4.3'), element(0x0c, text(commonName)))));

function extension(identifier, critical, value) {
  return sequence(
    objectIdentifier(identifier),
    ...(critical ? [element(0x01, Uint8Array.of(0xff))] : []),
    element(0x04, value),
  );
}

const keyIdentifier = (publicKey) =>
  new Uint8Array(createHash('sha1').update(publicKey.export({ type: 'spki', format: 'der' })).digest());

function certificate({ subject, issuer, publicKey, signingKey, extensions }) {
  const serialNumber = randomBytes(8);
  serialNumber[0] = (serialNumber[0] & 0x7f) | 0x01;
  const now = Date.now();
  const ecdsaWithSha256 = sequence(objectIdentifier('1.2.840.10045.4.3.2'));
  const toBeSigned = sequence(
    element(0xa0, element(0x02, Uint8Array.of(2))),
    element(0x02, new Uint8Array(serialNumber)),
    ecdsaWithSha256,
    distinguishedName(issuer),
    sequence(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    distinguishedName(subject),
    new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
    element(0xa3, sequence(...extensions)),
  );
  const signature = new Uint8Array(sign('sha256', toBeSigned, signingKey));
  const der = sequence(toBeSigned, ecdsaWithSha256, element(0x03, Uint8Array.of(0), signature));
  const lines = Buffer.from(der).toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** A CA, and a leaf it signed for `localhost` / `127.0.0.1`. */
function mintTlsMaterial() {
  const authority = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const authorityName = `actor-ts smoke CA ${randomBytes(4).toString('hex')}`;
  const ca = certificate({
    subject: authorityName,
    issuer: authorityName,
    publicKey: authority.publicKey,
    signingKey: authority.privateKey,
    extensions: [
      extension('2.5.29.19', true, sequence(element(0x01, Uint8Array.of(0xff)))),
      // keyCertSign and cRLSign: bits 5 and 6, one unused bit after them.
      extension('2.5.29.15', true, element(0x03, Uint8Array.of(1, 0x06))),
      extension('2.5.29.14', false, element(0x04, keyIdentifier(authority.publicKey))),
    ],
  });
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const cert = certificate({
    subject: 'localhost',
    issuer: authorityName,
    publicKey: keys.publicKey,
    signingKey: authority.privateKey,
    extensions: [
      extension('2.5.29.19', false, sequence()),
      // digitalSignature: bit 0, seven unused bits after it.
      extension('2.5.29.15', true, element(0x03, Uint8Array.of(7, 0x80))),
      extension('2.5.29.37', false, sequence(objectIdentifier('1.3.6.1.5.5.7.3.1'))),
      extension('2.5.29.17', false, sequence(element(0x82, text('localhost')), element(0x87, Uint8Array.of(127, 0, 0, 1)))),
      extension('2.5.29.35', false, sequence(element(0x80, keyIdentifier(authority.publicKey)))),
    ],
  });
  return { ca, leaf: { cert, key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } };
}
