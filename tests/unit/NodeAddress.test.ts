import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';

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
