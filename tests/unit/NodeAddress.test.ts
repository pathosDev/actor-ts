import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import { isNodeAddressData } from '../../src/cluster/WireValidation.js';

describe('NodeAddress', () => {
  test('toString follows system@host:port', () => {
    const addressA = new NodeAddress('demo', '10.0.0.1', 2552);
    expect(addressA.toString()).toBe('demo@10.0.0.1:2552');
  });

  test('parse round-trips with toString', () => {
    const original = new NodeAddress('demo', '127.0.0.1', 9001);
    const parsed = NodeAddress.parse(original.toString());
    expect(parsed.equals(original)).toBe(true);
    expect(parsed.systemName).toBe('demo');
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.port).toBe(9001);
  });

  test('parse rejects strings without @', () => {
    expect(() => NodeAddress.parse('localhost:9001')).toThrow(/Invalid node address/);
  });

  test('parse rejects strings without : after @', () => {
    expect(() => NodeAddress.parse('demo@localhost')).toThrow(/Invalid node address/);
  });

  test('parse rejects non-numeric port', () => {
    expect(() => NodeAddress.parse('demo@host:abc')).toThrow(/Invalid port/);
  });

  test('parse handles system names containing dashes and digits', () => {
    const parsed = NodeAddress.parse('my-sys-2@host.example.com:1234');
    expect(parsed.systemName).toBe('my-sys-2');
    expect(parsed.host).toBe('host.example.com');
    expect(parsed.port).toBe(1234);
  });

  test('parse picks the LAST colon as the port separator (IPv6-friendly hosts)', () => {
    // Host may contain colons (though bracketed IPv6 isn't supported here) —
    // verify the splitter uses the last colon only.
    const parsed = NodeAddress.parse('demo@weird:host:42');
    expect(parsed.host).toBe('weird:host');
    expect(parsed.port).toBe(42);
  });

  test('equals compares all three fields', () => {
    const addressA = new NodeAddress('s', 'h', 1);
    expect(addressA.equals(new NodeAddress('s', 'h', 1))).toBe(true);
    expect(addressA.equals(new NodeAddress('t', 'h', 1))).toBe(false);
    expect(addressA.equals(new NodeAddress('s', 'g', 1))).toBe(false);
    expect(addressA.equals(new NodeAddress('s', 'h', 2))).toBe(false);
  });

  test('compareTo orders lexicographically on the string form', () => {
    const addressA = new NodeAddress('sys', 'host', 1);
    const addressB = new NodeAddress('sys', 'host', 2);
    const addressC = new NodeAddress('sys', 'zzz', 1);
    expect(addressA.compareTo(addressB)).toBeLessThan(0);
    expect(addressB.compareTo(addressA)).toBeGreaterThan(0);
    expect(addressA.compareTo(addressA)).toBe(0);
    expect(addressA.compareTo(addressC)).toBeLessThan(0);
  });

  test('compareTo is consistent with toString', () => {
    const xs = [
      new NodeAddress('z', 'a', 1),
      new NodeAddress('a', 'b', 2),
      new NodeAddress('a', 'b', 1),
    ];
    const sorted = [...xs].sort((x, y) => x.compareTo(y));
    expect(sorted.map(s => s.toString())).toEqual([
      'a@b:1', 'a@b:2', 'z@a:1',
    ]);
  });

  test('toJSON + fromJSON round-trip', () => {
    const addressA = new NodeAddress('demo', 'host', 5555);
    const data = addressA.toJSON();
    expect(data).toEqual({ systemName: 'demo', host: 'host', port: 5555 });
    expect(NodeAddress.fromJSON(data).equals(addressA)).toBe(true);
  });
});

describe('NodeAddress.fromJSON — the wire cannot keep the declared type (#571)', () => {
  test('rejects a port that arrived as a string', () => {
    // Why this one matters more than it looks: `toString()` renders `"2552"`
    // and `2552` identically, so the bad address keys every map exactly like
    // the good one — but `equals()` compares `===` and never matches. A node
    // that merges its own address back in this shape stops recognising itself,
    // and nothing ever repairs it.
    expect(() => NodeAddress.fromJSON({ systemName: 'app', host: 'h', port: '2552' as unknown as number }))
      .toThrow(/Invalid node address/);
  });

  test('rejects missing, empty and non-string identity fields', () => {
    expect(() => NodeAddress.fromJSON({ systemName: 'app', host: '', port: 1 })).toThrow(/Invalid node address/);
    expect(() => NodeAddress.fromJSON({ host: 'h', port: 1 } as unknown as never)).toThrow(/Invalid node address/);
    expect(() => NodeAddress.fromJSON(null as unknown as never)).toThrow(/Invalid node address/);
  });

  test('rejects non-integer and non-positive ports', () => {
    for (const port of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => NodeAddress.fromJSON({ systemName: 'app', host: 'h', port }))
        .toThrow(/Invalid node address/);
    }
  });

  test('accepts a synthetic port above the TCP range', () => {
    // Deliberate, and stated the same way by ClusterOptionsValidator: under
    // InMemoryTransport the port is a node discriminator, not something anyone
    // dials. Capping at 65535 here would reject addresses the framework mints.
    expect(NodeAddress.fromJSON({ systemName: 'app', host: 'h', port: 89_001 }).port).toBe(89_001);
  });

  test('round-trips a well-formed address', () => {
    const original = new NodeAddress('demo', '10.0.0.1', 2552);
    expect(NodeAddress.fromJSON(original.toJSON()).equals(original)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* One port rule, and the string form it has to survive (#1515)              */
/* ------------------------------------------------------------------------ */

/**
 * `isPort` is the rule both the wire guard and {@link NodeAddress.fromJSON}
 * spend, and what it has to be is decided by {@link NodeAddress.toString}.
 *
 * A "positive integer" is not enough, because `toString` is not injective over
 * one: `(1e21).toString()` is `'1e+21'`, and `parse` reads that back with
 * `parseInt`, which stops at the `e` and yields port **1**.  So an address the
 * old rule admitted could be recorded under one string and come back as a
 * different node — and `peers()` feeds `transportReachesCluster`, which
 * compares those strings.
 */
describe('NodeAddress.isPort — one rule for the wire and the string form (#1515)', () => {
  test('the guard and fromJSON answer the same for every case', () => {
    // The claim `MessageChannelTransport.onFrame` makes in prose — "once the
    // envelope guard passes, `fromJSON` cannot throw" — as an assertion.  Two
    // copies of a rule are a rule that can drift; this is the test that notices.
    for (const port of [1, 89_001, 65_535, 0, -1, 1.5, NaN, Infinity, 1e21, 2 ** 53, -0]) {
      expect(isNodeAddressData({ systemName: 'app', host: 'h', port }))
        .toBe(NodeAddress.isPort(port));
    }
  });

  test('refuses a port that renders in exponent notation', () => {
    // 1e21 is where `Number.prototype.toString` switches to exponent form, and
    // it is reachable off the wire: a schema-valid heartbeat under
    // `from.port = 1e21` was delivered, recorded as `sys@host:1e+21`, and
    // listed by `peers()` as `sys@host:1`.
    expect(NodeAddress.isPort(1e21)).toBe(false);
    expect(isNodeAddressData({ systemName: 'app', host: 'h', port: 1e21 })).toBe(false);
    expect(() => NodeAddress.fromJSON({ systemName: 'app', host: 'h', port: 1e21 }))
      .toThrow(/Invalid node address/);
  });

  test('refuses a port past the safe-integer range', () => {
    // `2 ** 53` renders in plain decimal, so it survives `parse` — and is still
    // refused, because past this point a double no longer separates adjacent
    // integers: `2 ** 53` and `2 ** 53 + 1` are one value, so two peers that
    // wrote different ports would compare `equals`.
    expect(NodeAddress.isPort(2 ** 53)).toBe(false);
    expect(isNodeAddressData({ systemName: 'app', host: 'h', port: 2 ** 53 })).toBe(false);
    expect(() => NodeAddress.fromJSON({ systemName: 'app', host: 'h', port: 2 ** 53 }))
      .toThrow(/Invalid node address/);
  });

  test('still admits the synthetic ports the framework itself mints', () => {
    for (const port of [1, 2, 2552, 65_535, 89_001, Number.MAX_SAFE_INTEGER]) {
      expect(NodeAddress.isPort(port)).toBe(true);
      expect(NodeAddress.fromJSON({ systemName: 'app', host: 'h', port }).port).toBe(port);
    }
  });

  test('the counterexample the property shrank to, as an example (#1515)', () => {
    // fast-check, seed 1424: `6.96e+23` was admitted, rendered
    // `app@h:6.96e+23`, and came back from `parse` as port 6.  Kept here
    // because the property explores a pinned seed and this case is the one that
    // actually happened — see `tests/setup/property-seed.ts`.
    expect(NodeAddress.isPort(6.96e23)).toBe(false);
    expect(() => NodeAddress.fromJSON({ systemName: 'app', host: 'h', port: 6.96e23 }))
      .toThrow(/Invalid node address/);
    expect(NodeAddress.parse(new NodeAddress('app', 'h', 6.96e23).toString()).port).toBe(6);
  });

  /**
   * The law the two examples above are instances of: **an address `fromJSON`
   * admits survives its own string form.**  Stated over the admitted set rather
   * than over the generator, so tightening the rule moves a case from "must
   * round-trip" to "never built" instead of leaving the property vacuous.
   *
   * The pool is deliberately not just `fc.integer`: safe integers alone cannot
   * fail this, and the whole defect lives above them.  The second arm mints
   * exponent-notation integers, which is what a hostile `from` carries.
   */
  test('every port fromJSON admits round-trips through toString/parse', () => {
    const portCandidate = fc.oneof(
      fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
      fc.integer({ min: 1, max: 1_000 }).map((n) => n * 1e21),
    );
    fc.assert(fc.property(portCandidate, (port) => {
      let address: NodeAddress;
      try {
        address = NodeAddress.fromJSON({ systemName: 'app', host: 'h', port });
      } catch {
        return true; // refused off the wire — the law says nothing about it
      }
      return NodeAddress.parse(address.toString()).equals(address);
    }));
  });
});
