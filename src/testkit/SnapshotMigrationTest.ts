import type { MigrationChain } from '../persistence/migration/MigrationChain.js';
import type { SnapshotAdapter, StoredFrame } from '../persistence/migration/Adapter.js';
import { migratingSnapshotAdapter } from '../persistence/migration/migratingAdapter.js';

/**
 * Test harness for schema-evolution scenarios (#286).  Given:
 *
 *   - an "old" snapshot in some legacy shape (the wire form a real
 *     journal might have persisted before the migration);
 *   - a {@link MigrationChain} that upcasts old → new;
 *   - an expected post-migration state;
 *
 * verifies that the {@link migratingSnapshotAdapter} maps the legacy
 * shape onto the expected state.  Wraps the otherwise-manual
 * three-line dance of building the adapter, calling `fromJournal`,
 * and deep-equaling the result.
 *
 * The point is to give a test author a one-liner that names the
 * scenario without re-typing the adapter plumbing per test:
 *
 *   const tester = SnapshotMigrationTest.using(chain);
 *
 *   test('v1 snapshot upcasts to v2 with currency=USD default', () => {
 *     tester.expectUpcast({
 *       storedVersion: 1,
 *       payload: { kind: 'deposited', amount: 100 },
 *       expected: { kind: 'deposited', amount: 100, currency: 'USD' },
 *     });
 *   });
 *
 *   test('round-trip via writeVersion=1 strips fields', () => {
 *     tester.expectRoundTrip({
 *       state: { kind: 'deposited', amount: 50, currency: 'EUR' },
 *       writeVersion: 1,
 *       expectedAfterRoundTrip: { kind: 'deposited', amount: 50, currency: 'USD' },
 *     });
 *   });
 *
 * No assertion library coupling — the harness uses `JSON.stringify`
 * for the value comparison and throws an error with the diff on
 * mismatch.  That keeps the harness usable across Bun, Vitest, Jest
 * without depending on any of them.
 */

export interface ExpectUpcastSpec<E> {
  readonly storedVersion: number;
  readonly payload: unknown;
  /** Optional manifest override; defaults to the chain's manifest. */
  readonly storedManifest?: string;
  readonly expected: E;
}

export interface ExpectRoundTripSpec<E> {
  readonly state: E;
  /** Version to write at — `chain.currentVersion` for "no rolling deploy". */
  readonly writeVersion?: number;
  /** Expected state after writer→reader round-trip.  Often equals `state`. */
  readonly expectedAfterRoundTrip: E;
}

export class SnapshotMigrationTest<E> {
  private readonly defaultAdapter: SnapshotAdapter<E, unknown>;
  constructor(private readonly chain: MigrationChain<E>) {
    this.defaultAdapter = migratingSnapshotAdapter(chain);
  }

  /** Factory entry point — `SnapshotMigrationTest.using(chain)`. */
  static using<E>(chain: MigrationChain<E>): SnapshotMigrationTest<E> {
    return new SnapshotMigrationTest(chain);
  }

  /**
   * Assert that decoding a stored snapshot (at the named version)
   * produces the expected current-shape state.  Throws with a JSON
   * diff if the upcast result doesn't match.
   */
  expectUpcast(spec: ExpectUpcastSpec<E>): void {
    const stored: StoredFrame = {
      manifest: spec.storedManifest ?? this.chain.manifest,
      version: spec.storedVersion,
      payload: spec.payload,
    };
    const upcast = this.defaultAdapter.fromJournal(stored);
    assertDeepEqual(
      upcast, spec.expected,
      `SnapshotMigrationTest.expectUpcast: v${spec.storedVersion} → currentVersion=${this.chain.currentVersion}`,
    );
  }

  /**
   * Assert that a state written at `writeVersion` and re-read through
   * the default reader produces the expected state.  Equivalent to a
   * rolling-deploy round-trip: writer at older version, reader at
   * current version.
   */
  expectRoundTrip(spec: ExpectRoundTripSpec<E>): void {
    const writer = spec.writeVersion === undefined
      ? this.defaultAdapter
      : migratingSnapshotAdapter(this.chain, { writeVersion: spec.writeVersion });
    const wire = writer.toJournal(spec.state);
    const rebuilt = this.defaultAdapter.fromJournal(wire);
    assertDeepEqual(
      rebuilt, spec.expectedAfterRoundTrip,
      `SnapshotMigrationTest.expectRoundTrip: writeVersion=${spec.writeVersion ?? this.chain.currentVersion} → read`,
    );
  }

  /**
   * Assert that decoding the given stored frame throws.  Useful for
   * negative-path tests (manifest mismatch, version-too-high).
   * The thrown error's message must include `messageContains` if
   * provided.
   */
  expectUpcastError(
    spec: { storedVersion: number; payload: unknown; storedManifest?: string },
    messageContains?: string,
  ): void {
    const stored: StoredFrame = {
      manifest: spec.storedManifest ?? this.chain.manifest,
      version: spec.storedVersion,
      payload: spec.payload,
    };
    let thrown: Error | null = null;
    try { this.defaultAdapter.fromJournal(stored); }
    catch (e) { thrown = e as Error; }
    if (!thrown) {
      throw new Error(
        `SnapshotMigrationTest.expectUpcastError: expected upcast to throw for v${spec.storedVersion} ` +
        `but it succeeded.  Stored manifest=${stored.manifest}.`,
      );
    }
    if (messageContains && !thrown.message.includes(messageContains)) {
      throw new Error(
        `SnapshotMigrationTest.expectUpcastError: expected error message to contain '${messageContains}' ` +
        `but got '${thrown.message}'`,
      );
    }
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: mismatch\n  actual:   ${actualJson}\n  expected: ${expectedJson}`);
  }
}
