import { describe, expect, test } from 'bun:test';
import { MigrationChain } from '../../../../src/persistence/migration/MigrationChain.js';
import { MigrationError } from '../../../../src/persistence/migration/Envelope.js';

type DepositedV1 = { kind: 'deposited'; amount: number };
type DepositedV2 = { kind: 'deposited'; amount: number; currency: 'USD' | 'EUR' };
type DepositedV3 = { kind: 'deposited'; cents: number; currency: 'USD' | 'EUR' };

describe('MigrationChain — happy path', () => {
  test('single step v1 → v2 (additive)', () => {
    const chain = MigrationChain.for<DepositedV2>('BankAccount.Deposited', 2)
      .add({ fromVersion: 1, toVersion: 2,
             upcast: (v: DepositedV1): DepositedV2 => ({ ...v, currency: 'USD' }) });
    const out = chain.upcast({ manifest: 'BankAccount.Deposited', version: 1, payload: { kind: 'deposited', amount: 100 } });
    expect(out).toEqual({ kind: 'deposited', amount: 100, currency: 'USD' });
  });

  test('two-step v1 → v2 → v3 (additive then rename)', () => {
    const chain = MigrationChain.for<DepositedV3>('BankAccount.Deposited', 3)
      .add({ fromVersion: 1, toVersion: 2,
             upcast: (v: DepositedV1): DepositedV2 => ({ ...v, currency: 'USD' }) })
      .add({ fromVersion: 2, toVersion: 3,
             upcast: (v: DepositedV2): DepositedV3 => ({ kind: v.kind, cents: v.amount * 100, currency: v.currency }) });
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
             upcast: (v: DepositedV1): DepositedV3 => ({ kind: v.kind, cents: v.amount * 100, currency: 'USD' }) });
    const out = chain.upcast({ manifest: 'BankAccount.Deposited', version: 1, payload: { kind: 'deposited', amount: 7 } });
    expect(out).toEqual({ kind: 'deposited', cents: 700, currency: 'USD' });
  });
});

describe('MigrationChain — error paths', () => {
  test('manifest mismatch throws MigrationError', () => {
    const chain = MigrationChain.for<DepositedV2>('BankAccount.Deposited', 2)
      .add({ fromVersion: 1, toVersion: 2, upcast: (v: DepositedV1) => ({ ...v, currency: 'USD' as const }) });
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
             upcast: (v: DepositedV2): DepositedV3 => ({ kind: v.kind, cents: v.amount * 100, currency: v.currency }) });
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
