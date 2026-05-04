/**
 * CLI argument parsing + auto-discovery for the chat backend.
 *
 * The intended UX for the local 3-node demo is "no flags, just
 * three terminals":
 *
 *   bun examples/chat/backend/main.ts          # node 1 (bootstrap)
 *   bun examples/chat/backend/main.ts          # node 2 — auto-detects seed
 *   bun examples/chat/backend/main.ts          # node 3 — auto-detects two seeds
 *
 * Auto-discovery walks the cluster-port range starting at 2551 and
 * tests each port: occupied → already-running peer (treat as
 * seed); free → claim it as our own.  First free port is the
 * cluster port, every occupied port below it goes into the seed
 * list.  Works on a single host where every node is reachable on
 * `127.0.0.1` — exactly the local-demo case.
 *
 * Power users can still override:
 *
 *   --host <ip>          interface to bind on        (default 127.0.0.1)
 *   --port <n>           cluster TCP port            (default: auto-detect from BASE)
 *   --http-port <n>      HTTP listener port          (default 8080;
 *                                                     only the cluster
 *                                                     singleton actually
 *                                                     binds it)
 *   --seeds <a,b,c>      comma-separated seeds       (default: auto-detect)
 *   --data-dir <path>    SQLite journal directory    (default ./examples/chat/data)
 *
 * Cross-machine deployments need explicit `--port` + `--seeds`
 * because the auto-detect only sees same-host listeners.
 */

import { createServer, type AddressInfo } from 'node:net';
import * as path from 'node:path';

export interface ChatNodeConfig {
  readonly host: string;
  readonly port: number;
  readonly httpPort: number;
  readonly seeds: ReadonlyArray<string>;
  readonly dataDir: string;
}

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'examples', 'chat', 'data');
const BASE_CLUSTER_PORT = 2551;
/** Soft cap on auto-discovered cluster nodes per host. */
const MAX_NODE_SLOTS = 16;

export async function parseArgs(argv: ReadonlyArray<string>): Promise<ChatNodeConfig> {
  let host = '127.0.0.1';
  let port: number | null = null; // null = auto-detect
  let httpPort = 8080;
  let seeds: string[] | null = null; // null = auto-detect
  let dataDir = DEFAULT_DATA_DIR;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--host':
        host = expect(argv, ++i, '--host');
        break;
      case '--port':
        port = parseInt(expect(argv, ++i, '--port'), 10);
        break;
      case '--http-port':
        httpPort = parseInt(expect(argv, ++i, '--http-port'), 10);
        break;
      case '--seeds':
        seeds = expect(argv, ++i, '--seeds')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--data-dir':
        dataDir = expect(argv, ++i, '--data-dir');
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        // Ignore unknown args for forward-compat with `bun run` extras.
        break;
    }
  }

  // Resolve auto-detected fields.
  if (port === null) {
    const detected = await discover(host, BASE_CLUSTER_PORT);
    port = detected.port;
    if (seeds === null) seeds = detected.seeds;
  } else if (seeds === null) {
    // User pinned the port but didn't specify seeds — assume
    // bootstrap mode (this node is the first or the user is
    // taking over a known-vacant slot).  Empty seeds is fine.
    seeds = [];
  }

  return { host, port, httpPort, seeds, dataDir };
}

/* ------------------------------ helpers ------------------------------ */

/**
 * Walk the cluster-port range starting at `basePort` and return:
 *   - the first free port we find (= our cluster port)
 *   - every occupied port below it (= our seeds)
 *
 * Works only for same-host peers — sufficient for the local demo.
 */
async function discover(host: string, basePort: number): Promise<{ port: number; seeds: string[] }> {
  const seeds: string[] = [];
  for (let i = 0; i < MAX_NODE_SLOTS; i++) {
    const candidate = basePort + i;
    if (await isPortFree(host, candidate)) {
      return { port: candidate, seeds };
    }
    seeds.push(`${host}:${candidate}`);
  }
  process.stderr.write(
    `error: all ${MAX_NODE_SLOTS} cluster-port slots starting at ${basePort} are in use; ` +
      `pass --port / --seeds explicitly\n`,
  );
  process.exit(3);
}

/**
 * Check whether we can bind a fresh listener on `host:port`.
 * `EADDRINUSE` → occupied; anything that lets us listen → free
 * (we close immediately).
 */
function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      // EADDRINUSE is the canonical "occupied" signal; treat any
      // other error as occupied too — we'd rather skip a port we
      // can't actually use than try to bind it for real and crash.
      void err;
      resolve(false);
    });
    probe.once('listening', () => {
      const actual = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(actual === port));
    });
    probe.listen(port, host);
  });
}

function expect(argv: ReadonlyArray<string>, idx: number, flag: string): string {
  const v = argv[idx];
  if (v === undefined) {
    process.stderr.write(`error: ${flag} requires a value\n`);
    process.exit(2);
  }
  return v;
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: bun examples/chat/backend/main.ts [options]',
      '',
      'With no options the node auto-discovers a cluster port and',
      'seeds by walking the range starting at 2551.  Three terminals,',
      'no flags, no port juggling:',
      '',
      '  bun examples/chat/backend/main.ts',
      '  bun examples/chat/backend/main.ts',
      '  bun examples/chat/backend/main.ts',
      '',
      'Open http://localhost:8080/ — whichever node currently holds',
      'the http-ingress singleton serves it.',
      '',
      'Options (override the defaults — useful for cross-machine',
      'deployments where same-host port-scan does not apply):',
      '  --host <ip>         bind interface             (default 127.0.0.1)',
      '  --port <n>          cluster TCP port           (default: auto-detect from 2551)',
      '  --http-port <n>     HTTP listener port         (default 8080, shared)',
      '  --seeds <a,b,c>     comma-separated seeds      (default: auto-detect)',
      '  --data-dir <path>   SQLite journal directory   (default ./examples/chat/data)',
      '',
    ].join('\n'),
  );
}
