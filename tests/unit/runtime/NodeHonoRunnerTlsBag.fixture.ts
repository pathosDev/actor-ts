/**
 * Bundled by `NodeHonoRunnerTlsBag.test.ts` and run under Node and Bun: what a
 * client meets on the TLS listener the Node runner builds when the caller's
 * `serveOptions.serverOptions` carries `node:tls` options beside the typed
 * `tls` (#1486).  Prints one JSON line — each case's answer: the status, or
 * `refused` with the error the client saw.
 *
 * The one argument is the directory holding the test CA and its `localhost`
 * certificate (`tests/fixtures/tls/`): a bundle no longer knows where its
 * source sat.  Every other certificate is minted here and never leaves the
 * process.  Every client verifies against the test CA.
 */
import * as honoNodeServer from '@hono/node-server';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import type { HonoServeOptions } from '../../../src/runtime/http/HonoServerRunner.js';
import { NodeHonoRunner } from '../../../src/runtime/http/NodeHonoRunner.js';
import { mintCertificateAuthority, mintClientCertificate, type MintedCertificate } from '../http/_TestCertificateAuthority.js';

const tlsDirectory = process.argv[2];
if (tlsDirectory === undefined) throw new Error('usage: <bundle> <directory of tests/fixtures/tls>');
const CERT = readFileSync(join(tlsDirectory, 'localhost-cert.pem'), 'utf8');
const KEY = readFileSync(join(tlsDirectory, 'localhost-key.pem'), 'utf8');
const TEST_CA = readFileSync(join(tlsDirectory, 'test-ca.pem'), 'utf8');

/** How long a client waits for an answer before the case reports that none came. */
const ANSWER_WITHIN_MS = 5_000;

type ServerModuleLoader = NonNullable<ConstructorParameters<typeof NodeHonoRunner>[0]>;
/** The real module, handed in through the runner's loader seam so the bundle carries it. */
const loadServerModule: ServerModuleLoader = async () =>
  honoNodeServer as unknown as Awaited<ReturnType<ServerModuleLoader>>;

/* ------------------------------------------------------------------------ */
/* A PKCS#12 file for `pfx`: the smallest shape OpenSSL and BoringSSL read —  */
/* an unencrypted key bag and certificate bag, and an HMAC-SHA256 MAC keyed   */
/* by the PKCS#12 key derivation (RFC 7292, appendix B).                      */
/* ------------------------------------------------------------------------ */

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, ...contents: Uint8Array[]): Uint8Array {
  const body = concatBytes(contents);
  return concatBytes([Uint8Array.of(tag), derLength(body.length), body]);
}

const sequence = (...contents: Uint8Array[]): Uint8Array => der(0x30, ...contents);
const octetString = (bytes: Uint8Array): Uint8Array => der(0x04, bytes);
const explicitZero = (...contents: Uint8Array[]): Uint8Array => der(0xa0, ...contents);
/** A non-negative INTEGER below 128 — every one this file writes. */
const smallInteger = (value: number): Uint8Array => der(0x02, Uint8Array.of(value));

function objectIdentifier(dotted: string): Uint8Array {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes: number[] = [];
  for (const arc of [first * 40 + second, ...rest]) {
    const group = [arc % 128];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) group.unshift((value % 128) | 0x80);
    bytes.push(...group);
  }
  return der(0x06, Uint8Array.from(bytes));
}

const ID_DATA = '1.2.840.113549.1.7.1';
const ID_KEY_BAG = '1.2.840.113549.1.12.10.1.1';
const ID_CERT_BAG = '1.2.840.113549.1.12.10.1.3';
const ID_X509_CERTIFICATE = '1.2.840.113549.1.9.22.1';
const ID_SHA256 = '2.16.840.1.101.3.4.2.1';
const MAC_ITERATIONS = 2;

/** The PKCS#12 MAC key (ID 3) for SHA-256, one output block: its 32 bytes are the whole HMAC key. */
function macKeyOf(passphrase: string, salt: Uint8Array): Uint8Array {
  const blockBytes = 64;
  const password = new Uint8Array((passphrase.length + 1) * 2);
  for (let i = 0; i < passphrase.length; i++) {
    password[2 * i] = passphrase.charCodeAt(i) >> 8;
    password[2 * i + 1] = passphrase.charCodeAt(i) & 0xff;
  }
  const filled = (bytes: Uint8Array): Uint8Array =>
    Uint8Array.from({ length: blockBytes * Math.ceil(bytes.length / blockBytes) }, (_, i) => bytes[i % bytes.length]!);
  let digest = concatBytes([new Uint8Array(blockBytes).fill(3), filled(salt), filled(password)]);
  for (let round = 0; round < MAC_ITERATIONS; round++) digest = createHash('sha256').update(digest).digest();
  return digest;
}

function derOfPem(pem: string): Uint8Array {
  return Buffer.from(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

function pkcs12Of(identity: MintedCertificate, passphrase: string): Uint8Array {
  const contentInfo = (content: Uint8Array): Uint8Array => sequence(objectIdentifier(ID_DATA), explicitZero(octetString(content)));
  const certificateBag = sequence(
    objectIdentifier(ID_CERT_BAG),
    explicitZero(sequence(objectIdentifier(ID_X509_CERTIFICATE), explicitZero(octetString(derOfPem(identity.cert))))),
  );
  const keyBag = sequence(
    objectIdentifier(ID_KEY_BAG),
    explicitZero(identity.privateKey.export({ format: 'der', type: 'pkcs8' })),
  );
  const authenticatedSafe = sequence(contentInfo(sequence(certificateBag)), contentInfo(sequence(keyBag)));
  const salt = randomBytes(8);
  const mac = createHmac('sha256', macKeyOf(passphrase, salt)).update(authenticatedSafe).digest();
  const macData = sequence(
    sequence(sequence(objectIdentifier(ID_SHA256), Uint8Array.of(0x05, 0x00)), octetString(mac)),
    octetString(salt),
    smallInteger(MAC_ITERATIONS),
  );
  return sequence(smallInteger(3), contentInfo(authenticatedSafe), macData);
}

/* ------------------------------------------------------------------------ */
/* The cases.                                                                 */
/* ------------------------------------------------------------------------ */

/** Another identity for `localhost`, issued by an authority the clients do not trust. */
const elsewhere = mintClientCertificate(mintCertificateAuthority('an authority the clients do not trust'), 'localhost');
/** The authority a client-certificate demand verifies against, and a client it issued. */
const clientAuthority = mintCertificateAuthority('the configured client authority');
const client = mintClientCertificate(clientAuthority, 'a client');

const oneWay = { cert: CERT, key: KEY };
const mutual = { cert: CERT, key: KEY, ca: clientAuthority.cert, requestClientCert: true };

type Case = {
  readonly serve: Omit<HonoServeOptions, 'host' | 'port' | 'fetch'>;
  readonly clientIdentity?: { readonly cert: string; readonly key: string };
};

const cases: Record<string, Case> = {
  baseline: { serve: { tls: oneWay } },
  pfx: { serve: { tls: oneWay, serveOptions: { serverOptions: { pfx: pkcs12Of(elsewhere, 'elsewhere'), passphrase: 'elsewhere' } } } },
  SNICallback: {
    serve: {
      tls: oneWay,
      serveOptions: {
        serverOptions: {
          SNICallback: (_name: string, done: (error: Error | null, context: unknown) => void) =>
            done(null, createSecureContext({ cert: elsewhere.cert, key: elsewhere.key })),
        },
      },
    },
  },
  requestCert: { serve: { tls: oneWay, serveOptions: { serverOptions: { requestCert: true } } } },
  rejectUnauthorized: { serve: { tls: mutual, serveOptions: { serverOptions: { rejectUnauthorized: false } } } },
  mutualWithCertificate: { serve: { tls: mutual }, clientIdentity: { cert: client.cert, key: client.key } },
  mutualWithoutCertificate: { serve: { tls: mutual } },
};

/** One HTTPS request verified against the test CA: the status, or `refused` with the error. */
function answerOf(port: number, clientIdentity: Case['clientIdentity']): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const outgoing = request(
      { host: '127.0.0.1', port, servername: 'localhost', path: '/', ca: TEST_CA, agent: false, ...clientIdentity },
      (response) => {
        response.resume();
        response.on('end', () => settle(String(response.statusCode)));
      },
    );
    const timer = setTimeout(() => {
      outgoing.destroy();
      settle('no answer');
    }, ANSWER_WITHIN_MS);
    outgoing.on('error', (error: Error & { code?: string }) => settle(`refused: ${error.code ?? error.message}`));
    outgoing.end();
  });
}

const answers: Record<string, string> = {};
for (const [name, { serve, clientIdentity }] of Object.entries(cases)) {
  let handle;
  try {
    handle = await new NodeHonoRunner(loadServerModule).serve({
      host: '127.0.0.1',
      port: 0,
      fetch: () => new Response('hello'),
      ...serve,
    });
  } catch (error) {
    answers[name] = `serve() threw: ${(error as Error).message}`;
    continue;
  }
  try {
    answers[name] = await answerOf(handle.port, clientIdentity);
  } finally {
    await handle.stop(false);
  }
}
console.log(JSON.stringify(answers));
