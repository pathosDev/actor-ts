import { describe, expect, test } from 'bun:test';
import { MigrationChain } from '../../../../../src/persistence/migration/MigrationChain.js';
import { MigrationError } from '../../../../../src/persistence/migration/Envelope.js';

type DepositedV1 = { kind: 'deposited'; amount: number };
type DepositedV2 = { kind: 'deposited'; amount: number; currency: 'USD' | 'EUR' };
type DepositedV3 = { kind: 'deposited'; cents: number; currency: 'USD' | 'EUR' };

describe('MigrationChain — happy path', () => {
  test('single step v1 → v2 (additive)', () => {
    const chain = MigrationChain.for<DepositedV2>('BankAccount.Deposited', 2)
      .add({ fromVersion: 1, toVersion: 2,
             upcast: (version: DepositedV1): DepositedV2 => ({ ...version, currency: 'USD' }) });
    const out = chain.upcast({ manifest: 'BankAccount.Deposited', version: 1, payload: { kind: 'deposited', amount: 100 } });
    expect(out).toEqual({ kind: 'deposited', amount: 100, currency: 'USD' });
  });

  test('two-step v1 → v2 → v3 (additive then rename)', () => {
    const chain = MigrationChain.for<DepositedV3>('BankAccount.Deposited', 3)
      .add({ fromVersion: 1, toVersion: 2,
             upcast: (version: DepositedV1): DepositedV2 => ({ ...version, currency: 'USD' }) })
      .add({ fromVersion: 2, toVersion: 3,
             upcast: (version: DepositedV2): DepositedV3 => ({ kind: version.kind, cents: version.amount * 100, currency: version.currency }) });
    const out = chain.upcast({ manifest: 'BankAccount.Deposited', version: 1, payload: { kind: 'deposited', amount: 5 } });
    expect(out).toEqual({ kind: 'deposited', cents: 500, currency: 'USD' });
  });

  test('storing-current-version is a no-op (zero steps applied)', () => {
    const chain = MigrationChain.for<DepositedV2>('BankAccount.Deposited', 2);
    const v2: DepositedV2 = { kind: 'deposited', amount: 100, currency: 'EUR' };
    const out = chain.upcast({ manifest: 'BankAccount.Deposited', version: 2, payload: v2 });
    expect(out).toBe(v2); // same reference — no copy
  });

  test('skip-step (v1 → v3 in one jump) is allowed if registered', () => {
    const chain = MigrationChain.for<DepositedV3>('BankAccount.Deposited', 3)
      .add({ fromVersion: 1, toVersion: 3,
             upcast: (version: DepositedV1): DepositedV3 => ({ kind: version.kind, cents: version.amount * 100, currency: 'USD' }) });
    const out = chain.upcast({ manifest: 'BankAccount.Deposited', version: 1, payload: { kind: 'deposited', amount: 7 } });
    expect(out).toEqual({ kind: 'deposited', cents: 700, currency: 'USD' });
  });
});

describe('MigrationChain — error paths', () => {
  test('manifest mismatch throws MigrationError', () => {
    const chain = MigrationChain.for<DepositedV2>('BankAccount.Deposited', 2)
      .add({ fromVersion: 1, toVersion: 2, upcast: (version: DepositedV1) => ({ ...version, currency: 'USD' as const }) });
    expect(() => chain.upcast({ manifest: 'WrongType', version: 1, payload: {} })).toThrow(MigrationError);
  });

  test('downgrade attempt throws (stored.version > currentVersion)', () => {
    const chain = MigrationChain.for<DepositedV2>('BankAccount.Deposited', 2);
    const err = catchThrows(() => chain.upcast({ manifest: 'BankAccount.Deposited', version: 5, payload: {} }));
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as Error).message).toContain('cannot downgrade');
  });

  test('chain gap throws with the missing version printed', () => {
    // currentVersion = 3, registered only v2 → v3.  Stored is v1 — no step starts at v1.
    const chain = MigrationChain.for<DepositedV3>('BankAccount.Deposited', 3)
      .add({ fromVersion: 2, toVersion: 3,
             upcast: (version: DepositedV2): DepositedV3 => ({ kind: version.kind, cents: version.amount * 100, currency: version.currency }) });
    const err = catchThrows(() => chain.upcast({ manifest: 'BankAccount.Deposited', version: 1, payload: {} }));
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as Error).message).toContain('starting at v1');
  });
});

describe('MigrationChain — construction guards', () => {
  test('rejects non-positive currentVersion', () => {
    expect(() => MigrationChain.for('X', 0)).toThrow();
    expect(() => MigrationChain.for('X', -1)).toThrow();
    expect(() => MigrationChain.for('X', 1.5)).toThrow();
  });

  test('rejects step with from >= to', () => {
    const chain = MigrationChain.for<DepositedV2>('X', 2);
    expect(() => chain.add({ fromVersion: 2, toVersion: 2, upcast: (x) => x })).toThrow();
    expect(() => chain.add({ fromVersion: 3, toVersion: 2, upcast: (x) => x })).toThrow();
  });

  test('rejects step targeting a version above currentVersion', () => {
    const chain = MigrationChain.for<DepositedV2>('X', 2);
    expect(() => chain.add({ fromVersion: 1, toVersion: 3, upcast: (x) => x })).toThrow();
  });

  test('rejects two steps starting at the same fromVersion', () => {
    const chain = MigrationChain.for<DepositedV3>('X', 3)
      .add({ fromVersion: 1, toVersion: 2, upcast: (x: any) => x });
    expect(() => chain.add({ fromVersion: 1, toVersion: 3, upcast: (x: any) => x })).toThrow();
  });
});

function catchThrows(fn: () => unknown): unknown {
  try { fn(); return null; } catch (e) { return e; }
}

/* =================== #7 — rolling-deploy downcasters =================== */

describe('MigrationChain — downcasters (#7)', () => {
  const buildChain = (): MigrationChain<DepositedV2> =>
    MigrationChain.for<DepositedV2>('BankAccount.Deposited', 2)
      .add({ fromVersion: 1, toVersion: 2,
             upcast: (version: DepositedV1): DepositedV2 => ({ ...version, currency: 'USD' }) })
      .addDown({ fromVersion: 2, toVersion: 1,
                 downcast: (version: DepositedV2): DepositedV1 => {
                   const { currency: _c, ...rest } = version;
                   void _c;
                   return rest as DepositedV1;
                 } });

  test('downcast: v2 → v1 strips fields the older version did not have', () => {
    const chain = buildChain();
    const out = chain.downcast({ kind: 'deposited', amount: 100, currency: 'USD' }, 1);
    expect(out).toEqual({ kind: 'deposited', amount: 100 });
  });

  test('downcast to currentVersion is a zero-step no-op', () => {
    const chain = buildChain();
    const version: DepositedV2 = { kind: 'deposited', amount: 1, currency: 'EUR' };
    expect(chain.downcast(version, 2)).toBe(version);
  });

  test('downcast targeting a newer version throws MigrationError', () => {
    const chain = buildChain();
    const version: DepositedV2 = { kind: 'deposited', amount: 1, currency: 'EUR' };
    expect(() => chain.downcast(version, 3)).toThrow(MigrationError);
  });

  test('downcast with chain gap throws with the missing step printed', () => {
    const chain = MigrationChain.for<DepositedV3>('BankAccount.Deposited', 3)
      .add({ fromVersion: 2, toVersion: 3,
             upcast: (version: DepositedV2): DepositedV3 => ({ kind: version.kind, cents: version.amount * 100, currency: version.currency }) })
      // Only v3 → v2 registered; missing v2 → v1.
      .addDown({ fromVersion: 3, toVersion: 2,
                 downcast: (version: DepositedV3): DepositedV2 => ({ kind: version.kind, amount: version.cents / 100, currency: version.currency }) });
    const version: DepositedV3 = { kind: 'deposited', cents: 500, currency: 'USD' };
    expect(() => chain.downcast(version, 1)).toThrow(/starting at v2/);
  });

  test('toJournalAt with writeVersion < currentVersion produces an old-shape frame', () => {
    const chain = buildChain();
    const frame = chain.toJournalAt({ kind: 'deposited', amount: 50, currency: 'EUR' }, 1);
    expect(frame).toEqual({
      manifest: 'BankAccount.Deposited',
      version: 1,
      payload: { kind: 'deposited', amount: 50 },
    });
  });

  test('toJournalAt without writeVersion emits the current shape', () => {
    const chain = buildChain();
    const frame = chain.toJournalAt({ kind: 'deposited', amount: 50, currency: 'EUR' });
    expect(frame.version).toBe(2);
    expect(frame.payload).toEqual({ kind: 'deposited', amount: 50, currency: 'EUR' });
  });

  test('addDown rejects backward steps that don\'t move backward', () => {
    const chain = MigrationChain.for<DepositedV2>('X', 2);
    expect(() => chain.addDown({ fromVersion: 1, toVersion: 1, downcast: (x) => x })).toThrow();
    expect(() => chain.addDown({ fromVersion: 1, toVersion: 2, downcast: (x) => x })).toThrow();
  });

  test('addDown rejects fromVersion > currentVersion', () => {
    const chain = MigrationChain.for<DepositedV2>('X', 2);
    expect(() => chain.addDown({ fromVersion: 3, toVersion: 2, downcast: (x) => x })).toThrow();
  });
});
