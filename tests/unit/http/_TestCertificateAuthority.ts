import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * Certificate authorities and client certificates minted at test time, so a
 * test can show who a client-certificate demand admits without a private key
 * ever being committed.  The server keeps `tests/fixtures/tls/`: these exist
 * for the other side of the handshake, which the fixtures do not cover.
 *
 * `node:crypto` makes the key pairs and signs, but nothing in the platform
 * *builds* a certificate, so this writes the DER itself — the smallest X.509
 * v3 shape that Bun's, Node's and Deno's TLS stacks verify: ECDSA P-256 with
 * SHA-256, a CA marked `CA:TRUE` with `keyCertSign`, a leaf marked `CA:FALSE`
 * with `digitalSignature` and `clientAuth`, and key identifiers linking the two.
 * Valid from 2020 to 2049 — the span a two-digit UTCTime year can carry — so
 * no test reads the clock.
 */

/** A minted certificate: PEM text to hand a TLS option, and what it takes to sign another. */
export type MintedCertificate = {
  readonly commonName: string;
  /** The certificate, PEM. */
  readonly cert: string;
  /** Its private key, PKCS#8 PEM. */
  readonly key: string;
  readonly privateKey: KeyObject;
  readonly keyIdentifier: Uint8Array;
};

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const EXTENSION_BASIC_CONSTRAINTS = '2.5.29.19';
const EXTENSION_KEY_USAGE = '2.5.29.15';
const EXTENSION_EXTENDED_KEY_USAGE = '2.5.29.37';
const EXTENSION_SUBJECT_KEY_IDENTIFIER = '2.5.29.14';
const EXTENSION_AUTHORITY_KEY_IDENTIFIER = '2.5.29.35';
const KEY_PURPOSE_CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';
const ATTRIBUTE_COMMON_NAME = '2.5.4.3';

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function encodedLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/** One DER tag-length-value. */
function element(tag: number, ...content: readonly Uint8Array[]): Uint8Array {
  const body = concat(content);
  return concat([Uint8Array.of(tag), encodedLength(body.length), body]);
}

const sequence = (...content: readonly Uint8Array[]): Uint8Array => element(0x30, ...content);
const booleanTrue = (): Uint8Array => element(0x01, Uint8Array.of(0xff));
const octets = (bytes: Uint8Array): Uint8Array => element(0x04, bytes);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function objectIdentifier(dotted: string): Uint8Array {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const out = [40 * first + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let high = Math.floor(arc / 128); high > 0; high = Math.floor(high / 128)) chunk.unshift(0x80 | (high & 0x7f));
    out.push(...chunk);
  }
  return element(0x06, Uint8Array.from(out));
}

/** A non-negative INTEGER: a leading zero keeps a high first bit from reading as a sign. */
function unsignedInteger(bytes: Uint8Array): Uint8Array {
  return element(0x02, (bytes[0]! & 0x80) !== 0 ? concat([Uint8Array.of(0), bytes]) : bytes);
}

function distinguishedName(commonName: string): Uint8Array {
  return sequence(element(0x31, sequence(objectIdentifier(ATTRIBUTE_COMMON_NAME), element(0x0c, text(commonName)))));
}

function extension(identifier: string, critical: boolean, value: Uint8Array): Uint8Array {
  return sequence(objectIdentifier(identifier), ...(critical ? [booleanTrue()] : []), octets(value));
}

function pem(label: string, der: Uint8Array): string {
  const lines = Buffer.from(der).toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function mint(commonName: string, issuer: MintedCertificate | undefined, extensions: (keyIdentifier: Uint8Array) => Uint8Array[]): MintedCertificate {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const subjectPublicKeyInfo = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
  const keyIdentifier = new Uint8Array(createHash('sha1').update(subjectPublicKeyInfo).digest());
  const signer = issuer ?? { commonName, privateKey, keyIdentifier };
  const serial = new Uint8Array(randomBytes(16));
  // Positive, non-zero and minimally encoded whatever the draw: DER refuses a
  // leading zero byte, and a strict parser refuses the certificate with it.
  serial[0] = (serial[0]! & 0x3f) | 0x40;
  const toBeSigned = sequence(
    element(0xa0, unsignedInteger(Uint8Array.of(2))),
    unsignedInteger(serial),
    sequence(objectIdentifier(ECDSA_WITH_SHA256)),
    distinguishedName(signer.commonName),
    sequence(element(0x17, text('200101000000Z')), element(0x17, text('491231235959Z'))),
    distinguishedName(commonName),
    subjectPublicKeyInfo,
    element(0xa3, sequence(
      ...extensions(keyIdentifier),
      extension(EXTENSION_SUBJECT_KEY_IDENTIFIER, false, octets(keyIdentifier)),
      extension(EXTENSION_AUTHORITY_KEY_IDENTIFIER, false, sequence(element(0x80, signer.keyIdentifier))),
    )),
  );
  // ECDSA signatures come out of node:crypto DER-encoded, which is what X.509 carries.
  const signature = new Uint8Array(sign('sha256', toBeSigned, signer.privateKey));
  const certificate = sequence(toBeSigned, sequence(objectIdentifier(ECDSA_WITH_SHA256)), element(0x03, Uint8Array.of(0), signature));
  return {
    commonName,
    cert: pem('CERTIFICATE', certificate),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    privateKey,
    keyIdentifier,
  };
}

/** A self-signed CA that can sign client certificates. */
export function mintCertificateAuthority(commonName: string): MintedCertificate {
  return mint(commonName, undefined, () => [
    extension(EXTENSION_BASIC_CONSTRAINTS, true, sequence(booleanTrue())),
    // keyCertSign and cRLSign: bits 5 and 6, one unused bit.
    extension(EXTENSION_KEY_USAGE, true, element(0x03, Uint8Array.of(1, 0x06))),
  ]);
}

/** A client certificate signed by `authority`. */
export function mintClientCertificate(authority: MintedCertificate, commonName: string): MintedCertificate {
  return mint(commonName, authority, () => [
    extension(EXTENSION_BASIC_CONSTRAINTS, true, sequence()),
    // digitalSignature: bit 0, seven unused bits.
    extension(EXTENSION_KEY_USAGE, true, element(0x03, Uint8Array.of(7, 0x80))),
    extension(EXTENSION_EXTENDED_KEY_USAGE, false, sequence(objectIdentifier(KEY_PURPOSE_CLIENT_AUTH))),
  ]);
}
