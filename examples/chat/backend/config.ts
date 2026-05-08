/**
 * CLI argument parsing for the chat backend.  Just argv → struct;
 * the cluster-discovery logic (port scan + seed list) lives in
 * `backend/discovery/sameHostScan.ts` so it can be reused by other
 * tooling and so this file stays a thin parsing layer.
 *
 * The intended UX for the local 3-node demo is "no flags, just
 * three terminals":
 *
 *   bun examples/chat/backend/main.ts          # node 1
 *   bun examples/chat/backend/main.ts          # node 2
 *   bun examples/chat/backend/main.ts          # node 3
 *
 * `main.ts` instantiates `SameHostScanSeedProvider` (the same-host
 * sibling of the framework's `Config/Dns/Kubernetes` providers)
 * for cluster discovery whenever `--port` / `--seeds` are absent.
 *
 * Power users can still pin everything explicitly:
 *
 *   --host <ip>          interface to bind on
 *   --port <n>           skip auto-detect, bind this exact port
 *   --http-port <n>      HTTP listener port (default 8080)
 *   --seeds <a,b,c>      static seed list (skips the scan)
 *   --data-dir <path>    SQLite journal directory
 */

import * as path from 'node:path';

export interface ChatNodeConfig {
  readonly host: string;
  /** null = caller resolves via the SeedProvider. */
  readonly port: number | null;
  readonly httpPort: number;
  /** null = caller resolves via the SeedProvider. */
  readonly seeds: ReadonlyArray<string> | null;
  readonly dataDir: string;
  /**
   * Optional TLS material — when both paths are present, the HTTP
   * front door binds via Fastify's HTTPS mode and the WebSocket
   * route auto-promotes to `wss:`.  See the chat sample README for
   * cert-generation recipes (`mkcert localhost` for local dev,
   * Let's Encrypt + reverse proxy for production).
   */
  readonly tlsCert: string | null;
  readonly tlsKey: string | null;
}

/** First port in the cluster's auto-discovery range. */
export const BASE_CLUSTER_PORT = 2551;
/** How many sequential ports the auto-scan considers. */
export const MAX_NODE_SLOTS = 16;

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'examples', 'chat', 'data');

export function parseArgs(argv: ReadonlyArray<string>): ChatNodeConfig {
  let host = '127.0.0.1';
  let port: number | null = null;
  let httpPort = 8080;
  let seeds: string[] | null = null;
  let dataDir = DEFAULT_DATA_DIR;
  let tlsCert: string | null = null;
  let tlsKey: string | null = null;

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
      case '--tls-cert':
        tlsCert = expect(argv, ++i, '--tls-cert');
        break;
      case '--tls-key':
        tlsKey = expect(argv, ++i, '--tls-key');
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

  // Both flags or neither — half-set TLS would silently bind plain HTTP
  // and surprise the operator after a `mkcert` step that didn't fully
  // land.  Fail fast with the same exit code as a missing arg value.
  if ((tlsCert !== null) !== (tlsKey !== null)) {
    process.stderr.write(
      'error: --tls-cert and --tls-key must be provided together\n',
    );
    process.exit(2);
  }

  return { host, port, httpPort, seeds, dataDir, tlsCert, tlsKey };
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
      'seeds via SameHostScanSeedProvider — three terminals, no flags:',
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
      '  --tls-cert <path>   PEM cert (enables HTTPS+WSS; pair with --tls-key)',
      '  --tls-key  <path>   PEM private key            (pair with --tls-cert)',
      '',
    ].join('\n'),
  );
}
