/**
 * What a `serveOptions` bag can do to the live listener the Bun runner builds
 * (#1486) — the half `HonoRunnerServeOptionsPrecedence.test.ts` cannot show:
 * a stand-in `Bun.serve` records the keys it is handed and never decides what
 * a socket speaks.
 *
 * `Bun.serve` still reads TLS material from the top level of its options when
 * no `tls` member is set — `cert` and `key`, and the older `certFile` and
 * `keyFile` — so dropping the bag's `tls` alone was not enough: measured on
 * bun 1.4.2, a bag carrying either pair made the listener terminate TLS with no
 * `tls` configured, a plain request reset and an HTTPS one verified against
 * the bag's certificate.  And beside the typed `tls` + `http2`, a bag
 * `http1: false` answered HTTP/1.1 with `505`, where the Node runner keeps
 * HTTP/1.1 on an h2 port whatever its bag says (#1522).
 *
 * Real sockets on `port: 0`.  Every client verifies against the test CA in
 * `tests/fixtures/tls/`, never with `rejectUnauthorized: false`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { fileURLToPath } from 'node:url';
import { BunHonoRunner } from '../../../src/runtime/http/BunHonoRunner.js';
import type { HonoServeOptions, HonoServerHandle } from '../../../src/runtime/http/HonoServerRunner.js';

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const CERT_PATH = fileURLToPath(new URL('localhost-cert.pem', FIXTURES));
const KEY_PATH = fileURLToPath(new URL('localhost-key.pem', FIXTURES));
const CERT = readFileSync(CERT_PATH, 'utf8');
const KEY = readFileSync(KEY_PATH, 'utf8');
const CA = readFileSync(new URL('test-ca.pem', FIXTURES), 'utf8');

/** How long a client waits for an answer before the case reports what it saw. */
const ANSWER_WITHIN_MS = 3_000;

const handles: HonoServerHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop(false);
});

const hello = (): Response => new Response('hello');

/** Serve `hello` through the real `Bun.serve` on an ephemeral port. */
async function serve(options: Omit<HonoServeOptions, 'host' | 'port' | 'fetch'>): Promise<HonoServerHandle> {
  const handle = await new BunHonoRunner().serve({ host: '127.0.0.1', port: 0, fetch: hello, ...options });
  handles.push(handle);
  return handle;
}

/** A plain-HTTP request: the status and body, or the error it failed with. */
async function plainAnswer(handle: HonoServerHandle): Promise<string> {
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/`, { signal: AbortSignal.timeout(ANSWER_WITHIN_MS) });
    return `${response.status} ${await response.text()}`;
  } catch (error) {
    return `error: ${(error as { code?: string }).code ?? (error as Error).message}`;
  }
}

/** An HTTP/1.1 request over TLS, verified against the test CA: the status, or the error it failed with. */
function http1OverTlsAnswer(handle: HonoServerHandle): Promise<string> {
  return new Promise((resolve) => {
    const client = request(
      { host: '127.0.0.1', port: handle.port, servername: 'localhost', path: '/', ca: CA, agent: false, timeout: ANSWER_WITHIN_MS },
      (response) => {
        response.resume();
        response.on('end', () => resolve(String(response.statusCode)));
      },
    );
    client.on('timeout', () => client.destroy(new Error('no answer in time')));
    client.on('error', (error: Error & { code?: string }) => resolve(`error: ${error.code ?? error.message}`));
    client.end();
  });
}

describe('BunHonoRunner — without tls, a serveOptions bag cannot make the listener speak TLS (#1486)', () => {
  test('a bag cert and key leave it plain HTTP', async () => {
    const handle = await serve({ serveOptions: { cert: CERT, key: KEY } });

    expect(await plainAnswer(handle)).toBe('200 hello');
  });

  test('so do the older certFile and keyFile spellings', async () => {
    const handle = await serve({ serveOptions: { certFile: CERT_PATH, keyFile: KEY_PATH } });

    expect(await plainAnswer(handle)).toBe('200 hello');
  });
});

describe('BunHonoRunner — under tls and http2, HTTP/1.1 stays on the port whatever the bag says (#1486)', () => {
  test('a bag http1: false does not take HTTP/1.1 away', async () => {
    const handle = await serve({ tls: { cert: CERT, key: KEY }, http2: true, serveOptions: { http1: false } });

    expect(await http1OverTlsAnswer(handle)).toBe('200');
  });
});
