import { describe, expect, test } from 'bun:test';
import { MAX_TAG_LENGTH, MAX_TAGS_PER_EVENT } from '../../../../src/persistence/Constants.js';
import { assertValidEntryTags, assertValidTags } from '../../../../src/persistence/storage/TagValidator.js';
import { InMemoryJournal, assertValidTags as publiclyExportedAssertValidTags } from '../../../../src/persistence/index.js';

describe('assertValidTags', () => {
  test('accepts undefined, an empty list, and ordinary tags', () => {
    expect(() => assertValidTags(undefined)).not.toThrow();
    // An empty *list* means "no tags" and stays legal; an empty *tag* does not.
    expect(() => assertValidTags([])).not.toThrow();
    expect(() => assertValidTags(['type:Order', 'user-123', 'region=eu-central-1'])).not.toThrow();
    expect(() => assertValidTags(['x'.repeat(MAX_TAG_LENGTH)])).not.toThrow();
    expect(() => assertValidTags(Array.from({ length: MAX_TAGS_PER_EVENT }, (_, i) => `t${i}`))).not.toThrow();
  });

  test('rejects an empty tag (#740)', () => {
    // Previously exempted on the documented grounds that "every backend
    // already skips them on write", which no backend did: the SQL journals
    // dropped it from the tags table but kept it in the CSV column they read
    // back from, MongoDB indexed a queryable '' bucket, the Cassandra tag
    // index opened a hot `tag = ''` partition, and DynamoDB failed the append.
    expect(() => assertValidTags([''])).toThrow(/empty tag/);
    expect(() => assertValidTags(['a', ''])).toThrow(/empty tag/);
    // The message names the position, because JSON.stringify('') identifies
    // nothing in a list of ten.
    expect(() => assertValidTags(['a', 'b', ''])).toThrow(/index 2/);
  });

  test('rejects a duplicate tag (#740)', () => {
    expect(() => assertValidTags(['a', 'a'])).toThrow(/duplicate tag/);
    expect(() => assertValidTags(['order', 'payment', 'order'])).toThrow(/duplicate tag/);
    // Case- and whitespace-sensitive: only an exact repeat is a repeat, since
    // that is what a DynamoDB string set collapses.
    expect(() => assertValidTags(['Order', 'order'])).not.toThrow();
    expect(() => assertValidTags(['order', 'order '])).not.toThrow();
  });

  test('a malformed tag reports its flaw, not the repeat it also is', () => {
    // Ordering matters for the message a caller acts on: the comma is the
    // fixable defect, the duplication is a consequence of it appearing twice.
    expect(() => assertValidTags(['a,b', 'a,b'])).toThrow(/comma/);
    expect(() => assertValidTags(['', ''])).toThrow(/empty tag/);
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

  test('an empty or duplicate tag is refused at the journal boundary too (#740)', async () => {
    // The shape the issue describes: `[category, subCategory ?? '']`.
    const journal = new InMemoryJournal();
    await expect(journal.append('acct-3', [{ event: 'e1', tags: ['tenant-1', ''] }], 0))
      .rejects.toThrow(/empty tag/);
    await expect(journal.append('acct-3', [{ event: 'e1', tags: ['tenant-1', 'tenant-1'] }], 0))
      .rejects.toThrow(/duplicate tag/);
    expect(await journal.highestSeq('acct-3')).toBe(0);
    expect(await journal.read('acct-3', 1)).toEqual([]);
  });
});

describe('the public export', () => {
  test('actor-ts/persistence re-exports assertValidTags (#740)', () => {
    // The persistent-actor guide teaches this import so an application can
    // check its own `tagsFor` output before a persist throws.  Nothing else
    // compiles that import — the docs are MDX — so the barrel entry needs a
    // test of its own or it can be dropped without a red gate.
    expect(publiclyExportedAssertValidTags).toBe(assertValidTags);
    expect(() => publiclyExportedAssertValidTags(['tenant-1', ''])).toThrow(/empty tag/);
  });
});
