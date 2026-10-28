/**
 * The runtime-neutral half of `TcpTransportTlsIpLiteralPeer.test.ts` (#1475):
 * the certificates, and the one dial the test makes on every runtime it asks
 * about.  Nothing here imports `bun:test`, because the test runs this module
 * twice — in its own process under Bun, and bundled into a Node child.
 *
 * **Why the certificates are minted here.**  The committed fixtures under
 * `tests/fixtures/tls/` carry one leaf, and its CA key was deleted after
 * signing, so no second leaf can be issued from it.  The refusal half of the
 * test needs a leaf that differs in exactly one respect — no IP SAN — and the
 * acceptance half needs one that can also authenticate a *client*, because the
 * documented recipe hands the same `cert` / `key` / `ca` to both ends and that
 * is mutual TLS: the committed leaf is `serverAuth` only.  `node:crypto` has
 * no certificate builder on any runtime, so the few DER structures an X.509 v3
 * certificate needs are written out below.  A fresh CA per process, valid for
 * a day, kept nowhere.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { LogContextData } from '../../../src/LogContext.js';
import { LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';
import { getTcpBackend } from '../../../src/runtime/tcp/index.js';

/** A leaf certificate and its private key, both PEM. */
export type LeafCertificate = { readonly cert: string; readonly key: string };

/**
 * One CA and two leaves it signed, identical but for the IP SAN.
 *
 * Both leaves name `DNS:localhost` and carry `serverAuth` and `clientAuth`, so
 * either can stand on either end of a mutual-TLS link; `withIpSan` adds
 * `IP:127.0.0.1`.
 */
export type TlsMaterial = {
  readonly ca: string;
  readonly withIpSan: LeafCertificate;
  readonly withoutIpSan: LeafCertificate;
};

export type DeliveredOutcome = { readonly kind: 'delivered' };
/** The dial was given up: the dialler's WARN, and the `code` of the error it carried. */
export type RefusedOutcome = { readonly kind: 'refused'; readonly code: string | null; readonly message: string };
export type TimedOutOutcome = { readonly kind: 'timed-out' };
/** What became of one dial — the frame arrived, the dial failed, or neither within the deadline. */
export type DialOutcome = DeliveredOutcome | RefusedOutcome | TimedOutOutcome;

/* ------------------------------------------------------------------------ */
/* DER — only the constructs an X.509 v3 certificate needs                   */
/* ------------------------------------------------------------------------ */

const TAG_BOOLEAN = 0x01;
const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_OCTET_STRING = 0x04;
const TAG_OBJECT_IDENTIFIER = 0x06;
const TAG_UTF8_STRING = 0x0c;
const TAG_UTC_TIME = 0x17;
const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;
/** `[0] EXPLICIT` — the certificate's version. */
const TAG_VERSION = 0xa0;
/** `[3] EXPLICIT` — the certificate's extensions. */
const TAG_EXTENSIONS = 0xa3;
/** `GeneralName` choices, implicitly tagged: `dNSName [2]` and `iPAddress [7]`. */
const TAG_DNS_NAME = 0x82;
const TAG_IP_ADDRESS = 0x87;
/** `AuthorityKeyIdentifier.keyIdentifier [0]`, implicitly tagged. */
const TAG_KEY_IDENTIFIER = 0x80;

const OBJECT_IDENTIFIERS = {
  commonName: '2.5.4.3',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAlternativeName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  authorityKeyIdentifier: '2.5.29.35',
  extendedKeyUsage: '2.5.29.37',
  serverAuthentication: '1.3.6.1.5.5.7.3.1',
  clientAuthentication: '1.3.6.1.5.5.7.3.2',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
} as const;

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function lengthOctets(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const octets: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    octets.unshift(remaining % 256);
  }
  return Uint8Array.of(0x80 | octets.length, ...octets);
}

function element(tag: number, ...contents: readonly Uint8Array[]): Uint8Array {
  const body = concatenate(contents);
  return concatenate([Uint8Array.of(tag), lengthOctets(body.length), body]);
}

const sequence = (...contents: readonly Uint8Array[]): Uint8Array => element(TAG_SEQUENCE, ...contents);

function objectIdentifier(dotted: string): Uint8Array {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const octets = [40 * first + second];
  for (const arc of rest) {
    const base128 = [arc % 128];
    for (let remaining = Math.floor(arc / 128); remaining > 0; remaining = Math.floor(remaining / 128)) {
      base128.unshift(0x80 | (remaining % 128));
    }
    octets.push(...base128);
  }
  return element(TAG_OBJECT_IDENTIFIER, Uint8Array.from(octets));
}

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

function utcTime(date: Date): Uint8Array {
  const twoDigits = (value: number): string => String(value).padStart(2, '0');
  return element(TAG_UTC_TIME, ascii(
    twoDigits(date.getUTCFullYear() % 100) + twoDigits(date.getUTCMonth() + 1) + twoDigits(date.getUTCDate())
      + twoDigits(date.getUTCHours()) + twoDigits(date.getUTCMinutes()) + twoDigits(date.getUTCSeconds()) + 'Z',
  ));
}

const distinguishedName = (commonName: string): Uint8Array => sequence(
  element(TAG_SET, sequence(objectIdentifier(OBJECT_IDENTIFIERS.commonName), element(TAG_UTF8_STRING, ascii(commonName)))),
);

function extension(identifier: string, critical: boolean, value: Uint8Array): Uint8Array {
  const criticality = critical ? [element(TAG_BOOLEAN, Uint8Array.of(0xff))] : [];
  return sequence(objectIdentifier(identifier), ...criticality, element(TAG_OCTET_STRING, value));
}

/** `KeyUsage` as a DER `BIT STRING`: the leading octet counts the unused trailing bits. */
const keyUsage = (unusedBits: number, bits: number): Uint8Array => element(TAG_BIT_STRING, Uint8Array.of(unusedBits, bits));

function keyIdentifier(publicKey: KeyObject): Uint8Array {
  const subjectPublicKeyInfo = publicKey.export({ type: 'spki', format: 'der' });
  return new Uint8Array(createHash('sha1').update(subjectPublicKeyInfo).digest());
}

type CertificateRequest = {
  readonly subject: string;
  readonly issuer: string;
  readonly publicKey: KeyObject;
  readonly signingKey: KeyObject;
  readonly extensions: readonly Uint8Array[];
};

function certificate(request: CertificateRequest): string {
  const serialNumber = randomBytes(8);
  // Positive and minimal: a clear top bit, and a non-zero first octet.
  serialNumber[0] = ((serialNumber[0] ?? 0) & 0x7f) | 0x01;
  const now = Date.now();
  const signatureAlgorithm = sequence(objectIdentifier(OBJECT_IDENTIFIERS.ecdsaWithSha256));
  const toBeSigned = sequence(
    element(TAG_VERSION, element(TAG_INTEGER, Uint8Array.of(2))),
    element(TAG_INTEGER, new Uint8Array(serialNumber)),
    signatureAlgorithm,
    distinguishedName(request.issuer),
    sequence(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    distinguishedName(request.subject),
    new Uint8Array(request.publicKey.export({ type: 'spki', format: 'der' })),
    element(TAG_EXTENSIONS, sequence(...request.extensions)),
  );
  // ECDSA signatures come out of `sign` DER-encoded, which is the form X.509 carries.
  const signature = new Uint8Array(sign('sha256', toBeSigned, request.signingKey));
  const der = sequence(toBeSigned, signatureAlgorithm, element(TAG_BIT_STRING, Uint8Array.of(0), signature));
  const lines = Buffer.from(der).toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** Mint a throwaway CA and the two leaves {@link TlsMaterial} describes. */
export function mintTlsMaterial(): TlsMaterial {
  const authority = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const authorityName = 'actor-ts IP-literal test CA';
  const ca = certificate({
    subject: authorityName,
    issuer: authorityName,
    publicKey: authority.publicKey,
    signingKey: authority.privateKey,
    extensions: [
      extension(OBJECT_IDENTIFIERS.basicConstraints, true, sequence(element(TAG_BOOLEAN, Uint8Array.of(0xff)))),
      // keyCertSign and cRLSign: bits 5 and 6, one unused bit after them.
      extension(OBJECT_IDENTIFIERS.keyUsage, true, keyUsage(1, 0x06)),
      extension(OBJECT_IDENTIFIERS.subjectKeyIdentifier, false, element(TAG_OCTET_STRING, keyIdentifier(authority.publicKey))),
    ],
  });
  const leaf = (subjectAlternativeNames: readonly Uint8Array[]): LeafCertificate => {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const cert = certificate({
      subject: 'localhost',
      issuer: authorityName,
      publicKey: keys.publicKey,
      signingKey: authority.privateKey,
      extensions: [
        extension(OBJECT_IDENTIFIERS.basicConstraints, false, sequence()),
        // digitalSignature: bit 0, seven unused bits after it.
        extension(OBJECT_IDENTIFIERS.keyUsage, true, keyUsage(7, 0x80)),
        extension(OBJECT_IDENTIFIERS.extendedKeyUsage, false, sequence(
          objectIdentifier(OBJECT_IDENTIFIERS.serverAuthentication),
          objectIdentifier(OBJECT_IDENTIFIERS.clientAuthentication),
        )),
        extension(OBJECT_IDENTIFIERS.subjectAlternativeName, false, sequence(...subjectAlternativeNames)),
        extension(OBJECT_IDENTIFIERS.authorityKeyIdentifier, false, sequence(
          element(TAG_KEY_IDENTIFIER, keyIdentifier(authority.publicKey)),
        )),
      ],
    });
    return { cert, key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  };
  const localhost = element(TAG_DNS_NAME, ascii('localhost'));
  const loopback = element(TAG_IP_ADDRESS, Uint8Array.of(127, 0, 0, 1));
  return {
    ca,
    withIpSan: leaf([localhost, loopback]),
    withoutIpSan: leaf([localhost]),
  };
}

/* ------------------------------------------------------------------------ */
/* The dial                                                                  */
/* ------------------------------------------------------------------------ */

const SYSTEM = 'tls-ip-literal';

/** Hands the first WARN — and the `code` of the error riding on it — to `onWarning`. */
class FirstWarningLogger implements Logger {
  readonly level = LogLevel.Warn;
  constructor(private readonly onWarning: (outcome: RefusedOutcome) => void) {}
  debug(_message: string, ..._args: unknown[]): void {}
  info(_message: string, ..._args: unknown[]): void {}
  warn(message: string, ...args: unknown[]): void {
    const cause = args.find((argument): argument is Error => argument instanceof Error);
    const code = (cause as { code?: unknown } | undefined)?.code;
    this.onWarning({
      kind: 'refused',
      code: typeof code === 'string' ? code : null,
      message: cause === undefined ? message : `${message} | ${cause.message}`,
    });
  }
  error(_message: string, ..._args: unknown[]): void {}
  withSource(_source: string): Logger { return this; }
  withFields(_fields: LogContextData): Logger { return this; }
}

/**
 * A port the operating system handed out a moment ago — `port: 0`, read back,
 * released — so no fixed number can land in a Windows excluded range.
 */
async function freePort(): Promise<number> {
  const backend = await getTcpBackend();
  const listener = await backend.listen({
    host: '127.0.0.1',
    port: 0,
    handlers: { onOpen: () => {}, onData: () => {}, onClose: () => {}, onError: () => {} },
  });
  const { port } = listener;
  await listener.close();
  return port;
}

/**
 * Dial a `TcpTransport` listening on `127.0.0.1` the way the documented TLS
 * recipe does: the peer addressed by its IP, `cert` / `key` / `ca` on both
 * ends, `rejectUnauthorized` left at its default, and **no `serverName`**.
 * The listener presents `presented`; the dialler always presents
 * `withIpSan`, which the listener checks against the dialler's claimed
 * address the way it checks every peer (#912).
 *
 * Settles on whichever comes first: the frame reaching the listener's
 * handler, the dialler's first WARN — every failed dial reports exactly one —
 * or `deadlineMs`.  Both transports are shut down on every path.
 */
export async function dialIpLiteralPeer(
  material: TlsMaterial,
  presented: LeafCertificate,
  deadlineMs: number,
): Promise<DialOutcome> {
  const port = await freePort();
  const listenerAddress = new NodeAddress(SYSTEM, '127.0.0.1', port);
  // Never bound — a dialler needs no listener — and never the listener's own address.
  const diallerAddress = new NodeAddress(SYSTEM, '127.0.0.1', port === 65_535 ? 1 : port + 1);

  let settle: (outcome: DialOutcome) => void = () => {};
  const outcome = new Promise<DialOutcome>((resolve) => { settle = resolve; });
  const listener = new TcpTransport(listenerAddress, new NoopLogger(), {
    tls: { cert: presented.cert, key: presented.key, ca: material.ca },
  });
  listener.setHandler((_from, message) => {
    if (message.kind === 'heartbeat') settle({ kind: 'delivered' });
  });
  const dialler = new TcpTransport(diallerAddress, new FirstWarningLogger((refused) => settle(refused)), {
    tls: { cert: material.withIpSan.cert, key: material.withIpSan.key, ca: material.ca },
  });
  const deadline = setTimeout(() => settle({ kind: 'timed-out' }), deadlineMs);
  try {
    await listener.start();
    dialler.send(listenerAddress, { kind: 'heartbeat', from: diallerAddress.toJSON(), seq: 1, ts: 1 });
    return await outcome;
  } finally {
    clearTimeout(deadline);
    await dialler.shutdown();
    await listener.shutdown();
  }
}
