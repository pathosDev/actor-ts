import { describe, expect, test } from 'bun:test';
import { MAX_PERSISTENCE_ID_LENGTH } from '../../../src/persistence/Constants.js';
import {
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
