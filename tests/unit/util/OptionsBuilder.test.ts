import { describe, expect, test } from 'bun:test';
import { OptionsBuilder } from '../../../src/util/OptionsBuilder.js';

interface Foo {
  readonly a?: number;
  readonly b?: string;
  readonly c?: boolean;
}

class FooOptions extends OptionsBuilder<Foo> {
  static create(): FooOptions {
    return new FooOptions();
  }
  withA(a: number): this {
    return this.set('a', a);
  }
  withB(b: string): this {
    return this.set('b', b);
  }
}

/** A second level, mirroring OptionsBuilder → BrokerOptions → MqttOptions. */
abstract class BarOptions<T extends Foo> extends OptionsBuilder<T> {
  withA(a: number): this {
    return this.set('a' as keyof T, a as T[keyof T]);
  }
}
class BazOptions extends BarOptions<Foo> {
  static create(): BazOptions {
    return new BazOptions();
  }
  withB(b: string): this {
    return this.set('b', b);
  }
}

describe('OptionsBuilder base', () => {
  test('build() returns only the fields that were set', () => {
    expect(FooOptions.create().withA(1).build()).toEqual({ a: 1 });
  });

  test('chaining returns the concrete builder type', () => {
    const b = FooOptions.create().withA(1).withB('x');
    expect(b).toBeInstanceOf(FooOptions);
    expect(b.build()).toEqual({ a: 1, b: 'x' });
  });

  test('build() is an independent snapshot (later mutation does not change it)', () => {
    const b = FooOptions.create().withA(1);
    const snap = b.build();
    b.withA(2).withB('later');
    expect(snap).toEqual({ a: 1 });
  });

  test('a later withX overrides an earlier one', () => {
    expect(FooOptions.create().withA(1).withA(2).build()).toEqual({ a: 2 });
  });

  test('chaining across inheritance levels stays the concrete type', () => {
    // withA is defined on the intermediate base, withB on the concrete —
    // the chain must remain BazOptions throughout (mirrors
    // MqttOptions.create().withCircuitBreaker(...).withBrokerUrl(...)).
    const b = BazOptions.create().withA(1).withB('x');
    expect(b).toBeInstanceOf(BazOptions);
    expect(b.build()).toEqual({ a: 1, b: 'x' });
  });
});

describe('a builder IS a settings object (structural)', () => {
  // A consumer accepts `XOptions | Partial<XSettings>` and reads the argument
  // directly — a builder and a plain object are interchangeable, no resolve step.
  function readSettings(options: FooOptions | Partial<Foo>): Partial<Foo> {
    return { ...(options as Partial<Foo>) };
  }

  test('spreading a builder yields ONLY the set fields (methods stay on the prototype)', () => {
    const spread = { ...(FooOptions.create().withA(1).withB('x') as Partial<Foo>) };
    expect(spread).toEqual({ a: 1, b: 'x' });
    expect(Object.keys(spread).sort()).toEqual(['a', 'b']);
  });

  test('a builder and the equivalent plain object are read identically by a consumer', () => {
    const fromBuilder = readSettings(FooOptions.create().withA(1).withB('x'));
    const fromPlain = readSettings({ a: 1, b: 'x' });
    expect(fromBuilder).toEqual(fromPlain);
    expect(fromBuilder).toEqual({ a: 1, b: 'x' });
  });

  test('a builder serializes to just its fields (no withX/build leakage)', () => {
    const b = FooOptions.create().withA(1).withB('x');
    expect(JSON.parse(JSON.stringify(b))).toEqual({ a: 1, b: 'x' });
  });

  test('an empty builder reads as {}', () => {
    expect(readSettings(FooOptions.create())).toEqual({});
    expect(readSettings({})).toEqual({});
  });

  test('reading does not require the fields to exist (unset fields are absent)', () => {
    const b = FooOptions.create().withA(1);
    expect(readSettings(b)).toEqual({ a: 1 });
    expect('b' in readSettings(b)).toBe(false);
  });
});
