/**
 * CLI argument parsing for the voice backend.  Mirrors the chat
 * sample's `config.ts` — only the defaults (HTTP port 8081, no
 * `--data-dir` because voice persists nothing) and the help text
 * change.
 *
 * The intended UX is "no flags, just three terminals":
 *
 *   bun examples/voice/backend/main.ts
 *   bun examples/voice/backend/main.ts
 *   bun examples/voice/backend/main.ts
 *
 * `main.ts` instantiates `SameHostScanSeedProvider` for cluster
 * discovery whenever `--port` / `--seeds` are absent.
 */

export interface VoiceNodeConfig {
  readonly host: string;
  /** null = caller resolves via the SeedProvider. */
  readonly port: number | null;
  readonly httpPort: number;
  /** null = caller resolves via the SeedProvider. */
  readonly seeds: ReadonlyArray<string> | null;
}

/** First port in the cluster's auto-discovery range — distinct from chat's 2551. */
export const BASE_CLUSTER_PORT = 2651;
/** How many sequential ports the auto-scan considers. */
export const MAX_NODE_SLOTS = 16;

export function parseArgs(argv: ReadonlyArray<string>): VoiceNodeConfig {
  let host = '127.0.0.1';
  let port: number | null = null;
  let httpPort = 8081;
  let seeds: string[] | null = null;

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

  return { host, port, httpPort, seeds };
}

function expect(argv: ReadonlyArray<string>, idx: number, flag: string): string {
  const value = argv[idx];
  if (value === undefined) {
    process.stderr.write(`error: ${flag} requires a value\n`);
    process.exit(2);
  }
  return value;
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: bun examples/voice/backend/main.ts [options]',
      '',
      'With no options the node auto-discovers a cluster port and',
      'seeds via SameHostScanSeedProvider — three terminals, no flags:',
      '',
      '  bun examples/voice/backend/main.ts',
      '  bun examples/voice/backend/main.ts',
      '  bun examples/voice/backend/main.ts',
      '',
      'Open http://localhost:8081/ — whichever node currently holds',
      'the http-ingress singleton serves it.  (Chat sample uses 8080.)',
      '',
      'Options:',
      '  --host <ip>         bind interface             (default 127.0.0.1)',
      '  --port <n>          cluster TCP port           (default: auto-detect from 2651)',
      '  --http-port <n>     HTTP listener port         (default 8081, shared)',
      '  --seeds <a,b,c>     comma-separated seeds      (default: auto-detect)',
      '',
    ].join('\n'),
  );
}
