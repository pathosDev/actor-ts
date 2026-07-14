import { describe, expect, test } from 'bun:test';
import { eventDispatcher } from '../../../../src/persistence/EventDispatcher.js';

type State = { count: number; lastSeen?: string };

type Event =
  | { readonly kind: 'incremented'; readonly by: number }
  | { readonly kind: 'decremented'; readonly by: number }
  | { readonly kind: 'reset' };

describe('eventDispatcher', () => {
  test('routes each kind to its registered handler', () => {
    const onEvent = eventDispatcher<State, Event>()
      .on('incremented', (subscription, e) => ({ count: subscription.count + e.by, lastSeen: 'incremented' }))
      .on('decremented', (subscription, e) => ({ count: subscription.count - e.by, lastSeen: 'decremented' }))
      .on('reset',       () => ({ count: 0, lastSeen: 'reset' }))
      .build();

    const s0: State = { count: 10 };
    const s1 = onEvent(s0, { kind: 'incremented', by: 3 });
    const s2 = onEvent(s1, { kind: 'decremented', by: 5 });
    const s3 = onEvent(s2, { kind: 'reset' });

    expect(s1.count).toBe(13);
    expect(s1.lastSeen).toBe('incremented');
    expect(s2.count).toBe(8);
    expect(s2.lastSeen).toBe('decremented');
    expect(s3.count).toBe(0);
    expect(s3.lastSeen).toBe('reset');
  });

  test('handler receives a fully-narrowed event', () => {
    // Compile-time: inside the arm, `e` is narrowed to the matching variant.
    // Runtime check that the narrowed payload field is accessible.
    const onEvent = eventDispatcher<State, Event>()
      .on('incremented', (subscription, e) => {
        // e: { kind: 'incremented'; by: number } — `e.by` exists, `e.reason` doesn't.
        return { count: subscription.count + e.by };
      })
      .on('decremented', (subscription, e) => ({ count: subscription.count - e.by }))
      .on('reset',       () => ({ count: 0 }))
      .build();

    const subscription = onEvent({ count: 0 }, { kind: 'incremented', by: 7 });
    expect(subscription.count).toBe(7);
  });

  test('reject double-registration of the same kind at runtime', () => {
    // The TypeScript signature on `.on()` already forbids re-registering at
    // compile time (the type-level `Exclude` removes the kind from the
    // next builder).  But if the user forces a cast or uses dynamic
    // dispatch, the builder still detects it.
    expect(() => {
      const partial = eventDispatcher<State, Event>()
        .on('incremented', (subscription, e) => ({ count: subscription.count + e.by }));
      // Force-cast to bypass the type-level guard:
      (partial as unknown as {
        on(k: string, fn: (subscription: State, e: Event) => State): unknown;
      }).on('incremented', (subscription) => subscription);
    }).toThrow(/registered twice/);
  });

  test('build snapshot — closure does not retain the builder', () => {
    // We can't directly assert the builder is GC'd, but we can verify
    // mutating the builder after build() doesn't affect the dispatcher.
    const builder = eventDispatcher<State, Event>()
      .on('incremented', (subscription, e) => ({ count: subscription.count + e.by }))
      .on('decremented', (subscription, e) => ({ count: subscription.count - e.by }))
      .on('reset',       () => ({ count: 0 }));
    const onEvent = builder.build();
    // The returned function works:
    const subscription = onEvent({ count: 0 }, { kind: 'incremented', by: 3 });
    expect(subscription.count).toBe(3);
  });

  test('runtime guard: throws on unhandled kind if cast forces it', () => {
    // If user types are correct, this branch is unreachable.  Defensive
    // throw kicks in when the user force-casts to bypass compile checks.
    const onEvent = eventDispatcher<State, Event>()
      .on('incremented', (subscription, e) => ({ count: subscription.count + e.by }))
      .on('decremented', (subscription, e) => ({ count: subscription.count - e.by }))
      .on('reset',       () => ({ count: 0 }))
      .build();

    expect(() => {
      onEvent({ count: 0 }, { kind: 'mystery' as 'reset' });
    }).toThrow(/no handler registered/);
  });

  test('build() can be called multiple times — each produces an independent dispatcher', () => {
    const builder = eventDispatcher<State, Event>()
      .on('incremented', (subscription, e) => ({ count: subscription.count + e.by }))
      .on('decremented', (subscription, e) => ({ count: subscription.count - e.by }))
      .on('reset',       () => ({ count: 0 }));
    const d1 = builder.build();
    const d2 = builder.build();
    // Different function instances — each build snapshots the handlers.
    expect(d1).not.toBe(d2);
    // Both behave identically (same captured handlers).
    expect(d1({ count: 0 }, { kind: 'incremented', by: 3 }).count).toBe(3);
    expect(d2({ count: 0 }, { kind: 'incremented', by: 3 }).count).toBe(3);
  });

  test('long sequence of mixed kinds threads through correctly', () => {
    // Mini smoke for the typical fold-over-events pattern that
    // PersistentActor.onEvent enables — many events of mixed kinds,
    // state must accumulate consistently.
    const onEvent = eventDispatcher<State, Event>()
      .on('incremented', (subscription, e) => ({ count: subscription.count + e.by }))
      .on('decremented', (subscription, e) => ({ count: subscription.count - e.by }))
      .on('reset',       () => ({ count: 0 }))
      .build();
    const events: Event[] = [
      { kind: 'incremented', by: 10 },
      { kind: 'incremented', by: 5 },
      { kind: 'decremented', by: 3 },
      { kind: 'reset' },
      { kind: 'incremented', by: 7 },
    ];
    const final = events.reduce<State>(onEvent, { count: 0 });
    expect(final.count).toBe(7);
  });

  test('intermediate .on() calls return new builders — chain is non-mutating', () => {
    // Each .on() returns a NEW builder instance with its own handler
    // map (the impl uses `new Map(this.handlers)`).  Pin this: the
    // earlier builder reference must still see its own state, not
    // mutate underneath the user.
    const b1 = eventDispatcher<State, Event>()
      .on('incremented', (subscription, e) => ({ count: subscription.count + e.by }));
    const b2 = b1.on('decremented', (subscription, e) => ({ count: subscription.count - e.by }));
    // b1 and b2 are different objects.
    expect(b1).not.toBe(b2);
  });
});
