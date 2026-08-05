import { describe, expect, test } from 'bun:test';
import { entityName } from '../../../../src/cluster/sharding/Shard.js';

// Built rather than written literally, so this source file stays free of
// the control characters it is about.
const NUL = String.fromCharCode(0);
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001F\\u007F]');

// #568 — the child name used to be a lossy fold of the entity id, so two
// distinct ids could claim one name.  When they also hashed into the same
// shard, the second one missed the shard's id-keyed map, spawned a child
// under a name already taken, and `_createChild` threw — killing the Shard
// actor and every unrelated entity living under it.
describe('entityName', () => {
  test('leaves an ordinary id readable', () => {
    // The escape must not tax the common case: these are what shows up in
    // the DevTools tree and in log lines.
    expect(entityName('user-42')).toBe('entity-user-42');
    expect(entityName('a.b@x.com')).toBe('entity-a.b@x.com');
    expect(entityName('tenant:eu')).toBe('entity-tenant:eu');
    expect(entityName('order_7')).toBe('entity-order_7');
  });

  test('escapes what an actor name cannot carry', () => {
    // A path separator would split the segment; a control character is
    // rejected outright by ActorPath.
    expect(entityName('a/b')).toBe('entity-a~002Fb');
    expect(entityName('a\\b')).toBe('entity-a~005Cb');
    expect(entityName(`a${NUL}b`)).toBe('entity-a~0000b');
  });

  test('escapes the escape character, so the encoding stays unambiguous', () => {
    // Without this, the id `a~002Fb` and the id `a/b` would share a name.
    expect(entityName('a~b')).toBe('entity-a~007Eb');
    expect(entityName('a~002Fb')).not.toBe(entityName('a/b'));
  });

  test('the exact pairs from the report no longer collide', () => {
    expect(entityName('user!31')).not.toBe(entityName('user#31'));
    // Not only adversarial — these are ordinary addresses.
    expect(entityName('a.b@x.com')).not.toBe(entityName('a-b@x.com'));
  });

  test('is injective across a corpus the old fold collapsed', () => {
    const punctuation = [
      '!', '#', '$', '%', '&', "'", '(', ')', '*', ',', ';',
      '=', '?', '[', ']', '/', '\\', '~', ' ', '"',
    ];
    const ids = [
      // Every single-punctuation variant of one stem: the old fold mapped
      // all of these to `entity-user_31`.
      ...punctuation.map((p) => `user${p}31`),
      // Literal-set members, which must stay distinct from each other too.
      ...['.', '@', ':', '+', '-', '_'].map((p) => `user${p}31`),
      // And the escaped renderings themselves, as ids — the case that makes
      // escaping the escape character necessary.
      ...punctuation.map((p) => `user~${p.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}31`),
    ];

    const names = ids.map(entityName);
    expect(new Set(names).size).toBe(ids.length);
  });

  test('is total — a lone surrogate does not throw', () => {
    // `encodeURIComponent` raises URIError here.  A throw would land inside
    // Shard.createEntity, which is exactly the failure this fix removes, so
    // the escape works per UTF-16 code unit instead.
    expect(() => entityName('\uD800')).not.toThrow();
    expect(entityName('\uD800')).toBe('entity-~D800');
    expect(entityName('\uD800')).not.toBe(entityName('\uDC00'));
  });

  test('produces a name ActorPath accepts', () => {
    const hostile = ['a/b', 'a\\b', '.', '..', '', `a${NUL}b`, '\uD800', '../../etc'];
    for (const id of hostile) {
      const name = entityName(id);
      expect(name.includes('/')).toBe(false);
      expect(name.includes('\\')).toBe(false);
      expect(name).not.toBe('.');
      expect(name).not.toBe('..');
      expect(name.length).toBeGreaterThan(0);
      expect(CONTROL_CHARACTERS.test(name)).toBe(false);
    }
  });
});
