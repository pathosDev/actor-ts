/**
 * Smoke case: a deeply nested payload is REFUSED, on every runtime (#880).
 *
 * This case exists because the hazard it guards is runtime-dependent in a way
 * `bun test` cannot see.  The reasoning that motivated the JSON depth cap was
 * measured on Bun/JSC, whose `JSON.parse` is iterative: it accepts a million
 * levels of `[` without complaint, so nothing stops the framework's own
 * tagged-tree walker from recursing until the stack gives out.  Node and Deno
 * run V8, whose parser may refuse far earlier and on its own terms — which
 * would mean the two halves of the story ("the parser is no help" and "our
 * walker is the one that overflows") hold on one engine and not the others.
 *
 * The assertions below are therefore written to be true on ALL of them: the
 * walker is handed a tree built in a loop, never through `JSON.parse`, so what
 * is under test is the framework's counter rather than the engine's parser.
 * The parser's own behaviour is probed and PRINTED rather than asserted —
 * that is the cross-runtime fact worth recording, and pinning it would be
 * pinning V8's implementation choices.
 *
 * Opens no handles on any path: everything here is in-process computation, so
 * there is nothing for a timeout or a throw to leave behind.
 */
export const name = 'decoder read constraints';
export const description = 'a nested payload is refused with a typed error rather than a stack overflow';

export async function run({ loadEntry, runtime }) {
  const {
    CborDecodeError,
    CborDecoder,
    CborEncoder,
    CborSerializer,
    decodeJsonTree,
    JsonSerializer,
    SerializationError,
  } = await loadEntry('serialization');
  const fail = (message) => { throw new Error(message); };

  /** `levels` of nested arrays, built without going through a parser. */
  const nestedArray = (levels) => {
    let node = 1;
    for (let i = 0; i < levels; i++) node = [node];
    return node;
  };

  /** What `fn` threw, or `undefined` if it returned. */
  const thrownBy = (fn) => {
    try {
      fn();
      return undefined;
    } catch (e) {
      return e;
    }
  };

  // Informational, and the reason this case is here: say plainly whether this
  // runtime's parser refuses the document on its own, so a green run is never
  // mistaken for proof about an engine it did not run on.
  const parserVerdict = thrownBy(() => JSON.parse('['.repeat(100_000) + ']'.repeat(100_000)));
  console.log(
    `  (${runtime}: JSON.parse at 100k levels ${
      parserVerdict === undefined ? 'ACCEPTS — the walker is the only guard' : `refuses with ${parserVerdict.name}`
    })`,
  );

  // The core assertion, engine-independent: the walker's own counter fires,
  // and it fires as a typed SerializationError rather than a RangeError from a
  // blown stack.  4 000 levels is two orders of magnitude below where the
  // stack actually gives out, so before the cap existed this decoded happily.
  const deepTree = nestedArray(4_000);
  const walkerVerdict = thrownBy(() => decodeJsonTree(deepTree));
  if (walkerVerdict === undefined) fail('decodeJsonTree accepted a 4000-level tree');
  if (walkerVerdict instanceof RangeError) {
    fail(`decodeJsonTree overflowed the stack instead of refusing: ${walkerVerdict.message}`);
  }
  if (!(walkerVerdict instanceof SerializationError)) {
    fail(`decodeJsonTree threw ${walkerVerdict.name}, expected SerializationError`);
  }
  if (!walkerVerdict.message.includes('nesting deeper than')) {
    fail(`the refusal does not name the ceiling: ${walkerVerdict.message}`);
  }

  // A payload inside the ceiling is untouched — the cap must not buy safety by
  // making ordinary trees unreachable.
  const shallow = decodeJsonTree(nestedArray(200));
  if (!Array.isArray(shallow)) fail(`a 200-level tree decoded as ${typeof shallow}`);

  // The CBOR half of the same guard.  100 000 `0x81` bytes is a 100 000-level
  // array, and one byte per level is what makes it cheap to send.
  const deepCbor = new Uint8Array(100_000).fill(0x81);
  const cborVerdict = thrownBy(() => new CborDecoder().decode(deepCbor));
  if (!(cborVerdict instanceof CborDecodeError)) {
    fail(`CborDecoder threw ${cborVerdict?.name ?? 'nothing'}, expected CborDecodeError`);
  }

  // A configured ceiling reaches the decoder the serializer builds, on every
  // runtime — this is the path an ActorSystem's config actually takes.
  const strictCbor = new CborSerializer({ maxNestingDepth: 4 });
  const encoded = new CborEncoder().encode([[[[[[1]]]]]]);
  const strictVerdict = thrownBy(() => strictCbor.fromBinary(encoded, ''));
  if (!(strictVerdict instanceof CborDecodeError)) {
    fail(`a maxNestingDepth of 4 threw ${strictVerdict?.name ?? 'nothing'}, expected CborDecodeError`);
  }

  // The document ceiling, checked before any parse on either serializer.
  const bytes = new TextEncoder().encode(JSON.stringify({ padding: 'x'.repeat(256) }));
  const documentVerdict = thrownBy(() => new JsonSerializer({ maxDocumentBytes: 32 }).fromBinary(bytes, ''));
  if (!(documentVerdict instanceof SerializationError)) {
    fail(`maxDocumentBytes threw ${documentVerdict?.name ?? 'nothing'}, expected SerializationError`);
  }
  const roundTripped = new JsonSerializer().fromBinary(bytes, '');
  if (roundTripped.padding?.length !== 256) fail('the default serializer stopped round-tripping');
}
