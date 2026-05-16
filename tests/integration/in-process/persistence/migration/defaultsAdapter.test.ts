import { describe, expect, test } from 'bun:test';
import {
  defaultsAdapter,
  defaultsSnapshotAdapter,
} from '../../../../../src/persistence/migration/defaultsAdapter.js';
import { MigrationError } from '../../../../../src/persistence/migration/Envelope.js';

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

/* =================== #7 — rolling-deploy writeVersion =================== */

describe('defaultsAdapter — writeVersion (#7)', () => {
  test('writeVersion = currentVersion (default) emits the current shape unchanged', () => {
    const adapter = defaultsAdapter<DepositedV2>({
      manifest: 'BankAccount.Deposited',
      currentVersion: 2,
      defaults: { 1: { currency: 'USD' } },
    });
    const out = adapter.toJournal({ kind: 'deposited', amount: 100, currency: 'USD' });
    expect(out).toEqual({
      manifest: 'BankAccount.Deposited',
      version: 2,
      payload: { kind: 'deposited', amount: 100, currency: 'USD' },
    });
  });

  test('writeVersion < currentVersion strips fields added at later versions', () => {
    const adapter = defaultsAdapter<DepositedV2>({
      manifest: 'BankAccount.Deposited',
      currentVersion: 2,
      writeVersion: 1,
      defaults: { 1: { currency: 'USD' } },
    });
    const out = adapter.toJournal({ kind: 'deposited', amount: 100, currency: 'USD' });
    expect(out).toEqual({
      manifest: 'BankAccount.Deposited',
      version: 1,
      payload: { kind: 'deposited', amount: 100 }, // currency stripped
    });
  });

  test('multi-step writeVersion strips every field added on the way', () => {
    const adapter = defaultsAdapter<DepositedV3>({
      manifest: 'BankAccount.Deposited',
      currentVersion: 3,
      writeVersion: 1,
      defaults: {
        1: { currency: 'USD' },
        2: { channel: 'web' },
      },
    });
    const out = adapter.toJournal({
      kind: 'deposited', amount: 75, currency: 'EUR', channel: 'mobile',
    });
    expect(out.version).toBe(1);
    expect(out.payload).toEqual({ kind: 'deposited', amount: 75 });
  });

  test('rolling-deploy round-trip: writer A emits v1, reader B upcasts back to v3', () => {
    // Producer is on writeVersion=1 (during rollout); consumer is on
    // currentVersion=3.  After a round-trip the consumer sees the
    // current shape with defaults applied for both gaps.
    const writer = defaultsAdapter<DepositedV3>({
      manifest: 'BankAccount.Deposited',
      currentVersion: 3,
      writeVersion: 1,
      defaults: { 1: { currency: 'USD' }, 2: { channel: 'web' } },
    });
    const reader = defaultsAdapter<DepositedV3>({
      manifest: 'BankAccount.Deposited',
      currentVersion: 3,
      defaults: { 1: { currency: 'USD' }, 2: { channel: 'web' } },
    });
    const wire = writer.toJournal({
      kind: 'deposited', amount: 33, currency: 'EUR', channel: 'mobile',
    });
    const rebuilt = reader.fromJournal(wire);
    // Wire was v1 — non-default fields gone.  Reader fills v1→v2→v3
    // defaults: currency=USD, channel=web.
    expect(rebuilt).toEqual({
      kind: 'deposited', amount: 33, currency: 'USD', channel: 'web',
    });
  });

  test('rejects writeVersion > currentVersion', () => {
    expect(() => defaultsAdapter<DepositedV2>({
      manifest: 'X', currentVersion: 2, writeVersion: 3, defaults: { 1: { currency: 'USD' } },
    })).toThrow(/writeVersion/);
  });

  test('rejects writeVersion = 0 or negative', () => {
    expect(() => defaultsAdapter<DepositedV2>({
      manifest: 'X', currentVersion: 2, writeVersion: 0, defaults: { 1: { currency: 'USD' } },
    })).toThrow(/writeVersion/);
  });

  test('rejects writeVersion below currentVersion when intermediate defaults are missing', () => {
    expect(() => defaultsAdapter<DepositedV3>({
      manifest: 'X',
      currentVersion: 3,
      writeVersion: 1,
      defaults: { 1: { currency: 'USD' } },   // missing defaults[2]
    })).toThrow(/missing defaults\[2\]/);
  });
});
