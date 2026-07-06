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
