/**
 * CockroachDB wire-compatibility runner (#401).
 *
 * Runs the shared SQL persistence contract against CockroachDB using the
 * unmodified Postgres stores — see `lib/pg-wire-runner.ts` for what that
 * certifies.
 */
import { runPgWireSuite } from '../lib/pg-wire-runner.js';

runPgWireSuite({
  description: 'CockroachDB',
  defaultPort: 26257,
}).catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
