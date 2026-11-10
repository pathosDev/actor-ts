/**
 * A TLS dial to a peer addressed by an IP literal, with no `serverName` — the
 * shape both documented TLS recipes use, `10.0.0.5:2552` and nothing else
 * (#1475).
 *
 * `NodeTcpBackend` passed `servername: tls.serverName ?? host`, and `node:tls`
 * refuses an IP literal there: RFC 6066 admits only host names to SNI, so
 * `tls.connect` throws `ERR_INVALID_ARG_VALUE` before a byte is sent.  No dial
 * to an IP-addressed peer ever completed on Node, and Bun inherited the same
 * failure once its dials went through its own `node:tls`.  A dial that has no
 * name to announce now announces none, and `node:tls` then checks the peer's
 * certificate against the address it actually dialled — its IP SAN.
 *
 * Asked three ways, because each catches a different wrong fix: a real dial
 * under Bun, the same dial under Node, and the options the adapter hands
 * `tls.connect`, which is the only place a dial that still *connects* can be
 * seen to have stopped announcing a host name it should have kept.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeSocketModules } from '../../../src/runtime/tcp/NodeTcpBackend.js';
import { NodeTcpBackend } from '../../../src/runtime/tcp/NodeTcpBackend.js';
import type { TcpSocketHandlers } from '../../../src/runtime/tcp/index.js';
import { dialIpLiteralPeer, mintTlsMaterial, type DialOutcome } from './TcpTransportTlsIpLiteralPeer.fixture.js';

const material = mintTlsMaterial();

/**
 * Generous against a dial that settles in milliseconds, and short of bun's
 * 5 000 ms per-test cap, so a dial that never settles fails on its own label.
 */
const DIAL_DEADLINE_MS = 3_000;

/** What a dial that cannot verify the peer's address reports, on Node and on Bun. */
const NAME_MISMATCH = 'ERR_TLS_CERT_ALTNAME_INVALID';

describe('TcpTransport dials an IP-literal TLS peer without a serverName — in this process', () => {
  test('the dial completes when the certificate carries the IP as a SAN', async () => {
    const outcome = await dialIpLiteralPeer(material, material.withIpSan, DIAL_DEADLINE_MS);
    expect(outcome).toEqual({ kind: 'delivered' });
  });

  test('the dial is refused when the certificate does not carry the IP', async () => {
    // Refused for the right reason: the address was checked against the
    // certificate and is not on it.  A refusal with any other code would pass a
    // bare `kind` check against the defect itself, which refuses every dial.
    const outcome = await dialIpLiteralPeer(material, material.withoutIpSan, DIAL_DEADLINE_MS);
    expect(outcome).toMatchObject({ kind: 'refused', code: NAME_MISMATCH });
  });
});

/* ------------------------------------------------------------------------ */
/* The same dial under Node                                                  */
/* ------------------------------------------------------------------------ */

/**
 * The repository's runtime floor (`engines.node`).  An older Node is not a
 * runtime this library supports, so a machine with only that installed has no
 * answer to give here.
 */
const NODE_FLOOR_MAJOR = 24;

/** The installed `node`, when it is one this library supports — a capability probe, not a switch. */
function supportedNode(): string | null {
  const binary = Bun.which('node');
  if (binary === null) return null;
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  const major = Number(/^v(\d+)\./.exec(probe.stdout ?? '')?.[1]);
  return Number.isInteger(major) && major >= NODE_FLOOR_MAJOR ? binary : null;
}

type NodeRun = {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly report: { readonly withIpSan: DialOutcome; readonly withoutIpSan: DialOutcome } | null;
};

const repositoryFixture = join(import.meta.dir, 'TcpTransportTlsIpLiteralPeer.fixture.ts').replace(/\\/g, '/');

/**
 * Bundle the fixture for Node and run it there — both dials, one process.
 *
 * Bundled rather than run from source: Node strips types but resolves the
 * `.js` specifiers `src/` imports literally, and the fixture is the same file
 * the in-process tests above run, so the two runtimes cannot drift into
 * asking different questions.  Built and run at module scope for the reason
 * `TreeShaking.test.ts` gives (#1394): bounded work, but no failure budget to
 * size, and a per-test cap it would otherwise race under load.
 */
async function runUnderNode(node: string): Promise<NodeRun> {
  const directory = mkdtempSync(join(tmpdir(), 'actor-ts-tls-ip-'));
  try {
    // A real file on disk: `Bun.build` resolves entrypoints against the filesystem.
    const entry = join(directory, 'entry.ts');
    const materialFile = join(directory, 'material.json');
    writeFileSync(materialFile, JSON.stringify(material), 'utf8');
    writeFileSync(entry, [
      `import { readFileSync } from 'node:fs';`,
      `import { dialIpLiteralPeer } from '${repositoryFixture}';`,
      `const material = JSON.parse(readFileSync(process.argv[2], 'utf8'));`,
      `const withIpSan = await dialIpLiteralPeer(material, material.withIpSan, ${DIAL_DEADLINE_MS});`,
      `const withoutIpSan = await dialIpLiteralPeer(material, material.withoutIpSan, ${DIAL_DEADLINE_MS});`,
      `console.log('report=' + JSON.stringify({ withIpSan, withoutIpSan }));`,
      '',
    ].join('\n'), 'utf8');
    const built = await Bun.build({ entrypoints: [entry], target: 'node', format: 'esm' });
    if (!built.success) {
      return { status: null, signal: null, stderr: `bundling failed: ${built.logs.map(String).join('\n')}`, report: null };
    }
    const bundle = join(directory, 'entry.mjs');
    writeFileSync(bundle, await built.outputs[0]!.text(), 'utf8');
    // Two dials and two shutdowns: a process start plus milliseconds.  A run
    // that reaches this limit is a hang — a handle the transports left open.
    const child = spawnSync(node, [bundle, materialFile], { encoding: 'utf8', timeout: 30_000 });
    const line = (child.stdout ?? '').split(/\r?\n/).find((candidate) => candidate.startsWith('report='));
    return {
      status: child.status,
      signal: child.signal,
      stderr: child.stderr ?? '',
      report: line === undefined ? null : JSON.parse(line.slice('report='.length)) as NodeRun['report'],
    };
  } finally {
    // An empty path here would empty the working directory on Bun 1.4.2.
    if (directory !== '') rmSync(directory, { recursive: true, force: true });
  }
}

const node = supportedNode();
const nodeRun = node === null ? null : await runUnderNode(node);
const describeUnderNode = nodeRun === null ? describe.skip : describe;

describeUnderNode(`TcpTransport dials an IP-literal TLS peer without a serverName — under Node ≥ ${NODE_FLOOR_MAJOR}`, () => {
  test('the dial completes when the certificate carries the IP as a SAN', () => {
    expect(nodeRun?.report?.withIpSan, `node reported nothing; stderr: ${nodeRun?.stderr}`).toEqual({ kind: 'delivered' });
  });

  test('the dial is refused when the certificate does not carry the IP', () => {
    expect(nodeRun?.report?.withoutIpSan, `node reported nothing; stderr: ${nodeRun?.stderr}`)
      .toMatchObject({ kind: 'refused', code: NAME_MISMATCH });
  });

  test('the process exits on its own once both transports are shut down', () => {
    expect({ status: nodeRun?.status, signal: nodeRun?.signal }, nodeRun?.stderr).toEqual({ status: 0, signal: null });
  });
});

/* ------------------------------------------------------------------------ */
/* What the adapter hands tls.connect                                        */
/* ------------------------------------------------------------------------ */

/** A TLS socket that reports its handshake done the moment it is asked to. */
class HandshakenSocket extends EventEmitter {
  write(): boolean { return true; }
  end(): void {}
  destroy(): void {}
}

const SILENT_HANDLERS: TcpSocketHandlers = { onOpen: () => {}, onData: () => {}, onClose: () => {}, onError: () => {} };

/**
 * The options one `tls.connect` call received, through the adapter's module
 * seam.  `isIP` is the runtime's own: the decision is meant to agree with the
 * check `node:tls` makes, and a stand-in would only test itself.
 */
async function tlsConnectOptions(host: string, serverName?: string): Promise<Record<string, unknown>> {
  const dialled: Record<string, unknown>[] = [];
  const socket = new HandshakenSocket();
  const module = {
    createServer: (): never => { throw new Error('no listener in this test'); },
    connect: (options: Record<string, unknown>): HandshakenSocket => {
      dialled.push(options);
      queueMicrotask(() => socket.emit('secureConnect'));
      return socket;
    },
  };
  const modules: NodeSocketModules = {
    net: async () => ({ ...module, isIP }) as never,
    tls: async () => module as never,
  };
  await new NodeTcpBackend(modules).connect({
    host,
    port: 2_552,
    tls: serverName === undefined ? { ca: material.ca } : { ca: material.ca, serverName },
    handlers: SILENT_HANDLERS,
  });
  expect(dialled).toHaveLength(1);
  return dialled[0]!;
}

describe('NodeTcpBackend announces a server name only when there is one to announce', () => {
  test('an IPv4 literal announces none', async () => {
    expect(await tlsConnectOptions('10.0.0.5')).not.toHaveProperty('servername');
  });

  test('an IPv6 literal announces none either', async () => {
    expect(await tlsConnectOptions('::1')).not.toHaveProperty('servername');
  });

  test('a host name is still announced, so a listener choosing its certificate by SNI keeps working', async () => {
    expect(await tlsConnectOptions('node-a.cluster.internal')).toMatchObject({ servername: 'node-a.cluster.internal' });
  });

  test('a configured serverName is announced as configured, whatever the host', async () => {
    expect(await tlsConnectOptions('10.0.0.5', 'node-a.cluster.internal'))
      .toMatchObject({ servername: 'node-a.cluster.internal' });
  });
});
