/**
 * #1190 — peer identity can be required.
 *
 * `certificateAdmits` (#912) binds a peer's handshake claim to its TLS
 * certificate, and passes when the socket exposes none: a plaintext cluster,
 * one-way TLS and Deno all have nothing to check against.  That default stays.
 * What was missing is the opposite choice: a deployment that wants "every
 * peer proved its name" had no way to say so, and a half-applied TLS bundle
 * or a Deno node degraded the check to a no-op without a word.
 *
 * `requirePeerIdentity: true` makes a missing certificate a refusal.  It is
 * refused itself at construction where it could not mean what it says: with
 * no `ca` (nothing asks a peer for a certificate), with `requestClientCert:
 * false` (the listener asks for none), and on Deno, which cannot report one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame } from '../../../src/cluster/Protocol.js';
import { TcpTransportOptions } from '../../../src/cluster/TcpTransportOptions.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';
import { CLUSTER_WIRE_VERSION, MIN_CLUSTER_WIRE_VERSION } from '../../../src/cluster/WireVersion.js';
import { setRuntimeOverride } from '../../../src/runtime/Detect.js';
import type { PeerCertificate, TlsTransportOptionsType } from '../../../src/runtime/tcp/index.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

const SYSTEM = 'require-peer-identity';

let nextPort = 31_000;
const freshAddress = (): NodeAddress => {
  nextPort += 1;
  return new NodeAddress(SYSTEM, '127.0.0.1', nextPort, 'test-run');
};

/** Never handed to a runtime: no test here starts the transport. */
const MUTUAL_TLS: TlsTransportOptionsType = {
  cert: '-----BEGIN CERTIFICATE-----\nnode\n-----END CERTIFICATE-----',
  key: '-----BEGIN PRIVATE KEY-----\nnode\n-----END PRIVATE KEY-----',
  ca: '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----',
};

/** The private socket callbacks a peer's bytes arrive through. */
interface TcpTransportInternals {
  attachInbound(socket: unknown): void;
  onData(socket: unknown, chunk: Uint8Array): void;
}

type FakeSocket = {
  writes: Uint8Array[];
  closed: boolean;
  write(data: Uint8Array): boolean;
  end(): void;
  destroy(): void;
  peerCertificate?: () => PeerCertificate | undefined;
};

function socketPresenting(certificate: PeerCertificate | undefined): FakeSocket {
  return {
    writes: [],
    closed: false,
    write(data: Uint8Array): boolean { this.writes.push(data); return true; },
    end(): void { this.closed = true; },
    destroy(): void { this.closed = true; },
    peerCertificate: () => certificate,
  };
}

/** Deliver a peer's `hello` on a fresh inbound socket and report what the transport made of it. */
async function helloFrom(
  options: TcpTransportOptions,
  socket: FakeSocket,
): Promise<{ admitted: boolean; closed: boolean; warnings: string[] }> {
  const self = freshAddress();
  const claim = freshAddress();
  const log = new RecordingLogger();
  const transport = new TcpTransport(self, log, options);
  transport.setHandler(() => {});
  const internals = transport as unknown as TcpTransportInternals;
  internals.attachInbound(socket);
  internals.onData(socket, encodeFrame({
    kind: 'hello',
    wireVersion: CLUSTER_WIRE_VERSION,
    minWireVersion: MIN_CLUSTER_WIRE_VERSION,
    self: claim.toJSON(),
  }));
  const admitted = transport.peers().some((peer) => peer.equals(claim));
  const closed = socket.closed;
  const warnings = log.records.filter((record) => record.level === 'warn').map((record) => record.message);
  await transport.shutdown();
  return { admitted, closed, warnings };
}

afterEach(() => {
  setRuntimeOverride(null);
});

describe('#1190 — requirePeerIdentity refuses a peer that presents no certificate', () => {
  test('a hello on a socket with no certificate is refused under the option, with one WARN', async () => {
    const transportOptions = TcpTransportOptions.create()
      .withTls(MUTUAL_TLS)
      .withRequirePeerIdentity(true);
    const outcome = await helloFrom(transportOptions, socketPresenting(undefined));
    expect(outcome.admitted).toBe(false);
    expect(outcome.closed).toBe(true);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain('no certificate');
  });

  test('the same hello is admitted without the option — the fail-open default stays', async () => {
    const transportOptions = TcpTransportOptions.create().withTls(MUTUAL_TLS);
    const outcome = await helloFrom(transportOptions, socketPresenting(undefined));
    expect(outcome.admitted).toBe(true);
    expect(outcome.closed).toBe(false);
  });

  test('a socket with no certificate accessor at all is refused the same way', async () => {
    const socket = socketPresenting(undefined);
    delete socket.peerCertificate;
    const transportOptions = { tls: MUTUAL_TLS, requirePeerIdentity: true };
    const outcome = await helloFrom(transportOptions, socket);
    expect(outcome.admitted).toBe(false);
    expect(outcome.closed).toBe(true);
  });

  test('a peer whose certificate vouches for its claim is still admitted under the option', async () => {
    const transportOptions = { tls: MUTUAL_TLS, requirePeerIdentity: true };
    const outcome = await helloFrom(transportOptions, socketPresenting({ subjectAlternativeNames: ['127.0.0.1'] }));
    expect(outcome.admitted).toBe(true);
    expect(outcome.warnings).toEqual([]);
  });
});

describe('#1190 — requirePeerIdentity is refused at construction where it cannot hold', () => {
  const construct = (options: TcpTransportOptions): TcpTransport =>
    new TcpTransport(freshAddress(), new RecordingLogger(), options);

  test('a plaintext transport', () => {
    expect(() => construct({ requirePeerIdentity: true })).toThrow(OptionsError);
    expect(() => construct({ tls: null, requirePeerIdentity: true })).toThrow(/requirePeerIdentity/);
  });

  test('TLS with no ca, or a ca that holds no certificate', () => {
    const oneWay: TlsTransportOptionsType = { cert: MUTUAL_TLS.cert, key: MUTUAL_TLS.key };
    expect(() => construct({ tls: oneWay, requirePeerIdentity: true })).toThrow(/no `ca`/);
    expect(() => construct({ tls: { ...MUTUAL_TLS, ca: '  ' }, requirePeerIdentity: true })).toThrow(/no `ca`/);
  });

  test('a listener told not to request a client certificate', () => {
    const tls: TlsTransportOptionsType = { ...MUTUAL_TLS, requestClientCert: false };
    expect(() => construct({ tls, requirePeerIdentity: true })).toThrow(/requestClientCert/);
  });

  test('Deno, which cannot report a peer certificate', () => {
    setRuntimeOverride('deno');
    expect(() => construct({ tls: MUTUAL_TLS, requirePeerIdentity: true })).toThrow(/Deno/);
  });

  test('the same settings construct on Bun or Node, and false constructs anywhere', () => {
    setRuntimeOverride('node');
    expect(() => construct({ tls: MUTUAL_TLS, requirePeerIdentity: true })).not.toThrow();
    setRuntimeOverride('deno');
    expect(() => construct({ tls: MUTUAL_TLS, requirePeerIdentity: false })).not.toThrow();
    expect(() => construct({ requirePeerIdentity: false })).not.toThrow();
  });
});
