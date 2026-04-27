import { describe, expect, test } from 'bun:test';
import {
  defaultsAdapter,
  defaultsSnapshotAdapter,
} from '../../../../src/persistence/migration/defaultsAdapter.js';
import { MigrationError } from '../../../../src/persistence/migration/Envelope.js';

type DepositedV2 = { kind: 'deposited'; amount: number; currency: 'USD' | 'EUR' };
type DepositedV3 = DepositedV2 & { channel: 'web' | 'mobile' };

describe('defaultsAdapter — additive evolution', () => {
  test('single-step: v1 stored → v2 fills currency', () => {
    const adapter = defaultsAdapter<DepositedV2>({
      manifest: 'BankAccount.Deposited',
      currentVersion: 2,
      defaults: { 1: { currency: 'USD' } },
    });
    const out = adapter.fromJournal({
      manifest: 'BankAccount.Deposited', version: 1, payload: { kind: 'deposited', amount: 100 },
    });
    expect(out).toEqual({ kind: 'deposited', amount: 100, currency: 'USD' });
  });

  test('two-step: v1 stored → v3 fills both currency (at v1) and channel (at v2)', () => {
    const adapter = defaultsAdapter<DepositedV3>({
      manifest: 'BankAccount.Deposited',
      currentVersion: 3,
      defaults: {
        1: { currency: 'USD' },
        2: { channel: 'web' },
      },
    });
    const out = adapter.fromJournal({
      manifest: 'BankAccount.Deposited', version: 1, payload: { kind: 'deposited', amount: 50 },
    });
    expect(out).toEqual({ kind: 'deposited', amount: 50, currency: 'USD', channel: 'web' });
  });

  test('stored payload wins over defaults — never overwrites a present field', () => {
    const adapter = defaultsAdapter<DepositedV2>({
      manifest: 'BankAccount.Deposited',
      currentVersion: 2,
      defaults: { 1: { currency: 'USD' } },
    });
    // Pretend a "v1" payload already had `currency: 'EUR'` (e.g. mid-migration).
    const out = adapter.fromJournal({
      manifest: 'BankAccount.Deposited', version: 1,
      payload: { kind: 'deposited', amount: 1, currency: 'EUR' },
    });
    expect((out as DepositedV2).currency).toBe('EUR');
  });

  test('current-version stored is returned untouched', () => {
    const adapter = defaultsAdapter<DepositedV2>({
      manifest: 'BankAccount.Deposited',
      currentVersion: 2,
      defaults: { 1: { currency: 'USD' } },
    });
    const v2: DepositedV2 = { kind: 'deposited', amount: 9, currency: 'EUR' };
    expect(adapter.fromJournal({ manifest: 'BankAccount.Deposited', version: 2, payload: v2 })).toEqual(v2);
  });

  test('manifest mismatch throws MigrationError', () => {
    const adapter = defaultsAdapter<DepositedV2>({
      manifest: 'BankAccount.Deposited', currentVersion: 2, defaults: { 1: { currency: 'USD' } },
    });
    expect(() => adapter.fromJournal({ manifest: 'OtherType', version: 1, payload: {} })).toThrow(MigrationError);
  });

  test('downgrade attempt throws', () => {
    const adapter = defaultsAdapter<DepositedV2>({
      manifest: 'BankAccount.Deposited', currentVersion: 2, defaults: { 1: { currency: 'USD' } },
    });
    expect(() => adapter.fromJournal({ manifest: 'BankAccount.Deposited', version: 5, payload: {} })).toThrow(MigrationError);
  });

  test('toJournal emits envelope-frame at currentVersion', () => {
    const adapter = defaultsAdapter<DepositedV2>({
      manifest: 'BankAccount.Deposited', currentVersion: 2, defaults: { 1: { currency: 'USD' } },
    });
    const v2: DepositedV2 = { kind: 'deposited', amount: 1, currency: 'EUR' };
    const frame = adapter.toJournal(v2);
    expect(frame).toEqual({ manifest: 'BankAccount.Deposited', version: 2, payload: v2 });
  });
});

describe('defaultsAdapter — construction guards', () => {
  test('rejects non-positive currentVersion', () => {
    expect(() => defaultsAdapter({ manifest: 'X', currentVersion: 0, defaults: {} })).toThrow();
    expect(() => defaultsAdapter({ manifest: 'X', currentVersion: -1, defaults: {} })).toThrow();
  });

  test('rejects defaults entry at or above currentVersion', () => {
    expect(() => defaultsAdapter({
      manifest: 'X', currentVersion: 2, defaults: { 2: {} as Partial<DepositedV2> },
    })).toThrow();
  });
});

describe('defaultsSnapshotAdapter — snapshot variant', () => {
  type StateV2 = { balance: number; currency: 'USD' | 'EUR' };

  test('upcasts v1 snapshot state by adding currency default', () => {
    const adapter = defaultsSnapshotAdapter<StateV2>({
      manifest: 'BankAccount.State',
      currentVersion: 2,
      defaults: { 1: { currency: 'USD' } },
    });
    const out = adapter.fromJournal({
      manifest: 'BankAccount.State', version: 1, payload: { balance: 42 },
    });
    expect(out).toEqual({ balance: 42, currency: 'USD' });
  });
});
