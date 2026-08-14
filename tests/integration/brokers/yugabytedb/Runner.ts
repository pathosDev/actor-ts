/**
 * YugabyteDB wire-compatibility runner (#401).
 *
 * Runs the shared SQL persistence contract against YugabyteDB's YSQL layer
 * using the unmodified Postgres stores — see `lib/PgWireRunner.ts` for what
 * that certifies, and why Yugabyte's reworded error messages are harmless.
 *
 * The readiness deadline is generous because Yugabyte initializes its system
 * catalogs on first boot and takes noticeably longer than any other image in
 * the matrix.
 */
import { runPgWireSuite } from '../lib/PgWireRunner.js';

runPgWireSuite({
  description: 'YugabyteDB (YSQL)',
  defaultPort: 5433,
  readinessDeadlineMs: 180_000,
}).catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
