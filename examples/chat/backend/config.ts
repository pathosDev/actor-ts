/**
 * CLI argument parsing for the chat backend.  Mirrors the pattern
 * used by `examples/cluster/counter-node.ts` so users moving between
 * the two examples don't have to re-learn the flags.
 *
 * Flags:
 *   --host <ip>          interface to bind on  (default 127.0.0.1)
 *   --port <n>           cluster TCP port      (default 2551, must
 *                                                differ per process)
 *   --http-port <n>      HTTP listener port    (default 8080,
 *                                                shared across nodes:
 *                                                only the cluster
 *                                                singleton actually
 *                                                binds it; failover
 *                                                re-binds on a new
 *                                                node)
 *   --seeds <a,b,c>      comma-separated seeds (default empty — bootstrap node)
 *   --data-dir <path>    where the SQLite journal lives (default ./examples/chat/data)
 *
 * Seeds are addresses like `localhost:2551`.  Pass the bootstrap
 * node as the only seed for additional nodes — the gossip protocol
 * handles the rest.
 */

import * as path from 'node:path';

export interface ChatNodeConfig {
  readonly host: string;
  readonly port: number;
  readonly httpPort: number;
  readonly seeds: ReadonlyArray<string>;
  readonly dataDir: string;
}

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'examples', 'chat', 'data');

export function parseArgs(argv: ReadonlyArray<string>): ChatNodeConfig {
  let host = '127.0.0.1';
  let port = 2551;
  let httpPort = 8080;
  let seeds: string[] = [];
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

  return { host, port, httpPort, seeds, dataDir };
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
      'Options:',
      '  --host <ip>         bind interface             (default 127.0.0.1)',
      '  --port <n>          cluster TCP port           (default 2551, unique per process)',
      '  --http-port <n>     HTTP listener port         (default 8080, shared cluster-wide)',
      '  --seeds <a,b,c>     comma-separated seeds      (default none)',
      '  --data-dir <path>   SQLite journal directory   (default ./examples/chat/data)',
      '',
      'The HTTP port is bound by exactly ONE node at a time — the',
      'ClusterSingleton holder.  When that node dies a survivor re-',
      'binds the same port automatically.  Open http://localhost:8080/',
      'regardless of which node currently owns the singleton.',
      '',
      'Quick start (3 nodes on localhost):',
      '  bun examples/chat/backend/main.ts --port 2551',
      '  bun examples/chat/backend/main.ts --port 2552 --seeds localhost:2551',
      '  bun examples/chat/backend/main.ts --port 2553 --seeds localhost:2551',
      '',
    ].join('\n'),
  );
}
