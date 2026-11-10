import { describe, expect, test } from 'bun:test';
import {
  type JournalOperation,
  type PersistenceExtension,
  PersistenceExtensionId,
  type SnapshotOperation,
} from '../../../src/persistence/index.js';
import { createTestActorSystem } from '../../util/TestActorSystem.js';

/**
 * The operation types the two breaker seams take are reachable from the
 * persistence barrel — the `actor-ts/persistence` door — and are exactly the
 * types those seams take (#1496).
 *
 * `callThroughJournalBreaker` and `callThroughSnapshotBreaker` take the
 * operation as their first argument, so a caller wrapping either has to name
 * that argument's type.  A type-only export is erased at runtime, which leaves
 * `tests/unit/ExportSurface.test.ts` blind to it: what checks it is the import
 * above under `bun run typecheck:dev`, and the two assertions below, which stop
 * compiling if the barrel hands out a different type under either name.
 */

/** `true` exactly when `A` and `B` are the same type. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/** Compiles only for `true`. */
type Assert<Condition extends true> = Condition;

export type JournalOperationIsWhatTheJournalSeamTakes = Assert<
  Equals<JournalOperation, Parameters<PersistenceExtension['callThroughJournalBreaker']>[0]>
>;
export type SnapshotOperationIsWhatTheSnapshotSeamTakes = Assert<
  Equals<SnapshotOperation, Parameters<PersistenceExtension['callThroughSnapshotBreaker']>[0]>
>;

/** A caller's wrapper around the journal seam — the shape the export exists for. */
function throughJournalBreaker<T>(
  extension: PersistenceExtension,
  operation: JournalOperation,
  call: () => Promise<T>,
): Promise<T> {
  return extension.callThroughJournalBreaker(operation, call);
}

/** The same, around the snapshot seam. */
function throughSnapshotBreaker<T>(
  extension: PersistenceExtension,
  operation: SnapshotOperation,
  call: () => Promise<T>,
): Promise<T> {
  return extension.callThroughSnapshotBreaker(operation, call);
}

describe('the breaker operation types on the persistence barrel', () => {
  test('a wrapper typed with them passes every operation through both seams', async () => {
    const system = createTestActorSystem({ name: 'persistence-operation-types' });
    try {
      const extension = system.extension(PersistenceExtensionId);
      const journalOperations: readonly JournalOperation[] = ['append', 'replay', 'delete'];
      const snapshotOperations: readonly SnapshotOperation[] = ['save', 'load', 'delete'];
      for (const operation of journalOperations) {
        expect(await throughJournalBreaker(extension, operation, async () => operation)).toBe(operation);
      }
      for (const operation of snapshotOperations) {
        expect(await throughSnapshotBreaker(extension, operation, async () => operation)).toBe(operation);
      }
    } finally {
      await system.terminate();
    }
  });
});
