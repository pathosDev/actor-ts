/**
 * In-process SchemaRegistry tests (#6).
 *
 *   - register/get/latestVersion/list happy path.
 *   - eventAdapter writes at the latest version + reads any
 *     version by chaining upcasters.
 *   - Compatibility modes ('none' / 'backward' / 'sample') gate
 *     registration as documented.
 *   - Read-path errors: missing version, missing upcastFromPrev,
 *     wire-validation failure.
 */
import { describe, expect, test } from 'bun:test';
import {
  jsonCodec,
  zodCodec,
  type ParserLike,
} from '../../../../../src/persistence/migration/Codec.js';
import { MigrationError } from '../../../../../src/persistence/migration/Envelope.js';
import {
  InMemorySchemaRegistry,
} from '../../../../../src/persistence/migration/SchemaRegistry.js';

interface DepositedV1 { kind: 'deposited'; amount: number }
interface DepositedV2 { kind: 'deposited'; amount: number; currency: 'USD' | 'EUR' }
interface DepositedV3 { kind: 'deposited'; cents: number; currency: 'USD' | 'EUR' }

const v1Schema: ParserLike<DepositedV1> = {
  parse(input: unknown) {
    const o = input as DepositedV1;
    if (o.kind !== 'deposited' || typeof o.amount !== 'number') throw new Error('bad v1');
    return { kind: 'deposited', amount: o.amount };
  },
};

const v2Schema: ParserLike<DepositedV2> = {
  parse(input: unknown) {
    const o = input as DepositedV2;
    if (o.kind !== 'deposited' || typeof o.amount !== 'number') throw new Error('bad v2 — amount');
    if (o.currency !== 'USD' && o.currency !== 'EUR') throw new Error('bad v2 — currency');
    return { kind: 'deposited', amount: o.amount, currency: o.currency };
  },
};

const v3Schema: ParserLike<DepositedV3> = {
  parse(input: unknown) {
    const o = input as DepositedV3;
    if (o.kind !== 'deposited' || typeof o.cents !== 'number') throw new Error('bad v3 — cents');
    if (o.currency !== 'USD' && o.currency !== 'EUR') throw new Error('bad v3 — currency');
    return { kind: 'deposited', cents: o.cents, currency: o.currency };
  },
};

describe('InMemorySchemaRegistry — basic registration', () => {
  test('register stores the descriptor; get + latestVersion + list reflect it', () => {
    const r = new InMemorySchemaRegistry();
    r.register('X', 1, { codec: zodCodec(v1Schema) });
    r.register('X', 2, {
      codec: zodCodec(v2Schema),
      upcastFromPrev: (v: DepositedV1): DepositedV2 => ({ ...v, currency: 'USD' }),
    });
    expect(r.latestVersion('X')).toBe(2);
    expect(r.get('X', 1)?.codec.name).toBe('zod');
    expect(r.list()).toHaveLength(2);
    expect(r.latestVersion('Y')).toBeUndefined();
  });

  test('rejects non-positive integer versions', () => {
    const r = new InMemorySchemaRegistry();
    expect(() => r.register('X', 0, { codec: jsonCodec() })).toThrow();
    expect(() => r.register('X', -1, { codec: jsonCodec() })).toThrow();
    expect(() => r.register('X', 1.5, { codec: jsonCodec() })).toThrow();
  });
});

describe('InMemorySchemaRegistry — eventAdapter happy path', () => {
  test('writes at the latest version and decodes any older version through the upcast chain', () => {
    const r = new InMemorySchemaRegistry();
    r.register('Tx.Deposited', 1, { codec: zodCodec(v1Schema) });
    r.register('Tx.Deposited', 2, {
      codec: zodCodec(v2Schema),
      upcastFromPrev: (v: DepositedV1): DepositedV2 => ({ ...v, currency: 'USD' }),
    });
    r.register('Tx.Deposited', 3, {
      codec: zodCodec(v3Schema),
      upcastFromPrev: (v: DepositedV2): DepositedV3 => ({
        kind: v.kind, cents: v.amount * 100, currency: v.currency,
      }),
    });
    const adapter = r.eventAdapter<DepositedV3>('Tx.Deposited');

    // Writes at v3 with v3 codec.
    const wire = adapter.toJournal({ kind: 'deposited', cents: 500, currency: 'EUR' });
    expect(wire.version).toBe(3);
    expect(wire.payload).toEqual({ kind: 'deposited', cents: 500, currency: 'EUR' });

    // Reads v1 wire → upcast to v3.
    const v1Read = adapter.fromJournal({
      manifest: 'Tx.Deposited', version: 1, payload: { kind: 'deposited', amount: 7 },
    });
    expect(v1Read).toEqual({ kind: 'deposited', cents: 700, currency: 'USD' });

    // Reads v2 wire → upcast one step to v3.
    const v2Read = adapter.fromJournal({
      manifest: 'Tx.Deposited', version: 2, payload: { kind: 'deposited', amount: 12, currency: 'EUR' },
    });
    expect(v2Read).toEqual({ kind: 'deposited', cents: 1200, currency: 'EUR' });
  });

  test('write fails with no schema registered', () => {
    const r = new InMemorySchemaRegistry();
    const adapter = r.eventAdapter<DepositedV1>('Unknown');
    expect(() => adapter.toJournal({ kind: 'deposited', amount: 1 })).toThrow(MigrationError);
  });

  test('read fails for an unregistered stored version', () => {
    const r = new InMemorySchemaRegistry();
    r.register('X', 1, { codec: zodCodec(v1Schema) });
    const adapter = r.eventAdapter<DepositedV1>('X');
    expect(() => adapter.fromJournal({
      manifest: 'X', version: 99, payload: {},
    })).toThrow(/no schema registered/);
  });

  test('read fails when an intermediate upcaster is missing', () => {
    const r = new InMemorySchemaRegistry();
    r.register('X', 1, { codec: zodCodec(v1Schema) });
    // v2 registered but no upcastFromPrev — chain is broken.
    r.register('X', 2, { codec: zodCodec(v2Schema) });
    const adapter = r.eventAdapter<DepositedV2>('X');
    expect(() => adapter.fromJournal({
      manifest: 'X', version: 1, payload: { kind: 'deposited', amount: 3 },
    })).toThrow(/no upcastFromPrev/);
  });

  test('read fails with a clear codec error when wire data is corrupted', () => {
    const r = new InMemorySchemaRegistry();
    r.register('X', 1, { codec: zodCodec(v1Schema) });
    const adapter = r.eventAdapter<DepositedV1>('X');
    expect(() => adapter.fromJournal({
      manifest: 'X', version: 1, payload: { kind: 'deposited', amount: 'corrupt' },
    })).toThrow(/bad v1/);
  });
});

describe('InMemorySchemaRegistry — compatibility checks', () => {
  test('compatibility=backward requires upcastFromPrev', () => {
    const r = new InMemorySchemaRegistry();
    r.register('X', 1, { codec: zodCodec(v1Schema) });
    expect(() => r.register('X', 2, {
      codec: zodCodec(v2Schema), compatibility: 'backward',
      // missing upcastFromPrev
    })).toThrow(/upcastFromPrev/);
  });

  test('compatibility=backward requires the previous version to exist', () => {
    const r = new InMemorySchemaRegistry();
    expect(() => r.register('X', 2, {
      codec: zodCodec(v2Schema), compatibility: 'backward',
      upcastFromPrev: (v: DepositedV1) => ({ ...v, currency: 'USD' as const }),
    })).toThrow(/v1 is not registered/);
  });

  test('compatibility=sample runs the round-trip and accepts a working upcaster', () => {
    const r = new InMemorySchemaRegistry();
    r.register('X', 1, { codec: zodCodec(v1Schema) });
    expect(() => r.register('X', 2, {
      codec: zodCodec(v2Schema),
      compatibility: 'sample',
      sample: { kind: 'deposited', amount: 100 },
      upcastFromPrev: (v: DepositedV1): DepositedV2 => ({ ...v, currency: 'USD' }),
    })).not.toThrow();
  });

  test('compatibility=sample rejects when the upcaster produces an invalid v2', () => {
    const r = new InMemorySchemaRegistry();
    r.register('X', 1, { codec: zodCodec(v1Schema) });
    expect(() => r.register('X', 2, {
      codec: zodCodec(v2Schema),
      compatibility: 'sample',
      sample: { kind: 'deposited', amount: 100 },
      // Forgets to set currency — v2's codec will reject.
      upcastFromPrev: (v: DepositedV1): DepositedV2 => v as unknown as DepositedV2,
    })).toThrow(/sample-compat check failed/);
  });

  test('compatibility=sample requires a sample value', () => {
    const r = new InMemorySchemaRegistry();
    r.register('X', 1, { codec: zodCodec(v1Schema) });
    expect(() => r.register('X', 2, {
      codec: zodCodec(v2Schema),
      compatibility: 'sample',
      // no sample
      upcastFromPrev: (v: DepositedV1): DepositedV2 => ({ ...v, currency: 'USD' }),
    })).toThrow(/sample value/);
  });

  test('compatibility=none (default) accepts everything — including v(N) without v(N-1)', () => {
    const r = new InMemorySchemaRegistry();
    expect(() => r.register('X', 5, { codec: zodCodec(v1Schema) })).not.toThrow();
    expect(r.latestVersion('X')).toBe(5);
  });
});

describe('InMemorySchemaRegistry — snapshotAdapter', () => {
  test('snapshotAdapter mirrors eventAdapter shape', () => {
    const r = new InMemorySchemaRegistry();
    r.register('Acct.State', 1, { codec: zodCodec(v1Schema) });
    const adapter = r.snapshotAdapter<DepositedV1>('Acct.State');
    const wire = adapter.toJournal({ kind: 'deposited', amount: 50 });
    expect(wire.version).toBe(1);
    const back = adapter.fromJournal(wire);
    expect(back).toEqual({ kind: 'deposited', amount: 50 });
  });
});
