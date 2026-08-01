import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import {
  SingletonKey,
  singletonKeyOf,
} from '../../../src/cluster/singleton/SingletonKey.js';
import { ShardKey, shardKeyOf } from '../../../src/cluster/sharding/ShardKey.js';

type Command = { readonly kind: 'ping'; readonly id: string };

describe('SingletonKey', () => {
  test('carries the typeName and renders it', () => {
    const key = SingletonKey.of<Command>('job-scheduler');
    expect(key.typeName).toBe('job-scheduler');
    expect(key.toString()).toBe('SingletonKey(job-scheduler)');
  });

  test('equality is by typeName alone', () => {
    expect(SingletonKey.of('a').equals(SingletonKey.of('a'))).toBe(true);
    expect(SingletonKey.of('a').equals(SingletonKey.of('b'))).toBe(false);
  });

  test('singletonKeyOf accepts a key, a declaring class, or a bare typeName', () => {
    const key = SingletonKey.of<Command>('scheduler');
    class Declaring extends Actor<Command> {
      static readonly singleton = key;
      override onReceive(): void {}
    }

    expect(singletonKeyOf(key)).toBe(key);
    expect(singletonKeyOf(Declaring)).toBe(key);
    expect(singletonKeyOf<Command>('scheduler').typeName).toBe('scheduler');
  });
});

describe('ShardKey', () => {
  test('carries the typeName and the entity-id extractor', () => {
    const key = ShardKey.of<Command>('user', (command) => command.id);
    expect(key.typeName).toBe('user');
    expect(key.extractEntityId?.({ kind: 'ping', id: 'u-1' })).toBe('u-1');
    expect(key.toString()).toBe('ShardKey(user)');
  });

  test('the extractor is not part of the identity', () => {
    // A lookup-only node names the same type without ever supplying an
    // extractor, so two keys that differ only there must still compare equal.
    const declaring = ShardKey.of<Command>('user', (command) => command.id);
    const lookup = ShardKey.of<Command>('user');
    expect(declaring.equals(lookup)).toBe(true);
    expect(lookup.extractEntityId).toBeUndefined();
  });

  test('shardKeyOf accepts a key, a declaring class, or a bare typeName', () => {
    const key = ShardKey.of<Command>('user', (command) => command.id);
    class Declaring extends Actor<Command> {
      static readonly shard = key;
      override onReceive(): void {}
    }

    expect(shardKeyOf(key)).toBe(key);
    expect(shardKeyOf(Declaring)).toBe(key);
    expect(shardKeyOf<Command>('user').typeName).toBe('user');
  });
});
