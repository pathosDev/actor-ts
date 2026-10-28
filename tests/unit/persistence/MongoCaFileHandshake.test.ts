import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isIP, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createSecureContext, createServer, type ConnectionOptions, type TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { MongoJournal } from '../../../src/persistence/index.js';
import { buildMongoResource, resetMongoModuleCache } from '../../../src/persistence/journals/MongoClient.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * A MongoDB store's `ca-file`, held against a real TLS handshake (#1490).
 *
 * `ClientDriverLeaves.test.ts` pins what the store hands the driver — `tls`
 * on and the file's PEM as `ca` — and what it refuses beside it.  This file
 * shows that those options decide the handshake: a server whose certificate
 * the CA did not sign is refused, one it signed is reached, and the two
 * settings refused beside `ca-file` are exactly the ones that would let the
 * stranger through.
 *
 * The mongodb driver is not installed in this repository — its own coverage
 * against a live server is the broker suite under `tests/integration/brokers/`
 * — so a stand-in plays its part: it copies from its options the keys the
 * driver copies into `tls.connect` and opens the socket, which is all of the
 * driver a handshake involves.  The certificates are minted for each run by
 * openssl, so no private key is kept anywhere; a machine without openssl
 * skips the suite rather than failing it.
 */

/** The machine can mint the certificates below. */
const opensslAvailable = spawnSync('openssl', ['version']).status === 0;
const describeWithOpenssl = opensslAvailable ? describe : describe.skip;

/**
 * The keys the mongodb driver copies from a client's options into
 * `tls.connect` (cmap/connect.js in 6.x and 7.x).  Everything else it reads
 * for itself; `tls: true` is what makes it open a TLS socket at all.
 */
const TLS_SOCKET_OPTIONS = [
  'ALPNProtocols', 'ca', 'cert', 'checkServerIdentity', 'ciphers', 'crl', 'ecdhCurve', 'key',
  'minDHSize', 'passphrase', 'pfx', 'rejectUnauthorized', 'secureContext', 'secureProtocol', 'servername', 'session',
] as const;

/** The driver's `MongoClient`, as far as a TLS handshake reaches into it. */
class HandshakingMongoClient {
  constructor(private readonly url: string, private readonly options: Record<string, unknown> = {}) {}

  async connect(): Promise<this> {
    if (this.options['tls'] !== true) throw new Error('this stand-in only speaks TLS');
    const { hostname, port } = new URL(this.url);
    const tlsOptions: Record<string, unknown> = { host: hostname, port: Number(port) };
    // As the driver does: a host name, never an address, is sent as the SNI name.
    if (isIP(hostname) === 0) tlsOptions['servername'] = hostname;
    for (const key of TLS_SOCKET_OPTIONS) {
      if (this.options[key] !== undefined) tlsOptions[key] = this.options[key];
    }
    await new Promise<void>((resolve, reject) => {
      const socket = connect(tlsOptions as ConnectionOptions, () => {
        socket.end();
        resolve();
      });
      socket.once('error', reject);
    });
    return this;
  }

  db(): unknown {
    return {
      collection: () => ({ createIndex: async (): Promise<string> => 'index' }),
      command: async (): Promise<Record<string, unknown>> => ({ ok: 1 }),
    };
  }

  async close(): Promise<void> {}
}

/**
 * What a specifier resolved to before the stand-in replaced it — a plain copy,
 * because a module mock rewrites the namespace in place.  `undefined` when the
 * driver is not installed, which is the state of this repository.
 */
async function snapshotOf(specifier: string): Promise<Record<string, unknown> | undefined> {
  try {
    return { ...((await import(specifier)) as Record<string, unknown>) };
  } catch {
    return undefined;
  }
}

const realMongo = await snapshotOf('mongodb');
mock.module('mongodb', () => ({ MongoClient: HandshakingMongoClient }));
resetMongoModuleCache();

afterAll(() => {
  // A module mock is process-wide and outlives `mock.restore()`, so it is put
  // back by hand — to a module whose entry point is gone when the driver was
  // never installed, the nearest state a mock can express.
  mock.module('mongodb', () => realMongo ?? { MongoClient: undefined });
  resetMongoModuleCache();
});

/* ------------------------------ certificates ------------------------------- */

const scratch = mkdtempSync(join(tmpdir(), 'mongo-ca-file-handshake-'));
afterAll(() => {
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

/** A certificate and the key it was issued for, as a TLS server takes them. */
type ServerIdentity = { readonly cert: string; readonly key: string };

let caPath = '';
let signedByCa: ServerIdentity;
let stranger: ServerIdentity;

function openssl(...args: string[]): void {
  const result = spawnSync('openssl', args, { cwd: scratch, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`openssl ${args[0]} failed (${String(result.status)}): ${result.stderr}`);
}

function identity(name: string): ServerIdentity {
  return {
    cert: readFileSync(join(scratch, `${name}.pem`), 'utf8'),
    key: readFileSync(join(scratch, `${name}-key.pem`), 'utf8'),
  };
}

/**
 * A CA, a server certificate it signs, and an unrelated self-signed one for
 * the same names.  Two-tier, as `tests/fixtures/tls/README.md` explains: a
 * leaf is not accepted as its own trust anchor everywhere.
 */
function mintCertificates(): void {
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  openssl('req', '-x509', ...ec, '-keyout', 'ca-key.pem', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=actor-ts handshake test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  openssl('req', ...ec, '-keyout', 'signed-key.pem', '-out', 'signed.csr', '-subj', '/CN=localhost');
  writeFileSync(join(scratch, 'leaf.ext'), [
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    'basicConstraints=CA:FALSE',
    'keyUsage=critical,digitalSignature',
    'extendedKeyUsage=serverAuth',
    '',
  ].join('\n'));
  openssl('x509', '-req', '-in', 'signed.csr', '-CA', 'ca.pem', '-CAkey', 'ca-key.pem', '-CAcreateserial',
    '-out', 'signed.pem', '-days', '2', '-extfile', 'leaf.ext');
  openssl('req', '-x509', ...ec, '-keyout', 'stranger-key.pem', '-out', 'stranger.pem', '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1');
  caPath = join(scratch, 'ca.pem');
  signedByCa = identity('signed');
  stranger = identity('stranger');
}

/* --------------------------------- server ---------------------------------- */

/** A TLS server presenting `identity`, counting the handshakes it completed. */
type HandshakeServer = {
  readonly url: string;
  handshakes(): number;
  close(): Promise<void>;
};

async function serverPresenting(identity: ServerIdentity): Promise<HandshakeServer> {
  const sockets = new Set<TLSSocket>();
  let handshakes = 0;
  const server = createServer({ cert: identity.cert, key: identity.key }, (socket) => {
    handshakes++;
    sockets.add(socket);
    socket.on('error', () => { /* the client hangs up as soon as it has its answer */ });
    socket.end();
  });
  server.on('tlsClientError', () => { /* a refused handshake, which is counted by not counting it */ });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `mongodb://127.0.0.1:${port}/app`,
    handshakes: () => handshakes,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/* ---------------------------------- tests ---------------------------------- */

describeWithOpenssl('MongoDB: ca-file decides the TLS handshake', () => {
  beforeAll(() => {
    mintCertificates();
  });

  test('a server whose certificate the CA did not sign is refused when the store opens', async () => {
    const server = await serverPresenting(stranger);
    try {
      const journal = new MongoJournal({ url: server.url, caFile: caPath });

      let failure: unknown;
      try {
        await journal.start();
      } catch (error) {
        failure = error;
      }

      expect(failure, 'the store opened against a server the CA did not sign').toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(OptionsError);
      expect(String((failure as Error).message)).toMatch(/certificate/i);
      expect(server.handshakes()).toBe(0);
      await journal.close();
    } finally {
      await server.close();
    }
  });

  test('a server whose certificate the CA signed is reached', async () => {
    const server = await serverPresenting(signedByCa);
    try {
      const journal = new MongoJournal({ url: server.url, caFile: caPath });

      await journal.start();

      await awaitCondition(() => server.handshakes() === 1, { label: 'the server completed the handshake' });
      await journal.close();
    } finally {
      await server.close();
    }
  });

  test('a rejectUnauthorized of false would let the stranger through, and the store refuses it beside ca-file', async () => {
    const server = await serverPresenting(stranger);
    try {
      const clientOptions = { rejectUnauthorized: false };

      // The open on its own, without the store's validator in front of it.
      await buildMongoResource({ url: server.url, caFile: caPath, clientOptions });
      await awaitCondition(() => server.handshakes() === 1, { label: 'the stranger completed a handshake' });

      expect(() => new MongoJournal({ url: server.url, caFile: caPath, clientOptions })).toThrow(OptionsError);
    } finally {
      await server.close();
    }
  });

  test('a secureContext trusting the stranger would let it through, and the store refuses it beside ca-file', async () => {
    const server = await serverPresenting(stranger);
    try {
      const clientOptions = { secureContext: createSecureContext({ ca: stranger.cert }) };

      await buildMongoResource({ url: server.url, caFile: caPath, clientOptions });
      await awaitCondition(() => server.handshakes() === 1, { label: 'the stranger completed a handshake' });

      expect(() => new MongoJournal({ url: server.url, caFile: caPath, clientOptions })).toThrow(OptionsError);
    } finally {
      await server.close();
    }
  });
});
