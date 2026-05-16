/**
 * Demonstration tests for the {@link SnapshotMigrationTest} harness
 * (#286).  The migratingSnapshotAdapter tests already exist in their
 * own file; this file shows the harness shrinks each schema-evolution
 * case to a one-liner.
 */
import { describe, test } from 'bun:test';
import { MigrationChain } from '../../../../../src/persistence/migration/MigrationChain.js';
import { SnapshotMigrationTest } from '../../../../../src/testkit/SnapshotMigrationTest.js';

type DepositedV1 = { kind: 'deposited'; amount: number };
type DepositedV2 = { kind: 'deposited'; amount: number; currency: 'USD' | 'EUR' };
type DepositedV3 = DepositedV2 & { channel: 'web' | 'mobile' };

function buildChain(): MigrationChain<DepositedV3> {
  return MigrationChain.for<DepositedV3>('BankAccount.Deposited', 3)
    .add({
      fromVersion: 1, toVersion: 2,
      upcast: (v: DepositedV1): DepositedV2 => ({ ...v, currency: 'USD' }),
    })
    .add({
      fromVersion: 2, toVersion: 3,
      upcast: (v: DepositedV2): DepositedV3 => ({ ...v, channel: 'web' }),
    })
    .addDown({
      fromVersion: 3, toVersion: 2,
      downcast: (v: DepositedV3): DepositedV2 => {
        const { channel: _c, ...rest } = v;
        void _c;
        return rest as DepositedV2;
      },
    })
    .addDown({
      fromVersion: 2, toVersion: 1,
      downcast: (v: DepositedV2): DepositedV1 => {
        const { currency: _c, ...rest } = v;
        void _c;
        return rest as DepositedV1;
      },
    });
}

describe('SnapshotMigrationTest harness — upcast scenarios', () => {
  const tester = SnapshotMigrationTest.using(buildChain());

  test('v1 stored → v3 with both defaults filled', () => {
    tester.expectUpcast({
      storedVersion: 1,
      payload: { kind: 'deposited', amount: 100 },
      expected: { kind: 'deposited', amount: 100, currency: 'USD', channel: 'web' },
    });
  });

  test('v2 stored → v3 fills only the channel default', () => {
    tester.expectUpcast({
      storedVersion: 2,
      payload: { kind: 'deposited', amount: 25, currency: 'EUR' },
      expected: { kind: 'deposited', amount: 25, currency: 'EUR', channel: 'web' },
    });
  });

  test('v3 stored → returns as-is (no migration needed)', () => {
    tester.expectUpcast({
      storedVersion: 3,
      payload: { kind: 'deposited', amount: 1, currency: 'USD', channel: 'mobile' },
      expected: { kind: 'deposited', amount: 1, currency: 'USD', channel: 'mobile' },
    });
  });
});

describe('SnapshotMigrationTest harness — round-trip scenarios', () => {
  const tester = SnapshotMigrationTest.using(buildChain());

  test('writeVersion=1 (rollout phase 1): write v1 → read v3 with defaults', () => {
    tester.expectRoundTrip({
      state: { kind: 'deposited', amount: 5, currency: 'EUR', channel: 'mobile' },
      writeVersion: 1,
      // Wire was v1 → currency + channel both dropped.  Reader fills
      // both defaults: currency='USD', channel='web'.
      expectedAfterRoundTrip: { kind: 'deposited', amount: 5, currency: 'USD', channel: 'web' },
    });
  });

  test('writeVersion=currentVersion (steady state): write+read identical', () => {
    const state: DepositedV3 = { kind: 'deposited', amount: 10, currency: 'EUR', channel: 'mobile' };
    tester.expectRoundTrip({
      state,
      // default writeVersion = currentVersion = 3
      expectedAfterRoundTrip: state,
    });
  });
});

describe('SnapshotMigrationTest harness — error scenarios', () => {
  const tester = SnapshotMigrationTest.using(buildChain());

  test('upcast of mismatched manifest throws', () => {
    tester.expectUpcastError(
      { storedVersion: 1, payload: {}, storedManifest: 'OtherType' },
      'manifest mismatch',
    );
  });

  test('upcast of version > currentVersion throws', () => {
    tester.expectUpcastError(
      { storedVersion: 99, payload: {} },
      'cannot downgrade',
    );
  });
});
