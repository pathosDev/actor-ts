/**
 * A verifying native Bun TLS dial does not take Bun's handshake verdict on
 * trust (#1793).
 *
 * The dial opens only when the handshake succeeded with no authorization error
 * and the peer certificate names the host.  On the pinned Bun a real handshake
 * already fails in every case below, so it cannot show that the backend's own
 * checks hold; these cases hand the verdict function a `success` flag that
 * disagrees with the rest of what the handler receives.
 */
import { describe, expect, test } from 'bun:test';
import { checkServerIdentity } from 'node:tls';
import { handshakeRefusal } from '../../../../src/runtime/tcp/BunTcpBackend.js';

/** The shape `getPeerCertificate()` returns, for a leaf that names `127.0.0.1` and `localhost`. */
const LOOPBACK_LEAF = {
  subject: { CN: 'actor-ts test leaf' },
  subjectaltname: 'DNS:localhost, IP Address:127.0.0.1',
};

/** A native socket as far as the verdict reads it. */
function socketPresenting(certificate: unknown): { write(): number; end(): void; terminate(): void; getPeerCertificate(): unknown } {
  return { write: () => 0, end: () => {}, terminate: () => {}, getPeerCertificate: () => certificate };
}

function verificationError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const check = checkServerIdentity as unknown as Parameters<typeof handshakeRefusal>[4];

describe('a verifying native TLS dial decides the handshake itself (#1793)', () => {
  test('a success that carries a verification error is refused with that error', () => {
    const error = verificationError('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(handshakeRefusal(socketPresenting(LOOPBACK_LEAF), true, error, '127.0.0.1', check)).toBe(error);
  });

  test('a clean success whose certificate does not name the host is refused', () => {
    const refusal = handshakeRefusal(socketPresenting(LOOPBACK_LEAF), true, null, 'wrong.example', check);
    expect((refusal as { code?: string } | null | undefined)?.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  test('a clean success with no peer certificate at all is refused', () => {
    expect(handshakeRefusal(socketPresenting(undefined), true, undefined, '127.0.0.1', check)).toBeInstanceOf(Error);
  });

  test('a clean success whose certificate names the host opens — by IP and by DNS name', () => {
    expect(handshakeRefusal(socketPresenting(LOOPBACK_LEAF), true, null, '127.0.0.1', check)).toBeUndefined();
    expect(handshakeRefusal(socketPresenting(LOOPBACK_LEAF), true, undefined, 'localhost', check)).toBeUndefined();
  });

  test('a failure Bun reports without an error is still a refusal, never an open', () => {
    expect(handshakeRefusal(socketPresenting(LOOPBACK_LEAF), false, undefined, '127.0.0.1', check)).toBeNull();
  });
});

describe('a dial that opted out of verification keeps Bun\'s verdict', () => {
  test('a success with a verification error beside it opens', () => {
    const error = verificationError('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(handshakeRefusal(socketPresenting(LOOPBACK_LEAF), true, error, 'wrong.example', undefined)).toBeUndefined();
  });

  test('a failure is still refused with its error', () => {
    const error = verificationError('ECONNRESET');
    expect(handshakeRefusal(socketPresenting(undefined), false, error, '127.0.0.1', undefined)).toBe(error);
  });
});
