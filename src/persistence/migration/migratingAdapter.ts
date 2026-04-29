import type { EventAdapter, OutboundFrame, SnapshotAdapter, StoredFrame } from './Adapter.js';
import type { MigrationChain } from './MigrationChain.js';

/**
 * Build an {@link EventAdapter} from a {@link MigrationChain} —
 * convenience for the common case where one chain handles both
 * directions (upcast on read, optional downcast on write).
 *
 * `writeVersion` (defaults to the chain's `currentVersion`) is the
 * version actually written to the journal.  Set it lower than
 * `currentVersion` during a rolling deployment so v2 nodes keep
 * emitting v1 events for as long as v1 readers are still in the
 * cluster (#7).  When `writeVersion < currentVersion`, the chain
 * **must** have downcasters covering every step on the path
 * `currentVersion → writeVersion` — otherwise `toJournal` throws.
 *
 *   const chain = MigrationChain.for<DepositedV2>('Deposited', 2)
 *     .add({ fromVersion: 1, toVersion: 2,
 *            upcast: (v: DepositedV1): DepositedV2 => ({ ...v, currency: 'USD' }) })
 *     .addDown({ fromVersion: 2, toVersion: 1,
 *                downcast: (v: DepositedV2): DepositedV1 => {
 *                  const { currency, ...rest } = v; void currency; return rest as DepositedV1;
 *                } });
 *
 *   // Phase 1 of rollout — write v1 still, read both:
 *   const phase1 = migratingAdapter(chain, { writeVersion: 1 });
 *
 *   // Phase 2 once every reader is on the new code — flip:
 *   const phase2 = migratingAdapter(chain);   // writeVersion = currentVersion = 2
 */
export function migratingAdapter<E>(
  chain: MigrationChain<E>,
  opts: { readonly writeVersion?: number } = {},
): EventAdapter<E, unknown> {
  const writeVersion = opts.writeVersion ?? chain.currentVersion;
  if (!Number.isInteger(writeVersion) || writeVersion < 1) {
    throw new Error(`migratingAdapter writeVersion must be a positive integer, got ${writeVersion}`);
  }
  if (writeVersion > chain.currentVersion) {
    throw new Error(
      `migratingAdapter writeVersion ${writeVersion} cannot exceed `
      + `chain.currentVersion ${chain.currentVersion}`,
    );
  }
  return {
    manifest: () => chain.manifest,
    toJournal: (event: E): OutboundFrame<unknown> => chain.toJournalAt(event, writeVersion),
    fromJournal: (stored: StoredFrame): E => chain.upcast(stored),
  };
}

/**
 * Same as {@link migratingAdapter} but returns a {@link SnapshotAdapter}
 * — useful when the same MigrationChain governs both events and the
 * snapshot of derived state.  Snapshots usually don't need a rolling
 * `writeVersion` (snapshots are produced by one writer, the actor),
 * but the helper is symmetric for the user's convenience.
 */
export function migratingSnapshotAdapter<S>(
  chain: MigrationChain<S>,
  opts: { readonly writeVersion?: number } = {},
): SnapshotAdapter<S, unknown> {
  const writeVersion = opts.writeVersion ?? chain.currentVersion;
  if (!Number.isInteger(writeVersion) || writeVersion < 1) {
    throw new Error(`migratingSnapshotAdapter writeVersion must be a positive integer, got ${writeVersion}`);
  }
  if (writeVersion > chain.currentVersion) {
    throw new Error(
      `migratingSnapshotAdapter writeVersion ${writeVersion} cannot exceed `
      + `chain.currentVersion ${chain.currentVersion}`,
    );
  }
  return {
    manifest: () => chain.manifest,
    toJournal: (state: S): OutboundFrame<unknown> => chain.toJournalAt(state, writeVersion),
    fromJournal: (stored: StoredFrame): S => chain.upcast(stored),
  };
}
