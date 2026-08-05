/**
 * Shape checks at the cluster's decode boundary.
 *
 * `FrameDecoder` ends in `JSON.parse(json) as WireMessage` — a cast that used
 * to be the only thing standing between a peer's bytes and code that reads
 * those bytes as if the type were true.  Each case below is a frame that
 * reached a dereference or a `match(...).exhaustive()` before #563/#571/#705.
 */
import { describe, expect, test } from 'bun:test';
import {
  isMemberData,
  isNodeAddressData,
  isWireFrame,
  validateWireFrame,
  sanitizeWireLogContext,
} from '../../../src/cluster/WireValidation.js';

describe('isWireFrame — the floor every frame must clear', () => {
  test('rejects the values JSON.parse can produce that are not objects', () => {
    // `JSON.parse('null')` is the sharp one: 8 bytes on the wire, and
    // `TcpTransport.onMessage` dereferenced `.kind` on it before any handshake
    // check ran — a remote process kill with no preconditions (#705).
    for (const value of [null, undefined, 'hello', 42, true, []]) {
      expect(isWireFrame(value)).toBe(false);
    }
  });

  test('rejects an object whose kind is not a string', () => {
    expect(isWireFrame({ kind: 7 })).toBe(false);
    expect(isWireFrame({})).toBe(false);
  });

  test('accepts an object carrying a string kind', () => {
    expect(isWireFrame({ kind: 'hello' })).toBe(true);
  });
});

describe('isNodeAddressData', () => {
  test('rejects a port that arrived as a string', () => {
    // The desync case (#571): `toString()` renders `"2552"` and `2552`
    // identically, so both key every map the same way — but `equals()` compares
    // with `===` and never matches. A node reading its own address back in this
    // shape stops recognising itself, permanently.
    expect(isNodeAddressData({ systemName: 'app', host: 'h', port: '2552' })).toBe(false);
  });

  test('rejects non-integer, zero and negative ports', () => {
    for (const port of [0, -1, 1.5, NaN, Infinity]) {
      expect(isNodeAddressData({ systemName: 'app', host: 'h', port })).toBe(false);
    }
  });

  test('rejects empty or missing systemName / host', () => {
    expect(isNodeAddressData({ systemName: '', host: 'h', port: 1 })).toBe(false);
    expect(isNodeAddressData({ systemName: 'app', host: '', port: 1 })).toBe(false);
    expect(isNodeAddressData({ host: 'h', port: 1 })).toBe(false);
  });

  test('accepts a synthetic port above the TCP range', () => {
    // Deliberate: under InMemoryTransport the port is a node discriminator, not
    // something anyone dials. ClusterOptionsValidator states the same rule.
    expect(isNodeAddressData({ systemName: 'app', host: 'h', port: 89_001 })).toBe(true);
  });
});

describe('isMemberData', () => {
  test('rejects a status outside the seven legal values', () => {
    // The #563 payload verbatim. `Cluster.emitStatusTransition` dispatches on
    // this with `.exhaustive()`, which throws — after the member has already
    // been written to the map and is therefore due to be re-gossiped.
    expect(isMemberData({
      address: { systemName: 'app', host: 'h', port: 60_100 },
      status: 'pwned',
      version: 1,
    })).toBe(false);
  });

  test('accepts every legal status', () => {
    for (const status of ['joining', 'weakly-up', 'up', 'unreachable', 'leaving', 'down', 'removed']) {
      expect(isMemberData({
        address: { systemName: 'app', host: 'h', port: 1 }, status, version: 1,
      })).toBe(true);
    }
  });

  test('rejects a non-finite version and a non-string role', () => {
    const address = { systemName: 'app', host: 'h', port: 1 };
    expect(isMemberData({ address, status: 'up', version: NaN })).toBe(false);
    expect(isMemberData({ address, status: 'up', version: 1, roles: [7] })).toBe(false);
  });
});

describe('validateWireFrame — per-kind shapes', () => {
  const address = { systemName: 'app', host: 'h', port: 2552 };

  test('names the offending field so a dropped frame is diagnosable', () => {
    const result = validateWireFrame({ kind: 'leave', node: { systemName: 'app', host: 'h' } });
    expect(result).toHaveProperty('problem');
    expect((result as { problem: string }).problem).toContain('node');
  });

  test('rejects gossip whose member list is not an array', () => {
    const result = validateWireFrame({ kind: 'gossip', from: address, members: 'all-of-them' });
    expect(result).toHaveProperty('problem');
  });

  test('reports which member of a gossip batch is malformed', () => {
    const good = { address, status: 'up', version: 1 };
    const result = validateWireFrame({
      kind: 'gossip', from: address, members: [good, { ...good, status: 'pwned' }],
    });
    expect((result as { problem: string }).problem).toContain('member[1]');
  });

  test('rejects an envelope with no destination path', () => {
    expect(validateWireFrame({ kind: 'envelope', to: '', from: null, body: {} }))
      .toHaveProperty('problem');
  });

  test('accepts an envelope whose from is null', () => {
    // `null` is the documented "no sender", distinct from a missing field.
    expect(validateWireFrame({ kind: 'envelope', to: '/user/a', from: null, body: {} }))
      .toHaveProperty('message');
  });

  test('accepts well-formed frames of every core kind', () => {
    const frames = [
      { kind: 'hello', self: address },
      { kind: 'hello-ack', self: address },
      { kind: 'heartbeat', from: address, seq: 1, ts: Date.now() },
      { kind: 'heartbeat-ack', from: address, seq: 1 },
      { kind: 'gossip', from: address, members: [{ address, status: 'up', version: 1 }] },
      { kind: 'envelope', to: '/user/a', from: '/user/b', body: { hello: 'world' } },
      { kind: 'shard-map', type: 'User', shards: { 0: address }, version: 3 },
      { kind: 'leave', node: address },
    ];
    for (const frame of frames) {
      expect(validateWireFrame(frame)).toHaveProperty('message');
    }
  });

  test('passes an unknown kind through to its extension handler', () => {
    // Sharding, pub-sub, the receptionist and DistributedData all register
    // their own kinds via `Cluster._onWire`; their payloads are not part of
    // `WireMessage`. Rejecting what this module does not recognise would break
    // every one of them — they validate their own payloads instead.
    expect(validateWireFrame({ kind: 'ddata-gossip', anything: true }))
      .toHaveProperty('message');
  });
});

describe('sanitizeWireLogContext — a peer may add context, not rewrite the record (#573)', () => {
  test('drops the fields JsonLogger writes itself', () => {
    // JsonLogger spreads the MDC LAST, so before the guard these did not add
    // fields — they replaced the real ones, and the forged record was
    // indistinguishable from a genuine one downstream.
    const safe = sanitizeWireLogContext({
      ts: 'yesterday', level: 'DEBUG', source: 'somewhere-else', msg: 'nothing happened',
      args: 'x', correlationId: 'abc-123',
    });
    expect(safe).toEqual({ correlationId: 'abc-123' });
  });

  test('drops values containing a line break', () => {
    // ConsoleLogger writes one line per record, so a newline in a value forges
    // as many extra log lines as the sender likes, each looking genuine.
    for (const evil of ['a\nb', 'a\rb', 'a\u2028b', 'a\u2029b', 'a\u0085b', 'a\u0000b']) {
      expect(sanitizeWireLogContext({ evil, ok: 'fine' })).toEqual({ ok: 'fine' });
    }
  });

  test('drops a key containing a line break', () => {
    expect(sanitizeWireLogContext({ 'bad\nkey': 'v', ok: 'fine' })).toEqual({ ok: 'fine' });
  });

  test('keeps the primitives LogContextData actually admits', () => {
    expect(sanitizeWireLogContext({ s: 'x', n: 42, b: true }))
      .toEqual({ s: 'x', n: 42, b: true });
  });

  test('drops non-primitive values and non-finite numbers', () => {
    const context = { obj: {}, arr: [], nil: null, nan: NaN, inf: Infinity, ok: 1 };
    expect(sanitizeWireLogContext(context as never)).toEqual({ ok: 1 });
  });

  test('bounds how much a peer may staple onto every log line', () => {
    // The context rides on every envelope and is stamped onto every line the
    // receiving actor emits — an oversized one is a standing tax, not one big
    // record.
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 'v']));
    expect(Object.keys(sanitizeWireLogContext(many)).length).toBeLessThanOrEqual(32);

    const long = { huge: 'x'.repeat(5_000), ok: 'fine' };
    expect(sanitizeWireLogContext(long)).toEqual({ ok: 'fine' });
  });
});
