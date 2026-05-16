/**
 * Codec primitives + validatedAdapter wrapper (#6).
 *
 *   - jsonCodec is a pass-through.
 *   - zodCodec validates input on encode AND wire on decode.
 *   - validatedEventAdapter raises MigrationError when the codec
 *     rejects, with the manifest + version printed.
 *   - composeCodecs runs both codecs in order on encode and in
 *     reverse on decode.
 */
import { describe, expect, test } from 'bun:test';
import {
  composeCodecs,
  jsonCodec,
  zodCodec,
  type ParserLike,
} from '../../../../../src/persistence/migration/Codec.js';
import { defaultsAdapter } from '../../../../../src/persistence/migration/defaultsAdapter.js';
import {
  validatedEventAdapter,
  validatedSnapshotAdapter,
} from '../../../../../src/persistence/migration/validatedAdapter.js';

/** Tiny hand-rolled `parse` validator standing in for Zod. */
function strictNumberAmount(): ParserLike<{ amount: number; currency: 'USD' | 'EUR' }> {
  return {
    parse(input: unknown) {
      if (typeof input !== 'object' || input === null) throw new Error('not an object');
      const o = input as Record<string, unknown>;
      if (typeof o.amount !== 'number' || !Number.isInteger(o.amount) || o.amount < 0) {
        throw new Error(`amount must be a non-negative integer, got ${String(o.amount)}`);
      }
      if (o.currency !== 'USD' && o.currency !== 'EUR') {
        throw new Error(`currency must be USD or EUR, got ${String(o.currency)}`);
      }
      return { amount: o.amount, currency: o.currency };
    },
  };
}

describe('jsonCodec', () => {
  test('passes input through unchanged on encode and decode', () => {
    const c = jsonCodec<{ x: number }>();
    expect(c.encode({ x: 1 })).toEqual({ x: 1 });
    expect(c.decode({ x: 1 })).toEqual({ x: 1 });
  });

  test('exposes a stable name for diagnostic output', () => {
    expect(jsonCodec().name).toBe('json');
  });
});

describe('zodCodec', () => {
  test('encode + decode validate against the schema', () => {
    const c = zodCodec(strictNumberAmount());
    expect(c.encode({ amount: 100, currency: 'USD' })).toEqual({ amount: 100, currency: 'USD' });
    expect(c.decode({ amount: 50, currency: 'EUR' })).toEqual({ amount: 50, currency: 'EUR' });
  });

  test('encode rejects invalid input', () => {
    const c = zodCodec(strictNumberAmount());
    expect(() => c.encode({ amount: -1, currency: 'USD' } as never)).toThrow(/non-negative/);
  });

  test('decode rejects invalid wire data', () => {
    const c = zodCodec(strictNumberAmount());
    expect(() => c.decode({ amount: 'oops' })).toThrow(/non-negative integer/);
  });

  test('explicit name appears in the codec', () => {
    const c = zodCodec(strictNumberAmount(), 'deposit-v2');
    expect(c.name).toBe('deposit-v2');
  });
});

describe('composeCodecs', () => {
  test('encode runs first then second; decode runs in reverse', () => {
    const upper: import('../../../../../src/persistence/migration/Codec.js').Codec<string> = {
      name: 'upper',
      encode: (v) => v.toUpperCase(),
      decode: (w) => (w as string).toLowerCase(),
    };
    const wrap: import('../../../../../src/persistence/migration/Codec.js').Codec<string> = {
      name: 'wrap',
      encode: (v) => `<${v}>`,
      decode: (w) => (w as string).slice(1, -1),
    };
    const combined = composeCodecs(upper, wrap);
    expect(combined.encode('hello')).toBe('<HELLO>');
    expect(combined.decode('<HELLO>')).toBe('hello');
    expect(combined.name).toBe('upper>>wrap');
  });
});

describe('validatedEventAdapter', () => {
  test('valid encode + decode round-trip succeeds', () => {
    const inner = defaultsAdapter<{ amount: number; currency: 'USD' | 'EUR' }>({
      manifest: 'Tx.Deposited',
      currentVersion: 1,
      defaults: {},
    });
    const adapter = validatedEventAdapter(inner, zodCodec(strictNumberAmount()));
    const out = adapter.toJournal({ amount: 100, currency: 'USD' });
    expect(out.payload).toEqual({ amount: 100, currency: 'USD' });
    const back = adapter.fromJournal({
      manifest: 'Tx.Deposited', version: 1, payload: { amount: 100, currency: 'USD' },
    });
    expect(back).toEqual({ amount: 100, currency: 'USD' });
  });

  test('invalid encode raises MigrationError mentioning manifest + version + codec', () => {
    const inner = defaultsAdapter<{ amount: number; currency: 'USD' | 'EUR' }>({
      manifest: 'Tx.Deposited',
      currentVersion: 1,
      defaults: {},
    });
    const adapter = validatedEventAdapter(inner, zodCodec(strictNumberAmount(), 'deposit-codec'));
    try {
      adapter.toJournal({ amount: -5, currency: 'USD' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('Tx.Deposited');
      expect((err as Error).message).toContain('v1');
      expect((err as Error).message).toContain('deposit-codec');
    }
  });

  test('invalid decode raises MigrationError pointing at the bad record', () => {
    const inner = defaultsAdapter<{ amount: number; currency: 'USD' | 'EUR' }>({
      manifest: 'Tx.Deposited',
      currentVersion: 1,
      defaults: {},
    });
    const adapter = validatedEventAdapter(inner, zodCodec(strictNumberAmount()));
    try {
      adapter.fromJournal({
        manifest: 'Tx.Deposited', version: 1, payload: { amount: 'corrupt', currency: 'USD' },
      });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('Tx.Deposited');
      expect((err as Error).message).toContain('wire=');
    }
  });

  test('previewWire override controls the error preview', () => {
    const inner = defaultsAdapter<{ amount: number; currency: 'USD' | 'EUR' }>({
      manifest: 'Tx.Deposited',
      currentVersion: 1,
      defaults: {},
    });
    const adapter = validatedEventAdapter(
      inner,
      zodCodec(strictNumberAmount()),
      { previewWire: (_w) => '<redacted>' },
    );
    try {
      adapter.fromJournal({
        manifest: 'Tx.Deposited', version: 1, payload: { amount: 'bad', currency: 'USD' },
      });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('<redacted>');
    }
  });
});

describe('validatedSnapshotAdapter', () => {
  test('mirrors validatedEventAdapter for snapshots', () => {
    const inner = defaultsAdapter<{ amount: number; currency: 'USD' | 'EUR' }>({
      manifest: 'Tx.State',
      currentVersion: 1,
      defaults: {},
    });
    const adapter = validatedSnapshotAdapter(inner, zodCodec(strictNumberAmount()));
    const out = adapter.toJournal({ amount: 7, currency: 'EUR' });
    expect(out.payload).toEqual({ amount: 7, currency: 'EUR' });
  });
});
