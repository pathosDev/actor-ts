import { describe, expect, test } from 'bun:test';
import { JsonSerializer } from '../../../src/serialization/JsonSerializer.js';

const json = new JsonSerializer();

// SECURITY_AUDIT.md #9 — a hostile payload with a `__proto__` key must
// round-trip as plain own data and never alter a prototype.  Before the fix
// `out.__proto__ = …` went through the prototype setter, changing the decoded
// object's [[Prototype]].
describe('JsonSerializer — __proto__ hardening (#9)', () => {
  test('a "__proto__" key decodes as own data; the object prototype is untouched', () => {
    const bytes = new TextEncoder().encode('{"__proto__":{"polluted":true},"x":1}');
    const out = json.fromBinary(bytes, '') as Record<string, unknown>;

    // Decoded object keeps the normal Object prototype (not the injected one).
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    // The key survives as an own data property.
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(out['x']).toBe(1);
    // Global prototype is clean.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('nested "__proto__" keys are also inert', () => {
    const bytes = new TextEncoder().encode('{"a":{"__proto__":{"y":9}}}');
    const out = json.fromBinary(bytes, '') as { a: Record<string, unknown> };
    expect(Object.getPrototypeOf(out.a)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['y']).toBeUndefined();
  });
});
