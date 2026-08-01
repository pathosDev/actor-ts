import { describe, expect, test } from 'bun:test';
import {
  describeMessagePayload,
  describeMessageType,
} from '../../src/internal/Instrumentation.js';

class PlaceOrder {
  constructor(readonly id: string) {}
}
class TaggedCommand {
  readonly kind = 'deposit';
}

describe('describeMessageType', () => {
  test('names an object literal by its discriminant, not "Object"', () => {
    // The house convention is a `kind`-tagged union of object literals,
    // so `constructor.name` answers "Object" for almost every message.
    expect(describeMessageType({ kind: 'place-order', id: 7 })).toBe('place-order');
  });

  test('keeps a class name', () => {
    expect(describeMessageType(new PlaceOrder('7'))).toBe('PlaceOrder');
  });

  test('shows both when a class also carries a discriminant', () => {
    expect(describeMessageType(new TaggedCommand())).toBe('TaggedCommand.deposit');
  });

  test('ignores a non-string or empty discriminant', () => {
    expect(describeMessageType({ kind: 42 })).toBe('Object');
    expect(describeMessageType({ kind: '' })).toBe('Object');
  });

  test('keeps the previous names for primitives and nullish values', () => {
    expect(describeMessageType('hello')).toBe('String');
    expect(describeMessageType(7)).toBe('Number');
    expect(describeMessageType(null)).toBe('object');
    expect(describeMessageType(undefined)).toBe('undefined');
  });
});

describe('describeMessagePayload', () => {
  test('renders a message as compact JSON', () => {
    expect(describeMessagePayload({ kind: 'place', id: 7 })).toBe('{"kind":"place","id":7}');
  });

  test('survives a cycle instead of throwing into the dispatch path', () => {
    const message: Record<string, unknown> = { kind: 'loop' };
    message.self = message;
    const json = describeMessagePayload(message);
    expect(json).toContain('[Circular]');
  });

  test('carries what JSON cannot', () => {
    const json = describeMessagePayload({ big: 10n, run: function named() {} });
    expect(json).toContain('10n');
    expect(json).toContain('[Function named]');
  });

  test('stops descending rather than serialising an arbitrarily deep graph', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    expect(describeMessagePayload(deep)).toContain('[…]');
  });

  test('truncates instead of putting an unbounded string on the wire', () => {
    const json = describeMessagePayload({ blob: 'x'.repeat(5_000) })!;
    expect(json.length).toBeLessThan(2_100);
    expect(json.endsWith('(truncated)')).toBe(true);
  });

  test('is null for a value JSON has no representation for', () => {
    expect(describeMessagePayload(undefined)).toBeNull();
  });
});
