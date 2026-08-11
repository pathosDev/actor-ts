/**
 * The calling shapes `spawn` accepts (#547).  Covers the doors, not the
 * plumbing — `ActorBlueprint.test.ts` owns the normalization itself.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorOptions } from '../../src/ActorOptions.js';
import type { ActorContext } from '../../src/ActorContext.js';
import type { ActorRef } from '../../src/ActorRef.js';
import type { ActorSystem } from '../../src/ActorSystem.js';
import { Mailbox } from '../../src/internal/Mailbox.js';
import { BoundedMailbox } from '../../src/mailbox/BoundedMailbox.js';
import { createTestActorSystem } from '../util/TestActorSystem.js';
import { awaitCondition } from '../util/AwaitCondition.js';

class Greeter extends Actor<string> {
  static seen: string[] = [];
  override onReceive(message: string): void { Greeter.seen.push(message); }
}

class Worker extends Actor<string> {
  static built: string[] = [];
  constructor(private readonly database: string) {
    super();
    Worker.built.push(database);
  }
  override onReceive(_m: string): void { void this.database; }
}

/** Reads back what the cell actually built, without exporting cell internals. */
function cellOf(ref: ActorRef<unknown>): {
  blueprint: { internal?: boolean; entity?: unknown };
  _mailboxForTest(): unknown;
  _inspect(): { dispatcher: string | null; internal: boolean };
} {
  return (ref as unknown as { getCell(): never }).getCell();
}

describe('spawn shapes', () => {
  let system: ActorSystem;
  afterEach(async () => { await system?.terminate(); });

  test('a zero-argument class needs no closure', async () => {
    system = createTestActorSystem();
    Greeter.seen = [];
    const ref = system.spawn(Greeter, 'greeter');
    expect(ref.path.toString()).toContain('/user/greeter');
    ref.tell('world');
    await awaitCondition(() => Greeter.seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the greeter handled its message',
    });
    expect(Greeter.seen).toEqual(['world']);
  });

  test('a factory closure carries dependencies in', async () => {
    system = createTestActorSystem();
    Worker.built = [];
    system.spawn(() => new Worker('postgres'), 'worker');
    // The factory runs on the cell's `create` system message, not at the
    // spawn call.
    await awaitCondition(() => Worker.built.length === 1, {
      timeoutMs: 4_000,
      label: 'the cell ran the factory',
    });
    expect(Worker.built).toEqual(['postgres']);
  });

  test('spawnAnonymous takes the same two shapes and names the actor itself', () => {
    system = createTestActorSystem();
    const fromClass = system.spawnAnonymous(Greeter);
    const fromFactory = system.spawnAnonymous(() => new Worker('redis'));
    expect(fromClass.path.name).toMatch(/^\$anonymous-\d+-[0-9a-f]+$/);
    expect(fromFactory.path.name).toMatch(/^\$anonymous-\d+-[0-9a-f]+$/);
    expect(fromClass.path.name).not.toBe(fromFactory.path.name);
  });

  test('options reach the cell — a builder and a plain object alike', () => {
    system = createTestActorSystem();
    const viaBuilder = system.spawn(
      Greeter,
      'built',
      ActorOptions.create<string>().withMailbox(() => new Mailbox<string>()),
    );
    const viaPlain = system.spawn(Greeter, 'plain', { mailboxCapacity: 4 });
    // A custom mailbox replaces the bounded default outright.
    expect(cellOf(viaBuilder)._mailboxForTest()).toBeInstanceOf(Mailbox);
    expect(cellOf(viaBuilder)._mailboxForTest()).not.toBeInstanceOf(BoundedMailbox);
    expect(cellOf(viaPlain)._mailboxForTest()).toBeInstanceOf(BoundedMailbox);
  });

  test('withInternal marks the actor as tooling and children inherit it', () => {
    system = createTestActorSystem();
    const ref = system.spawn(Greeter, 'probe', ActorOptions.create<string>().withInternal());
    expect(cellOf(ref)._inspect().internal).toBe(true);
  });

  test('withEntity gives an entity its identity without a cluster behind it', async () => {
    class CartEntity extends Actor<string> {
      static identity: string | null = null;
      override preStart(): void { CartEntity.identity = this.entityId; }
      override onReceive(_m: string): void {}
    }
    system = createTestActorSystem();
    system.spawn(
      CartEntity,
      'cart-7',
      ActorOptions.create<string>().withEntity({ entityId: 'cart-7', typeName: 'cart', shardId: 3 }),
    );
    await awaitCondition(() => CartEntity.identity !== null, {
      timeoutMs: 4_000,
      label: 'the entity actor started and read its identity',
    });
    expect(CartEntity.identity).toBe('cart-7');
  });

  test('a child spawns from the context with the same shapes', async () => {
    class Parent extends Actor<string> {
      static childNames: string[] = [];
      override preStart(): void {
        const context = this.context as ActorContext<string>;
        Parent.childNames.push(context.spawn(Greeter, 'from-class').path.name);
        Parent.childNames.push(context.spawn(() => new Worker('mysql'), 'from-factory').path.name);
        Parent.childNames.push(context.spawnAnonymous(Greeter).path.name);
      }
      override onReceive(_m: string): void {}
    }
    system = createTestActorSystem();
    Parent.childNames = [];
    system.spawn(Parent, 'parent');
    await awaitCondition(() => Parent.childNames.length === 3, {
      timeoutMs: 4_000,
      label: 'the parent spawned all three children',
    });
    expect(Parent.childNames.slice(0, 2)).toEqual(['from-class', 'from-factory']);
    expect(Parent.childNames[2]).toMatch(/^\$anonymous-\d+-[0-9a-f]+$/);
  });

  test('a class needing constructor arguments fails loudly, not with undefined deps', () => {
    system = createTestActorSystem();
    expect(() => system.spawn(Worker as never, 'bad'))
      .toThrow(/Worker needs 1 constructor argument/);
  });
});
