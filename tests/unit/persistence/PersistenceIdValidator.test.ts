import { describe, expect, test } from 'bun:test';
import { MAX_PERSISTENCE_ID_LENGTH } from '../../../src/persistence/Constants.js';
import {
  assertStringPersistenceId,
  assertValidPersistenceId,
  persistenceIdRejection,
} from '../../../src/persistence/storage/PersistenceIdValidator.js';
import { canonicalPairId } from '../../../examples/chat/shared/directMessage.js';

/**
 * Control characters are built from their codepoints rather than written
 * as literals, for the reason the validator itself gives: a source file
 * carrying raw control bytes reads as binary to git, and an escape
 * sequence has to survive every tool that rewrites the file.
 */
const withControlCharacter = (code: number): string =>
  `account${String.fromCharCode(code)}42`;

describe('assertValidPersistenceId — what it accepts', () => {
  test('the shapes the documentation and the examples actually use', () => {
    for (const id of [
      'account-42',
      'order-1',
      'counter-1',
      'sharding-coordinator-Order',
      'cart-user-42',
      'a',
      'x'.repeat(MAX_PERSISTENCE_ID_LENGTH),
    ]) {
      expect(() => assertValidPersistenceId(id)).not.toThrow();
    }
  });

  test('a comma — the CSV column it would corrupt carries tags, not ids', () => {
    // `SqliteJournal` joins TAGS into one comma-separated column; the id is
    // a separate bound column, so the rule that rejects a comma belongs to
    // `assertValidTags` and would be pure superstition here.
    expect(() => assertValidPersistenceId('account,42')).not.toThrow();
  });

  test("a pipe — the repository's own chat example ships one", () => {
    // `OffsetStore` joins `<projection>|seq|<persistenceId>` with the id
    // LAST, so a pipe inside it cannot split off an extra field, and
    // nothing anywhere splits an id back apart.  Reading the id straight
    // out of the example is the point: banning `|` would have broken it.
    expect(canonicalPairId('bob', 'alice')).toBe('alice|bob');
    expect(() => assertValidPersistenceId(`dm-channel-${canonicalPairId('bob', 'alice')}`))
      .not.toThrow();
  });

  test('a space — legal in every key the id becomes', () => {
    expect(() => assertValidPersistenceId('account 42')).not.toThrow();
  });

  test('a dot inside the id — only a whole-id "." or ".." traverses', () => {
    expect(() => assertValidPersistenceId('order.v2-7')).not.toThrow();
    expect(() => assertValidPersistenceId('..leading-dots')).not.toThrow();
  });
});

describe('assertValidPersistenceId — what it rejects', () => {
  test('an empty id, which every backend would silently share', () => {
    expect(() => assertValidPersistenceId('')).toThrow(/non-empty string/);
  });

  test('one character past the persistence_id column width', () => {
    expect(() => assertValidPersistenceId('x'.repeat(MAX_PERSISTENCE_ID_LENGTH))).not.toThrow();
    expect(() => assertValidPersistenceId('x'.repeat(MAX_PERSISTENCE_ID_LENGTH + 1)))
      .toThrow(new RegExp(`at most ${MAX_PERSISTENCE_ID_LENGTH} characters`));
  });

  test('a path separator, which nests one object-storage stream inside another', () => {
    expect(() => assertValidPersistenceId('account/42')).toThrow(/path separator/);
    expect(() => assertValidPersistenceId('account\\42')).toThrow(/path separator/);
  });

  test('a whole-id traversal segment', () => {
    expect(() => assertValidPersistenceId('.')).toThrow(/must not be/);
    expect(() => assertValidPersistenceId('..')).toThrow(/must not be/);
  });

  test('control characters, which forge log lines on every recovery', () => {
    expect(() => assertValidPersistenceId('account\n42')).toThrow(/control characters/);
    expect(() => assertValidPersistenceId('account\t42')).toThrow(/control characters/);
    expect(() => assertValidPersistenceId(withControlCharacter(0x00))).toThrow(/control characters/);
    expect(() => assertValidPersistenceId(withControlCharacter(0x1f))).toThrow(/control characters/);
    expect(() => assertValidPersistenceId(withControlCharacter(0x7f))).toThrow(/control characters/);
  });

  test('the message quotes the id and names the origin that supplied it', () => {
    expect(() => assertValidPersistenceId('a/b', 'PersistentActor'))
      .toThrow(/Invalid persistenceId "a\/b" \(PersistentActor\)/);
  });
});

describe('persistenceIdRejection', () => {
  test('returns null for a valid id and a reason for an invalid one', () => {
    expect(persistenceIdRejection('account-42')).toBeNull();
    expect(persistenceIdRejection('a/b')).toMatch(/path separator/);
  });
});

/**
 * The read-side counterpart (#1507).  It moved here from `MongoJournal` when
 * the snapshot and durable-state stores turned out to carry the same hole; the
 * behavioural cases live beside those stores in
 * `MongoPersistenceIdGuard.test.ts`, and what this file pins is the contract
 * that makes one shared guard correct for all three.
 */
describe('assertStringPersistenceId — the read-side counterpart', () => {
  /** The cast is the premise: an id this function must refuse cannot be written in typed TypeScript. */
  const asRequestData = (value: unknown): string => value as string;

  test('a string passes, whatever the write-side rules would say about it', () => {
    // This is the whole reason the two are separate functions.  Every id here
    // is refused by `assertValidPersistenceId`, and every one of them must
    // stay readable and deletable: a stream written before #133 is not
    // reachable any other way.  Delegating this function to the full validator
    // would honour the letter of "guard the read path" and strand that data.
    const refusedByTheWriteSide = [
      'legacy/stream',
      'legacy\\stream',
      '',
      '.',
      '..',
      'x'.repeat(MAX_PERSISTENCE_ID_LENGTH + 1),
      withControlCharacter(0x00),
    ];
    for (const id of refusedByTheWriteSide) {
      // Each one really is a write-side rejection, so the case is not vacuous.
      expect(persistenceIdRejection(id)).not.toBeNull();
      expect(() => assertStringPersistenceId(id)).not.toThrow();
    }
    expect(persistenceIdRejection('account-42')).toBeNull();
    expect(() => assertStringPersistenceId('account-42')).not.toThrow();
  });

  test('every non-string is refused, with its runtime type named', () => {
    const typeNamed = (value: unknown): string => {
      try {
        assertStringPersistenceId(asRequestData(value));
      } catch (e) {
        return (e as Error).message;
      }
      return 'accepted';
    };
    // `{ $gte: '' }` is the dangerous shape — an operator expression — but the
    // contract is the type, so the "forgot to fill it in" cases are named too.
    expect(typeNamed({ $gte: '' })).toMatch(/must be a string, got object/);
    expect(typeNamed(undefined)).toMatch(/must be a string, got undefined/);
    // `typeof null` is `'object'`, which would be a useless thing to tell a
    // caller, and `Array.isArray` is the only way to separate a list out.
    expect(typeNamed(null)).toMatch(/must be a string, got null/);
    expect(typeNamed(['account-1'])).toMatch(/must be a string, got array/);
    expect(typeNamed(42)).toMatch(/must be a string, got number/);
    expect(typeNamed(true)).toMatch(/must be a string, got boolean/);
  });

  test('the shapes that try to be a string without being one', () => {
    // A type check is only as good as the set of things that can impersonate
    // the type.  None of these may pass, and none may crash the type naming
    // on its way to refusing them.
    const refusalFor = (value: unknown): string => {
      try {
        assertStringPersistenceId(asRequestData(value));
      } catch (e) {
        return (e as Error).message;
      }
      return 'ACCEPTED';
    };
    // A boxed String: `typeof` is `'object'`, and the driver would happily
    // serialize it — refusing it is the conservative answer and costs nothing,
    // because nothing in this repository produces one.
    expect(refusalFor(new String('account-1'))).toMatch(/must be a string, got object/);
    // A null-prototype object, which is what a JSON parser hands back under
    // some configurations — `Array.isArray` and `typeof` both survive it.
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.$gte = '';
    expect(refusalFor(nullPrototype)).toMatch(/must be a string, got object/);
    // No coercion anywhere: an object that stringifies to a valid id is still
    // an object by the time MongoDB reads the filter.
    expect(refusalFor({ toString: () => 'account-1', valueOf: () => 'account-1' }))
      .toMatch(/must be a string, got object/);
    expect(refusalFor(Symbol('account-1'))).toMatch(/must be a string, got symbol/);
    expect(refusalFor(() => 'account-1')).toMatch(/must be a string, got function/);
  });

  test('a string that looks like an operator is still just a string', () => {
    // The mirror image of the attack, and the reason the check is `typeof` and
    // not a scan for `$`: MongoDB reads an operator out of a document *key*,
    // never out of a value, so `'$gte'` in a value position is an equality
    // match against an id that literally spells `$gte`.  Refusing it would be
    // superstition, and would break a legitimate — if unwise — id.
    for (const id of ['$gte', '$where', '{ "$gte": "" }', '$']) {
      expect(() => assertStringPersistenceId(id)).not.toThrow();
    }
  });

  test('the message names the origin and never renders the value', () => {
    // The origin is the qualified call site, the same shape the write-side
    // validator takes — by the time a store sees a bad id the caller is
    // several frames away, and "which of the three stores" is half the answer.
    expect(() => assertStringPersistenceId(asRequestData({ $gte: '' }), 'MongoSnapshotStore.loadLatest'))
      .toThrow('Invalid persistenceId (MongoSnapshotStore.loadLatest): must be a string, got object '
        + '— a non-string value reaches MongoDB as an operator expression and would select other streams');
    // Unlike the write side, which quotes the id: there it has already been
    // established to be a string, here it is an arbitrary caller-supplied
    // object whose serialization is not this function's business.
    expect(() => assertStringPersistenceId(asRequestData({ secret: 'do-not-echo' })))
      .toThrow(/^Invalid persistenceId: must be a string, got object /);
  });
});
