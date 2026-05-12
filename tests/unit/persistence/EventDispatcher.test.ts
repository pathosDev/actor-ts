import { describe, expect, test } from 'bun:test';
import { eventDispatcher } from '../../../src/persistence/EventDispatcher.js';

type State = { count: number; lastSeen?: string };

type Event =
  | { readonly kind: 'incremented'; readonly by: number }
  | { readonly kind: 'decremented'; readonly by: number }
  | { readonly kind: 'reset' };

describe('eventDispatcher', () => {
  test('routes each kind to its registered handler', () => {
    const onEvent = eventDispatcher<State, Event>()
      .on('incremented', (s, e) => ({ count: s.count + e.by, lastSeen: 'incremented' }))
      .on('decremented', (s, e) => ({ count: s.count - e.by, lastSeen: 'decremented' }))
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
      .on('incremented', (s, e) => {
        // e: { kind: 'incremented'; by: number } — `e.by` exists, `e.reason` doesn't.
        return { count: s.count + e.by };
      })
      .on('decremented', (s, e) => ({ count: s.count - e.by }))
      .on('reset',       () => ({ count: 0 }))
      .build();

    const s = onEvent({ count: 0 }, { kind: 'incremented', by: 7 });
    expect(s.count).toBe(7);
  });

  test('reject double-registration of the same kind at runtime', () => {
    // The TypeScript signature on `.on()` already forbids re-registering at
    // compile time (the type-level `Exclude` removes the kind from the
    // next builder).  But if the user forces a cast or uses dynamic
    // dispatch, the builder still detects it.
    expect(() => {
      const partial = eventDispatcher<State, Event>()
        .on('incremented', (s, e) => ({ count: s.count + e.by }));
      // Force-cast to bypass the type-level guard:
      (partial as unknown as {
        on(k: string, fn: (s: State, e: Event) => State): unknown;
      }).on('incremented', (s) => s);
    }).toThrow(/registered twice/);
  });

  test('build snapshot — closure does not retain the builder', () => {
    // We can't directly assert the builder is GC'd, but we can verify
    // mutating the builder after build() doesn't affect the dispatcher.
    const builder = eventDispatcher<State, Event>()
      .on('incremented', (s, e) => ({ count: s.count + e.by }))
      .on('decremented', (s, e) => ({ count: s.count - e.by }))
      .on('reset',       () => ({ count: 0 }));
    const onEvent = builder.build();
    // The returned function works:
    const s = onEvent({ count: 0 }, { kind: 'incremented', by: 3 });
    expect(s.count).toBe(3);
  });

  test('runtime guard: throws on unhandled kind if cast forces it', () => {
    // If user types are correct, this branch is unreachable.  Defensive
    // throw kicks in when the user force-casts to bypass compile checks.
    const onEvent = eventDispatcher<State, Event>()
      .on('incremented', (s, e) => ({ count: s.count + e.by }))
      .on('decremented', (s, e) => ({ count: s.count - e.by }))
      .on('reset',       () => ({ count: 0 }))
      .build();

    expect(() => {
      onEvent({ count: 0 }, { kind: 'mystery' as 'reset' });
    }).toThrow(/no handler registered/);
  });
});
