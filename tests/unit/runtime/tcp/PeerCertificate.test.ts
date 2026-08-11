/**
 * `toPeerCertificate` normalises what Node and Bun hand back from
 * `getPeerCertificate()` into the one shape the cluster transport matches a
 * claimed `hello` identity against (#912).
 *
 * The shapes asserted here were captured from the real runtimes against a
 * generated CA, not from documentation: both return `subjectaltname` as a
 * single comma-separated string with a per-entry type prefix, and both report
 * "the peer presented nothing" as an empty object rather than `null`.
 */
import { describe, expect, test } from 'bun:test';
import { toPeerCertificate } from '../../../../src/runtime/tcp/TcpBackend.js';

describe('toPeerCertificate', () => {
  test('reads the common name and strips SAN type prefixes', () => {
    // Verbatim from Bun 1.3 / Node 24 with a client cert whose SANs are
    // `DNS:node-a, DNS:node-a@127.0.0.1`.
    const certificate = toPeerCertificate({
      subject: { CN: 'node-a@127.0.0.1' },
      subjectaltname: 'DNS:node-a, DNS:node-a@127.0.0.1',
    });

    expect(certificate).toEqual({
      commonName: 'node-a@127.0.0.1',
      subjectAlternativeNames: ['node-a', 'node-a@127.0.0.1'],
    });
  });

  test('handles an IP SAN, whose prefix contains a space', () => {
    // `IP Address:` — splitting on the first colon rather than a fixed
    // prefix list is what makes this work without enumerating types.
    const certificate = toPeerCertificate({
      subject: { CN: 'localhost' },
      subjectaltname: 'DNS:localhost, IP Address:127.0.0.1',
    });

    expect(certificate?.subjectAlternativeNames).toEqual(['localhost', '127.0.0.1']);
  });

  test('an empty object means the peer presented no certificate', () => {
    // This is how Node reports it, and it is the case that decides whether
    // the transport enforces identity at all — a wrong answer here would
    // turn one-way TLS into a hard rejection.
    expect(toPeerCertificate({})).toBeUndefined();
  });

  test('absent, null and non-object inputs yield undefined', () => {
    expect(toPeerCertificate(undefined)).toBeUndefined();
    expect(toPeerCertificate(null)).toBeUndefined();
    expect(toPeerCertificate('cert')).toBeUndefined();
  });

  test('a certificate with neither a CN nor a SAN yields undefined', () => {
    // Nothing to match against is indistinguishable from no certificate,
    // and reporting it as present would fail every identity check instead
    // of skipping the rule.
    expect(toPeerCertificate({ subject: {}, subjectaltname: '' })).toBeUndefined();
    expect(toPeerCertificate({ issuer: { CN: 'ca' } })).toBeUndefined();
  });

  test('a CN with no SANs is still usable', () => {
    expect(toPeerCertificate({ subject: { CN: 'node-b' } })).toEqual({
      commonName: 'node-b',
      subjectAlternativeNames: [],
    });
  });

  test('SANs with no CN are still usable', () => {
    expect(toPeerCertificate({ subjectaltname: 'DNS:node-c' })).toEqual({
      subjectAlternativeNames: ['node-c'],
    });
  });

  test('a non-string CN is ignored rather than coerced', () => {
    // The certificate comes off the wire by way of the TLS stack; a shape
    // that is not what we expect should narrow the match, never widen it.
    expect(toPeerCertificate({ subject: { CN: ['a', 'b'] }, subjectaltname: 'DNS:node-d' }))
      .toEqual({ subjectAlternativeNames: ['node-d'] });
  });
});
