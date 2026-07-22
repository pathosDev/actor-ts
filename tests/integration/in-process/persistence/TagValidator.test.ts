import { describe, expect, test } from 'bun:test';
import {
  assertValidTags,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_EVENT,
} from '../../../../src/persistence/storage/TagValidator.js';
import { InMemoryJournal } from '../../../../src/persistence/index.js';

describe('assertValidTags', () => {
  test('accepts undefined, empty, and ordinary tags', () => {
    expect(() => assertValidTags(undefined)).not.toThrow();
    expect(() => assertValidTags([])).not.toThrow();
    expect(() => assertValidTags(['type:Order', 'user-123', 'region=eu-central-1', ''])).not.toThrow();
    expect(() => assertValidTags(['x'.repeat(MAX_TAG_LENGTH)])).not.toThrow();
    expect(() => assertValidTags(Array.from({ length: MAX_TAGS_PER_EVENT }, (_, i) => `t${i}`))).not.toThrow();
  });

  test('rejects a comma (would corrupt the CSV tag column)', () => {
    expect(() => assertValidTags(['a,b'])).toThrow(/comma/);
  });

  test('rejects control characters, including newlines', () => {
    expect(() => assertValidTags(['line1\nline2'])).toThrow(/control character/);
    expect(() => assertValidTags(['tab\there'])).toThrow(/control character/);
    expect(() => assertValidTags(['bell'])).toThrow(/control character/);
  });

  test('rejects an over-long tag', () => {
    expect(() => assertValidTags(['x'.repeat(MAX_TAG_LENGTH + 1)])).toThrow(/too long/);
  });

  test('rejects too many tags on one event', () => {
    expect(() => assertValidTags(Array.from({ length: MAX_TAGS_PER_EVENT + 1 }, (_, i) => `t${i}`)))
      .toThrow(/too many tags/);
  });
});

describe('journal append rejects invalid tags', () => {
  test('InMemoryJournal.append throws on a comma tag and writes nothing', async () => {
    const journal = new InMemoryJournal();
    await expect(journal.append('acct-1', ['e1'], 0, ['bad,tag'])).rejects.toThrow(/comma/);
    // Rejected before any write — the stream is untouched.
    expect(await journal.highestSeq('acct-1')).toBe(0);
    expect(await journal.read('acct-1', 1)).toEqual([]);
  });
});
