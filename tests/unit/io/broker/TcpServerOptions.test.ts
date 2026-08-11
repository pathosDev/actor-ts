/**
 * Validator rules for `TcpServerOptions` (#158).
 *
 * The TLS block is the load-bearing part.  `assertListenerTlsIsCoherent`
 * already guards the bind (#144), but a `TcpServerActor` binds from
 * `connectImplementation`, where `BrokerActor` reads any throw as a
 * *connection* failure and answers it with the reconnect policy — so without
 * this gate a half-configured certificate would back off and retry forever
 * instead of failing the actor's start.  These tests pin the rule to the
 * options layer, where it fails once and loudly.
 */
import { describe, expect, test } from 'bun:test';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import {
  TcpServerOptions,
  TcpServerOptionsValidator,
  type TcpServerOptionsType,
} from '../../../../src/io/broker/TcpServerOptions.js';

const CERT = '-----BEGIN CERTIFICATE-----\nnot-a-real-cert\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----';
const CA = '-----BEGIN CERTIFICATE-----\nnot-a-real-ca\n-----END CERTIFICATE-----';

const check = (s: Partial<TcpServerOptionsType>): void => new TcpServerOptionsValidator().validate(s);

describe('TcpServerOptionsValidator — bind address', () => {
  test('accepts bindPort 0 (let the OS pick)', () => {
    expect(() => check({ bindPort: 0 })).not.toThrow();
  });

  test('rejects a bindPort outside [0, 65535]', () => {
    expect(() => check({ bindPort: 70000 })).toThrow(/bindPort/);
    expect(() => check({ bindPort: -1 })).toThrow(OptionsError);
  });

  test('rejects an empty bindHost', () => {
    expect(() => check({ bindHost: '' })).toThrow(/bindHost/);
  });

  test('an unset field always passes', () => {
    expect(() => check({})).not.toThrow();
  });
});

describe('TcpServerOptionsValidator — maxConnections', () => {
  test('accepts Infinity — the unlimited default', () => {
    expect(() => check({ maxConnections: Number.POSITIVE_INFINITY })).not.toThrow();
  });

  test('rejects 0 and fractions', () => {
    expect(() => check({ maxConnections: 0 })).toThrow(/maxConnections/);
    expect(() => check({ maxConnections: 2.5 })).toThrow(OptionsError);
  });
});

describe('TcpServerOptionsValidator — framing caps', () => {
  // Same rule as TcpSocketOptions: a NaN cap does not clamp, it REMOVES the
  // cap, because both are applied as `length > cap`.
  test('rejects a non-numeric maxLineLen', () => {
    expect(() => check({ framing: { kind: 'lines', maxLineLen: Number.NaN } }))
      .toThrow(/framing\.maxLineLen/);
  });

  test('rejects a zero maxFrameLen', () => {
    expect(() => check({ framing: { kind: 'length-prefixed', maxFrameLen: 0 } }))
      .toThrow(/framing\.maxFrameLen/);
  });

  test('accepts framing that leaves the caps unset', () => {
    expect(() => check({ framing: { kind: 'lines' } })).not.toThrow();
    expect(() => check({ framing: { kind: 'bytes' } })).not.toThrow();
  });
});

describe('TcpServerOptionsValidator — TLS coherence (#144)', () => {
  test('accepts a complete server credential', () => {
    expect(() => check({ tls: { cert: CERT, key: KEY } })).not.toThrow();
  });

  test('rejects a cert without its key — the silent-plaintext shape', () => {
    expect(() => check({ tls: { cert: CERT } })).toThrow(/PLAINTEXT/);
    expect(() => check({ tls: { cert: CERT } })).toThrow(OptionsError);
  });

  test('rejects a key without its cert', () => {
    expect(() => check({ tls: { key: KEY } })).toThrow(/PLAINTEXT/);
  });

  test('rejects a `ca`-only listener — nothing to present', () => {
    expect(() => check({ tls: { ca: CA } })).toThrow(/PLAINTEXT/);
  });

  test('rejects requestClientCert without a ca to verify against', () => {
    expect(() => check({ tls: { cert: CERT, key: KEY, requestClientCert: true } }))
      .toThrow(/requestClientCert/);
  });

  test('an empty string counts as absent, not as configured', () => {
    // What a mis-mounted secret or an unset env var looks like by the time it
    // arrives here — treating it as material would push the failure into the
    // TLS stack as an opaque PEM parse error.
    expect(() => check({ tls: { cert: CERT, key: '' } })).toThrow(/PLAINTEXT/);
  });

  test('no tls at all is an ordinary plaintext listener', () => {
    expect(() => check({ bindPort: 9000 })).not.toThrow();
  });
});

describe('TcpServerOptions — builder is its settings', () => {
  test('a builder validates identically to the plain object it spreads to', () => {
    const serverOptions = TcpServerOptions.create()
      .withBindHost('127.0.0.1')
      .withBindPort(0)
      .withMaxConnections(10);
    expect(() => check(serverOptions as Partial<TcpServerOptionsType>)).not.toThrow();
    expect({ ...serverOptions }).toEqual({ bindHost: '127.0.0.1', bindPort: 0, maxConnections: 10 });
  });

  test('a builder carrying a broken TLS block is rejected the same way', () => {
    const serverOptions = TcpServerOptions.create()
      .withBindPort(0)
      .withTls({ cert: CERT });
    expect(() => check(serverOptions as Partial<TcpServerOptionsType>)).toThrow(/PLAINTEXT/);
  });
});
