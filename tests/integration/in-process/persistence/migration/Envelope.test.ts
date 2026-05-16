import { describe, expect, test } from 'bun:test';
import {
  decodeEvent,
  decodeState,
  encodeEvent,
  encodeState,
  isEnvelope,
  MigrationError,
} from '../../../../../src/persistence/migration/Envelope.js';
import type { EventAdapter, SnapshotAdapter } from '../../../../../src/persistence/migration/Adapter.js';

type DepositedV1 = { kind: 'deposited'; amount: number };
type DepositedV2 = { kind: 'deposited'; amount: number; currency: 'USD' | 'EUR' };

const v2Adapter: EventAdapter<DepositedV2> = {
  manifest: () => 'BankAccount.Deposited',
  toJournal: (e) => ({ manifest: 'BankAccount.Deposited', version: 2, payload: e }),
  fromJournal: (s) => {
    if (s.version === 1) {
      const v1 = s.payload as DepositedV1;
      return { ...v1, currency: 'USD' };
    }
    return s.payload as DepositedV2;
  },
};

describe('isEnvelope', () => {
  test('recognises valid envelopes', () => {
    expect(isEnvelope({ _v: 1, _t: 'X', _e: { foo: 'bar' } })).toBe(true);
    expect(isEnvelope({ _v: 99, _t: '', _e: null })).toBe(true);
  });

  test('rejects raw objects without the magic keys', () => {
    expect(isEnvelope({ kind: 'deposited', amount: 100 })).toBe(false);
    expect(isEnvelope({ _v: 1, _t: 'X' })).toBe(false); // missing _e
    expect(isEnvelope({ _v: '1', _t: 'X', _e: {} })).toBe(false); // _v not a number
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope(undefined)).toBe(false);
    expect(isEnvelope('string')).toBe(false);
    expect(isEnvelope(42)).toBe(false);
  });
});

describe('encodeEvent / decodeEvent', () => {
  test('round-trips a current-version event through the adapter', () => {
    const event: DepositedV2 = { kind: 'deposited', amount: 100, currency: 'EUR' };
    const env = encodeEvent(event, v2Adapter);
    expect(env._v).toBe(2);
    expect(env._t).toBe('BankAccount.Deposited');
    expect(env._e).toEqual(event);
    const back = decodeEvent(env, v2Adapter);
    expect(back).toEqual(event);
  });

  test('decodes a v1 envelope by upcasting through the adapter', () => {
    const v1Envelope = { _v: 1, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 100 } };
    const back = decodeEvent(v1Envelope, v2Adapter);
    expect(back).toEqual({ kind: 'deposited', amount: 100, currency: 'USD' });
  });

  test('passthrough when no adapter is supplied (greenfield default)', () => {
    const raw = { kind: 'deposited', amount: 100 };
    expect(decodeEvent(raw, undefined)).toEqual(raw);
  });

  test('strict mode: adapter active + raw payload throws MigrationError', () => {
    const raw = { kind: 'deposited', amount: 100 };
    expect(() => decodeEvent(raw, v2Adapter)).toThrow(MigrationError);
    try { decodeEvent(raw, v2Adapter); }
    catch (e) {
      expect((e as Error).message).toContain('expected envelope, got raw payload');
    }
  });
});

describe('encodeState / decodeState', () => {
  type StateV1 = { balance: number };
  type StateV2 = { balance: number; currency: 'USD' | 'EUR' };
  const stateAdapter: SnapshotAdapter<StateV2> = {
    manifest: () => 'BankAccount.State',
    toJournal: (s) => ({ manifest: 'BankAccount.State', version: 2, payload: s }),
    fromJournal: (s) => s.version === 1
      ? { ...(s.payload as StateV1), currency: 'USD' }
      : (s.payload as StateV2),
  };

  test('round-trips a state value', () => {
    const state: StateV2 = { balance: 42, currency: 'EUR' };
    const env = encodeState(state, stateAdapter);
    expect(env).toEqual({ _v: 2, _t: 'BankAccount.State', _e: state });
    expect(decodeState(env, stateAdapter)).toEqual(state);
  });

  test('upcasts a v1 snapshot envelope', () => {
    const v1 = { _v: 1, _t: 'BankAccount.State', _e: { balance: 7 } };
    expect(decodeState(v1, stateAdapter)).toEqual({ balance: 7, currency: 'USD' });
  });

  test('strict mode: state adapter active + raw payload throws', () => {
    const raw = { balance: 0 };
    expect(() => decodeState(raw, stateAdapter)).toThrow(MigrationError);
  });

  test('passthrough when no adapter is supplied', () => {
    const raw = { balance: 5 };
    expect(decodeState(raw, undefined)).toEqual(raw);
  });
});
