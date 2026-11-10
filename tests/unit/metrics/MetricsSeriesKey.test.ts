/**
 * The series key is injective, and the unlabeled tuple is free (#1513, #1414).
 *
 * Two unrelated properties of one small function, bound in one file because
 * neither was observed by anything before and both live in `seriesKey`.
 *
 * ## Injectivity, as a property rather than a list
 *
 * The first version of the key joined `k=v` pairs with `\x1f`, and a label
 * *value* is deliberately unrestricted — so `{ a: 'x\x1fb=y' }` and
 * `{ a: 'x', b: 'y' }` spelled the same string and the second caller silently
 * got the first one's series.  `Metrics.test.ts` keeps that reported pair as a
 * regression example, and a table of five further separator characters beside
 * it.
 *
 * A table of characters is not the property.  A `k=v` join on any character
 * outside that table passes every one of those rows and reintroduces the
 * aliasing verbatim — measured: with `seriesKey` replaced by a join on `\x02`,
 * `bun test tests/unit/metrics tests/unit/worker/MetricsRelay.test.ts` was
 * 271 pass / 0 fail, and `counter('hits_total', { a: 'x\x02b=y' }).inc(6)`
 * beside `counter('hits_total', { a: 'x', b: 'y' }).inc(7)` collapsed to one
 * series reading 13.  Lengthening the table moves the hole one character over;
 * it never closes it.
 *
 * So these do not name a separator at all.  The binding assertion **searches
 * for the collision**: it takes the encoding of `{ a: 'x', b: 'y' }` and asks,
 * for every split point of that string, whether putting the tail into a single
 * label value reproduces it exactly.  If any split does, a one-key tuple
 * spells a two-key one and the encoding is not injective — and the loop never
 * looks at the separator, so it holds for a separator of any character and of
 * any *length*.  An earlier draft of this file cross-multiplied the characters
 * the encoding introduces, which was still a list: it called a join on `\r\n`
 * injective.  The search does not.
 *
 * The characters the encoding introduces are still computed, but only to seed
 * the alphabet the properties draw values from, so those stay pointed at the
 * encoding rather than at a fixed idea of what it looks like.
 *
 * ## What "rendered" means, which is the half that was wrong
 *
 * Injectivity is *over the rendering*, and the rendering was modelled as
 * `String(value)`.  It is not: the exporter also strips the C0 controls the
 * 0.0.4 escape table has no entry for, so `{ a: '\x1f\x1f' }` and `{ a: '' }`
 * are one identity in the body.  Under the old model the property demanded
 * they be two keys — and they were, which is how #1414 shipped a registry
 * that emitted the same series twice.  {@link rendersAs} now asks a real
 * `exportPrometheus` what a value renders to rather than restating a rule, so
 * the law reads "the key agrees with the exporter" and cannot drift from it.
 *
 * ## Cost, because the unlabeled tuple is the hot one
 *
 * `ActorCell` makes three registry calls per delivered user message —
 * `counter('actor_messages_delivered_total', {})`,
 * `histogram('actor_mailbox_wait_seconds', {})` and
 * `histogram('actor_mailbox_depth', {})` — every one of them with `{}`, and
 * `DefaultMetricsRegistry.childOf` computes the key *before* the memo lookup,
 * so each is a fresh encode rather than a hit on a cached string.  Encoding
 * `{}` as `JSON.stringify([])` therefore put a serialisation on the
 * per-message path three times over, to produce a constant.
 *
 * The **count, not the clock**, is what is asserted.  A wall-clock budget in a
 * unit test is a flake on a loaded machine — this repository has a guard class
 * of its own for that mistake — and the number of times the empty tuple is
 * serialised is the thing that was wrong, so it is the thing that is pinned.
 * The timings that justified the change are in the commit that made it.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  DefaultMetricsRegistry,
  seriesKey,
  type Labels,
} from '../../../src/metrics/Metrics.js';
import { exportPrometheus } from '../../../src/metrics/PrometheusExporter.js';

/* ------------------- asking the encoding for its separators ------------- */

/** An encoding of a label tuple — `seriesKey`, or a wrong one under test. */
type TupleEncoding = (labels: Labels) => string;

/**
 * Two probe tuples whose characters are **disjoint**, which is what keeps the
 * discovery below from missing a delimiter.
 *
 * A character the encoder introduces is invisible to subtraction if it also
 * appears in the probe's own input.  With two probes sharing no character, one
 * hidden inside the first probe's alphabet is exposed by the second and the
 * other way round, so none can hide from both — not even the absurd ones, a
 * delimiter that is the letter `a`.
 */
const PROBE_TUPLES: ReadonlyArray<Labels> = [
  { aa: 'xx', bb: 'yy' },
  { mm: '00', nn: '11' },
];

/**
 * Every character `encode` puts into its output that did not come from the
 * tuple — its separators, delimiters and quoting, whatever they happen to be.
 * `JSON.stringify` over sorted pairs answers `[`, `"`, `,`, `]`; a `k=v` join
 * on `\x02` answers `=` and `\x02`.
 *
 * This **is not the guard** — {@link findAliasingValue} is, and it needs no
 * alphabet.  What this is for is the two properties below: their values are
 * drawn from the characters the encoding actually treats as structural, so
 * fast-check spends its draws where a collision could be rather than on
 * payloads the encoding has no opinion about.  An encoding that changed its
 * delimiters would move the properties' alphabet with it, in the same commit.
 */
function charactersIntroducedBy(encode: TupleEncoding): ReadonlySet<string> {
  const introduced = new Set<string>();
  for (const probe of PROBE_TUPLES) {
    const fromInput = new Set<string>();
    for (const [key, value] of Object.entries(probe)) {
      for (const character of key) fromInput.add(character);
      for (const character of String(value)) fromInput.add(character);
    }
    for (const character of encode(probe)) {
      if (!fromInput.has(character)) introduced.add(character);
    }
  }
  return introduced;
}

/**
 * Search for a one-key tuple that encodes to the same string as the two-key
 * tuple `{ a: 'x', b: 'y' }` — the reported aliasing, looked for rather than
 * guessed at.
 *
 * This is the assertion that binds the family, and it names no separator at
 * all.  Any encoding that lays a tuple out as text puts the second pair
 * somewhere inside its output; if a *value* can be made to contain that
 * suffix, the one-key tuple spells the two-key one.  So: take the two-key
 * encoding, and for every split point ask whether putting the tail into a
 * single value reproduces it exactly.
 *
 * Being a search rather than a table is what makes it total.  It does not
 * need to know the separator, and — the reason it replaced a cross-product of
 * discovered characters — it does not need the separator to be *one*
 * character: a join on `\r\n`, on `', '`, or on any string at all is found by
 * the same loop, because the loop never looks at the separator.
 *
 * Both key positions are tried, so an encoding that emits its pairs in some
 * order other than sorted is covered too.
 *
 * Returns the colliding value, or `null` when no split point produces one.
 */
function findAliasingValue(encode: TupleEncoding): string | null {
  const target = encode({ a: 'x', b: 'y' });
  for (const key of ['a', 'b']) {
    for (let split = 0; split <= target.length; split++) {
      const value = target.slice(split);
      if (encode({ [key]: value }) === target) return value;
    }
  }
  return null;
}

/** The characters the shipped encoding introduces, computed once. */
const INTRODUCED_CHARACTERS = [...charactersIntroducedBy(seriesKey)];

/**
 * How the exposition renders one label value — **measured, not modelled**
 * (#1414).
 *
 * This used to be `String(value)`, and that was the wrong rendering: the
 * exporter also strips the C0 controls it has no escape for, so `'\x1f\x1f'`
 * and `''` both come out as `""` in the body.  A model that says otherwise
 * demands that `seriesKey` keep two tuples apart which the exposition then
 * emits under one identity — a duplicated series, which a Prometheus scrape
 * rejects by rejecting the whole body.  The property below was right to fail
 * on `[{ a: '\x1f\x1f' }, { a: '' }]`; the model was what was wrong.
 *
 * Writing the strip out again here would replace one wrong model with a
 * fragile one — a second copy of a character class that then has to be kept in
 * step by hand.  So the rendering is *asked for* instead: one value goes
 * through a real registry and a real `exportPrometheus`, and what comes back
 * is what a scraper would read.  Whatever the exporter does, the key has to
 * agree with it, which is the law this file is about.
 *
 * Cached because the property draws the same few values many times over, and
 * keyed on the type as well as the spelling so a `500` and a `'500'` are asked
 * separately — they must *answer* the same, and that is an assertion below,
 * not an assumption here.
 */
const RENDERED_VALUES = new Map<string, string>();

function rendersAs(value: Labels[string]): string {
  const cacheKey = `${typeof value}:${String(value)}`;
  const cached = RENDERED_VALUES.get(cacheKey);
  if (cached !== undefined) return cached;
  const registry = new DefaultMetricsRegistry();
  registry.counter('probe_total', { v: value }).inc();
  const row = exportPrometheus(registry)
    .split('\n')
    .find((line) => line.startsWith('probe_total{')) ?? '';
  // `probe_total{v="…"} 1` → `{v="…"}`; the identity half of the row, which is
  // the only part a duplicate is a duplicate in.
  const rendered = row.slice(row.indexOf('{'), row.lastIndexOf(' '));
  RENDERED_VALUES.set(cacheKey, rendered);
  return rendered;
}

/**
 * Structural equality of two tuples **as the exposition renders them** —
 * deliberately not written as a string comparison.
 *
 * A canonical form built by joining or stringifying would be a second copy of
 * the encoding under test, and a test that compares an implementation against
 * a restatement of itself can only ever agree with it.  Comparing the sorted
 * pair lists element by element cannot alias, because nothing is concatenated
 * — only the per-value rendering is measured, and one value has no second pair
 * to spell.
 */
function rendersAsTheSameTuple(left: Labels, right: Labels): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => {
    const rightKey = rightKeys[index]!;
    return key === rightKey && rendersAs(left[key]) === rendersAs(right[rightKey]);
  });
}

describe('seriesKey — the separator family, not a list of separators (#1513)', () => {
  test('the discovery finds something at all, so nothing below is vacuous', () => {
    // Every assertion in this block iterates the discovered set. An empty one
    // would make all of them pass without testing anything, which is the exact
    // failure mode this block exists to replace.
    expect(INTRODUCED_CHARACTERS.length).toBeGreaterThan(0);
    // The shipped encoding is JSON over sorted pairs, so these are its
    // structural characters. Named for the reader, asserted so that an
    // encoding change has to come past this line.
    expect([...INTRODUCED_CHARACTERS].sort()).toEqual(['"', ',', '[', ']']);
  });

  test('no value can spell a second pair — searched for, not guessed at', () => {
    expect(
      findAliasingValue(seriesKey),
      'a single label value reproduces the encoding of a two-label tuple, which '
      + 'is the #1513 aliasing exactly',
    ).toBeNull();
  });

  test('the search discriminates — it catches a `k=v` join on any separator', () => {
    // The guard on the guard. Without this, `findAliasingValue` could be
    // answering `null` because it is broken rather than because the encoding
    // is sound, and the row above would be the green that hides it.
    //
    // The list is deliberately awkward. `Z` and `a` are letters, and `a` is
    // also a character of the probe tuple, so a discovery-by-subtraction
    // scheme would miss it. U+2028 is a line terminator. `\r\n` and `', '`
    // are two characters long, which is what retired the cross-product of
    // discovered single characters this replaced — it would have called every
    // one of those encodings injective.
    //
    // U+2028 is built with `fromCharCode` rather than spelled: a raw one ends
    // a line for some source parsers, and an editing tool that resolved the
    // escape into the raw byte is how this file first failed to compile.
    const separators = ['\x1f', '\x02', '\x00', '|', ',', 'Z', 'a',
      String.fromCharCode(0x2028), '\r\n', ', '];
    for (const separator of separators) {
      const join: TupleEncoding = (labels) => Object.keys(labels).sort()
        .map((key) => `${key}=${String(labels[key])}`)
        .join(separator);
      expect(
        findAliasingValue(join),
        `a k=v join on ${JSON.stringify(separator)} was not caught`,
      ).toBe(`x${separator}b=y`);
    }
  });

  test('the search does not cry wolf over an encoding that is merely unusual', () => {
    // The other half of discrimination: a guard that answered "collision" for
    // everything would also make the row above green. These three are odd but
    // injective — length-prefixed pairs, a JSON object, and a percent-escaped
    // join — and none of them may be reported.
    const lengthPrefixed: TupleEncoding = (labels) => Object.keys(labels).sort()
      .map((key) => `${key.length}:${key}${String(labels[key]).length}:${String(labels[key])}`)
      .join('');
    const asObject: TupleEncoding = (labels) => JSON.stringify(
      Object.fromEntries(Object.keys(labels).sort().map((key) => [key, String(labels[key])])),
    );
    const percentEscaped: TupleEncoding = (labels) => Object.keys(labels).sort()
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(labels[key]))}`)
      .join('&');
    for (const encode of [lengthPrefixed, asObject, percentEscaped]) {
      expect(findAliasingValue(encode)).toBeNull();
    }
  });

  test('property: folding a pair into a value never collides, for any key or value', () => {
    // The exhaustive test above fixes the tuple at `a/b/x/y`. This one keeps
    // the separators derived and lets fast-check choose the names and the
    // payloads, so an encoding that happens to survive that one tuple and not
    // others is still caught.
    const identifier = fc.constantFrom('a', 'b', 'route', 'node');
    const payload = fc.string({
      unit: fc.constantFrom(...INTRODUCED_CHARACTERS, '=', 'x', 'y', '\\', '\x1f'),
      maxLength: 6,
    });
    fc.assert(fc.property(
      fc.constantFrom(...INTRODUCED_CHARACTERS),
      fc.constantFrom(...INTRODUCED_CHARACTERS),
      identifier, identifier, payload, payload,
      (separator, assignment, firstKey, secondKey, firstValue, secondValue) => {
        // Same key twice is a one-pair tuple on both sides, not a fold.
        if (firstKey === secondKey) return true;
        const unfolded: Labels = { [firstKey]: firstValue, [secondKey]: secondValue };
        const folded: Labels = {
          [firstKey]: `${firstValue}${separator}${secondKey}${assignment}${secondValue}`,
        };
        return seriesKey(unfolded) !== seriesKey(folded);
      },
    ));
  });

  test('the rendering model is the exposition, not `String(value)` (#1414)', () => {
    // The guard on the model the property below compares against. `String`
    // was what it used to say, and under `String` the first row here reads
    // false — the property then demands that `seriesKey` split two tuples the
    // body emits under one identity, which is the duplicate #1414 is about.
    expect(rendersAs('\x1f\x1f'), 'a stripped control still shows in the model')
      .toBe(rendersAs(''));
    expect(rendersAs('a\x1fb')).toBe(rendersAs('ab'));
    // And not wider than the strip: TAB and LF survive rendering, so two
    // values differing by one of them are two identities and must stay two
    // series. A model that folded them would hide the opposite defect.
    expect(rendersAs('a\tb')).not.toBe(rendersAs('ab'));
    expect(rendersAs('a\nb')).not.toBe(rendersAs('ab'));
    // The type-blind half: a number and its spelling render alike, which is
    // why the cache key carries the type but the answer does not.
    expect(rendersAs(500)).toBe(rendersAs('500'));
    expect(rendersAs(true)).toBe(rendersAs('true'));
    // Non-vacuity: the model tells *something* apart, so the rows above are
    // not all reading one constant.
    expect(rendersAs('x')).not.toBe(rendersAs('y'));
  });

  test('property: distinct rendered tuples get distinct keys, and equal ones equal keys', () => {
    // The law in full, in both directions. The reverse half is load-bearing on
    // its own: an encoding that mixed the *unsorted* key order in, that
    // distinguished `500` from `'500'`, or that distinguished two values the
    // C0 strip renders alike, would satisfy injectivity and still be wrong,
    // because the exposition cannot tell any of those pairs apart. The last
    // of the three is what #1414 shipped, and this property found it the
    // moment its model stopped saying rendering was `String(value)`.
    const identifier = fc.constantFrom('a', 'b', 'code');
    const value = fc.oneof(
      fc.string({
        unit: fc.constantFrom(...INTRODUCED_CHARACTERS, '=', 'x', 'y', '\x1f', '\x00'),
        maxLength: 5,
      }),
      fc.constantFrom<Labels[string]>(500, '500', true, 'true', 0, ''),
    );
    const tuple = fc.dictionary(identifier, value, { maxKeys: 3 });
    fc.assert(fc.property(tuple, tuple, (left, right) => (
      rendersAsTheSameTuple(left, right) === (seriesKey(left) === seriesKey(right))
    )));
  });

  test('the registry keeps a folded tuple apart from the pair it spells', () => {
    // The same family one layer up, because the aliasing that was reported was
    // never visible as a string — it was one series where there should have
    // been two. `seriesKey` could be inlined or renamed tomorrow and this
    // would still hold the behaviour.
    for (const separator of INTRODUCED_CHARACTERS) {
      const registry = new DefaultMetricsRegistry();
      registry.counter('hits_total', { a: `x${separator}b=y` }).inc(6);
      registry.counter('hits_total', { a: 'x', b: 'y' }).inc(7);
      const series = registry.collect().filter((sample) => sample.name === 'hits_total');
      expect(
        series,
        `a value carrying ${JSON.stringify(separator)} merged onto the two-label tuple`,
      ).toHaveLength(2);
      // Not merely two of something: the merge added the counts together, so
      // a reading of 13 is the shape of the defect.
      expect(series.map((sample) => sample.value).sort()).toEqual([6, 7]);
    }
  });
});

/* --------------------- the unlabeled tuple, and its cost ---------------- */

/**
 * Count the `JSON.stringify` calls `body` makes.
 *
 * The same trick `MetricsNameValidation.test.ts` plays on the two grammar
 * patterns, one global over: an own property on `JSON` shadows the builtin for
 * the duration, and `seriesKey` resolves it there.  Restored in a `finally`,
 * because bun runs a file in one process and a leaked counter would follow
 * `JSON` into every suite after it.
 *
 * Nothing else on this path serialises: within `src/metrics/`, the only other
 * `JSON.stringify` calls are in the two `assertValid…` throw messages and the
 * cardinality warning, none of which runs while a legal tuple is accepted, and
 * `PrometheusExporter.ts` has none at all.  So the count *is* `seriesKey`'s.
 */
function jsonStringifyCallsDuring(body: () => void): number {
  const shipped = JSON.stringify;
  let calls = 0;
  Object.defineProperty(JSON, 'stringify', {
    configurable: true,
    writable: true,
    value(this: unknown, ...args: Parameters<typeof JSON.stringify>): string {
      calls += 1;
      return shipped.apply(this, args) as string;
    },
  });
  try {
    body();
  } finally {
    Object.defineProperty(JSON, 'stringify', {
      configurable: true,
      writable: true,
      value: shipped,
    });
  }
  return calls;
}

describe('seriesKey — the unlabeled tuple is the hot one (#1414)', () => {
  test('the counter meter checks itself against a call that does serialise', () => {
    // Guards every count below from reading 0 because the shadow never took.
    expect(jsonStringifyCallsDuring(() => { JSON.stringify([1]); })).toBe(1);
    expect(jsonStringifyCallsDuring(() => {})).toBe(0);
  });

  test('the three per-message calls cost no serialisation at all', () => {
    // `ActorCell` makes exactly these three per delivered user message, every
    // one with `{}`. The key is computed before the memo lookup, so this is
    // three encodes of the empty tuple and not one plus two cache hits.
    const registry = new DefaultMetricsRegistry();
    const calls = jsonStringifyCallsDuring(() => {
      registry.counter('actor_messages_delivered_total', {}).inc();
      registry.histogram('actor_mailbox_wait_seconds', {}).observe(0.01);
      registry.histogram('actor_mailbox_depth', {}).observe(3);
    });
    expect(
      calls,
      'the unlabeled tuple is being serialised on the per-message path; it is a '
      + 'constant and encodes to a constant (#1414)',
    ).toBe(0);
  });

  test('a labeled tuple still pays one encode per call — the shortcut is the empty one only', () => {
    // The over-broad fix is a memo on every tuple, or an encoding that stopped
    // serialising altogether. Both read 0 here; the shipped one reads one per
    // call, because `childOf` encodes before it looks up.
    const registry = new DefaultMetricsRegistry();
    const calls = jsonStringifyCallsDuring(() => {
      registry.counter('hits_total', { route: '/a' }).inc();
      registry.counter('hits_total', { route: '/a' }).inc();
      registry.counter('hits_total', { route: '/a' }).inc();
    });
    expect(calls).toBe(3);
  });

  test('the scrape path is free of it too, for an unlabeled histogram', () => {
    // The exporter groups a histogram's rows by the same key, once per sample —
    // fourteen of them for a default-bucket family — so the empty tuple is on
    // the export path as well as the delivery one.
    const registry = new DefaultMetricsRegistry();
    registry.histogram('actor_mailbox_depth', {}).observe(3);
    const calls = jsonStringifyCallsDuring(() => { exportPrometheus(registry); });
    expect(calls).toBe(0);
  });

  test('the unlabeled tuple keeps a key of its own — it is not any other tuple', () => {
    // What makes the shortcut safe rather than a second aliasing bug: whatever
    // the empty tuple encodes to, no non-empty one may encode to the same
    // thing. Checked against tuples whose encodings are the plausible
    // near-misses of a short-circuit returning a short constant.
    const empty = seriesKey({});
    // A short-circuit that returns `undefined` rather than a string satisfies
    // every comparison below — `undefined !== '[["a","x"]]'` is true, and
    // `Map` takes it as a key quite happily, so the registry still works.
    // Only the compiler would object, and only while the annotation stands.
    expect(typeof empty).toBe('string');
    const nonEmpty: ReadonlyArray<Labels> = [
      { a: '' }, { '': '' }, { a: 'x' }, { a: '[]' }, { a: '[', b: ']' },
      { '[]': '[]' }, { a: '""' }, { a: 'undefined' }, { a: 'null' },
    ];
    for (const labels of nonEmpty) {
      expect(seriesKey(labels), `${JSON.stringify(labels)} collided with the empty tuple`)
        .not.toBe(empty);
    }
    // And it is stable: the same tuple twice is the same key, so a series is
    // found again rather than minted again.
    expect(seriesKey({})).toBe(empty);
  });

  test('the registry still tells the unlabeled series from a labeled one', () => {
    // The behaviour the key exists for, at the boundary the shortcut touches.
    const registry = new DefaultMetricsRegistry();
    registry.counter('hits_total').inc(4);
    registry.counter('hits_total', { route: '/a' }).inc(5);
    const series = registry.collect().filter((sample) => sample.name === 'hits_total');
    expect(series).toHaveLength(2);
    expect(series.find((sample) => Object.keys(sample.labels).length === 0)?.value).toBe(4);
    expect(series.find((sample) => sample.labels.route === '/a')?.value).toBe(5);
    // `remove` looks the same key up, so the unlabeled tuple has to be
    // removable on its own without taking a sibling with it.
    expect(registry.remove('hits_total')).toBe(true);
    expect(registry.collect().filter((sample) => sample.name === 'hits_total')).toHaveLength(1);
  });
});
