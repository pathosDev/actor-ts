import { describe, expect, test } from 'bun:test';
import { MAX_TAG_LENGTH, MAX_TAGS_PER_EVENT } from '../../../../src/persistence/Constants.js';
import { assertValidEntryTags, assertValidTags } from '../../../../src/persistence/storage/TagValidator.js';
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

describe('assertValidEntryTags', () => {
  test('checks every entry, not just the first', () => {
    expect(() => assertValidEntryTags([{ event: 'a' }, { event: 'b' }])).not.toThrow();
    expect(() => assertValidEntryTags([{ event: 'a', tags: ['fine'] }, { event: 'b', tags: ['bad,tag'] }]))
      .toThrow(/comma/);
  });

  test('the per-event cap counts one event, not the whole batch (#631)', () => {
    // Under the old batch-wide `tags` argument, MAX_TAGS_PER_EVENT could only
    // ever be measured against a single list shared by every event — so a
    // batch could carry N × the cap and still pass.  Per entry, it cannot.
    const atCap = Array.from({ length: MAX_TAGS_PER_EVENT }, (_, i) => `t${i}`);
    expect(() => assertValidEntryTags([{ event: 'a', tags: atCap }, { event: 'b', tags: atCap }]))
      .not.toThrow();
    expect(() => assertValidEntryTags([{ event: 'a', tags: atCap }, { event: 'b', tags: [...atCap, 'one-too-many'] }]))
      .toThrow(/too many tags/);
  });
});

describe('journal append rejects invalid tags', () => {
  test('InMemoryJournal.append throws on a comma tag and writes nothing', async () => {
    const journal = new InMemoryJournal();
    await expect(journal.append('acct-1', [{ event: 'e1', tags: ['bad,tag'] }], 0)).rejects.toThrow(/comma/);
    // Rejected before any write — the stream is untouched.
    expect(await journal.highestSeq('acct-1')).toBe(0);
    expect(await journal.read('acct-1', 1)).toEqual([]);
  });

  test('a bad tag on a LATER event of the batch still writes nothing', async () => {
    // Validation runs over the whole batch up front, so the good first event
    // is not left behind by the rejection of the second.
    const journal = new InMemoryJournal();
    await expect(journal.append('acct-2', [
      { event: 'e1', tags: ['fine'] },
      { event: 'e2', tags: ['line1\nline2'] },
    ], 0)).rejects.toThrow(/control character/);
    expect(await journal.highestSeq('acct-2')).toBe(0);
    expect(await journal.read('acct-2', 1)).toEqual([]);
  });
});
