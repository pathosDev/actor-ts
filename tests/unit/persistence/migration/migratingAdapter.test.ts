/**
 * Tests for `migratingAdapter` — the bridge between a `MigrationChain`
 * and the `EventAdapter` interface, with rolling-deploy `writeVersion`
 * support (#7).
 */
import { describe, expect, test } from 'bun:test';
import { MigrationChain } from '../../../../src/persistence/migration/MigrationChain.js';
import {
  migratingAdapter,
  migratingSnapshotAdapter,
} from '../../../../src/persistence/migration/migratingAdapter.js';

type DepositedV1 = { kind: 'deposited'; amount: number };
type DepositedV2 = { kind: 'deposited'; amount: number; currency: 'USD' | 'EUR' };

function buildChain(): MigrationChain<DepositedV2> {
  return MigrationChain.for<DepositedV2>('BankAccount.Deposited', 2)
    .add({ fromVersion: 1, toVersion: 2,
           upcast: (v: DepositedV1): DepositedV2 => ({ ...v, currency: 'USD' }) })
    .addDown({ fromVersion: 2, toVersion: 1,
               downcast: (v: DepositedV2): DepositedV1 => {
                 const { currency: _c, ...rest } = v;
                 void _c;
                 return rest as DepositedV1;
               } });
}

describe('migratingAdapter — read path', () => {
  test('upcasts a v1 frame to current v2 shape via the chain', () => {
    const adapter = migratingAdapter(buildChain());
    const out = adapter.fromJournal({
      manifest: 'BankAccount.Deposited', version: 1, payload: { kind: 'deposited', amount: 100 },
    });
    expect(out).toEqual({ kind: 'deposited', amount: 100, currency: 'USD' });
  });
});

describe('migratingAdapter — write path', () => {
  test('default writeVersion = currentVersion emits the current shape', () => {
    const adapter = migratingAdapter(buildChain());
    const out = adapter.toJournal({ kind: 'deposited', amount: 50, currency: 'EUR' });
    expect(out).toEqual({
      manifest: 'BankAccount.Deposited',
      version: 2,
      payload: { kind: 'deposited', amount: 50, currency: 'EUR' },
    });
  });

  test('writeVersion < currentVersion downcasts via the chain\'s downcasters', () => {
    const adapter = migratingAdapter(buildChain(), { writeVersion: 1 });
    const out = adapter.toJournal({ kind: 'deposited', amount: 50, currency: 'EUR' });
    expect(out).toEqual({
      manifest: 'BankAccount.Deposited',
      version: 1,
      payload: { kind: 'deposited', amount: 50 },
    });
  });

  test('rolling-deploy round-trip: phase-1 writer + phase-2 reader on the same chain', () => {
    const chain = buildChain();
    const phase1Writer = migratingAdapter(chain, { writeVersion: 1 });
    const phase2Reader = migratingAdapter(chain);

    const wire = phase1Writer.toJournal({ kind: 'deposited', amount: 5, currency: 'EUR' });
    const rebuilt = phase2Reader.fromJournal(wire);
    // Wire was v1 — currency dropped.  Reader's chain upcasts v1 → v2
    // with the default currency: 'USD'.
    expect(rebuilt).toEqual({ kind: 'deposited', amount: 5, currency: 'USD' });
  });

  test('rejects writeVersion > currentVersion', () => {
    expect(() => migratingAdapter(buildChain(), { writeVersion: 3 })).toThrow(/cannot exceed/);
  });

  test('rejects writeVersion = 0', () => {
    expect(() => migratingAdapter(buildChain(), { writeVersion: 0 })).toThrow(/positive integer/);
  });

  test('throws on toJournal when downcaster is missing for writeVersion path', () => {
    // Chain has upcasters but no downcasters at all.
    const chain = MigrationChain.for<DepositedV2>('Deposited', 2)
      .add({ fromVersion: 1, toVersion: 2,
             upcast: (v: DepositedV1): DepositedV2 => ({ ...v, currency: 'USD' }) });
    const adapter = migratingAdapter(chain, { writeVersion: 1 });
    expect(() => adapter.toJournal({ kind: 'deposited', amount: 1, currency: 'USD' }))
      .toThrow(/no downcaster/);
  });
});

describe('migratingSnapshotAdapter — symmetric snapshot variant', () => {
  test('round-trip works for snapshot adapters too', () => {
    const chain = buildChain();
    const writer = migratingSnapshotAdapter(chain, { writeVersion: 1 });
    const reader = migratingSnapshotAdapter(chain);
    const out = reader.fromJournal(writer.toJournal({ kind: 'deposited', amount: 7, currency: 'EUR' }));
    expect(out).toEqual({ kind: 'deposited', amount: 7, currency: 'USD' });
  });
});
