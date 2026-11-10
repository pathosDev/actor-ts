/**
 * Child-process fixture for `ZstdDecompressResolution.test.ts` (#1419).
 *
 * The zstd read ladder's last arm — "No zstd decompressor available" — runs only
 * when BOTH native candidates fail the canary AND the optional `fzstd` peer
 * fails to import.  The first half has a seam
 * (`setNativeZstdDecompressCandidatesOverride`, #780).  The second half has
 * none, and cannot have one in-process: `mock.module` is the obvious tool and
 * does not do it — bun 1.4.2 evaluates the factory at REGISTRATION, so a factory
 * that throws throws out of `mock.module(…)` itself and leaves the specifier
 * resolving normally, which was measured rather than assumed.
 *
 * What does work is refusing to resolve the specifier at all, and that is a
 * property of a module graph rather than of a value, so it needs a process of
 * its own.  A resolver plugin registered here — before anything has asked for
 * `fzstd`, which is why the import of `Compression.js` below is dynamic —
 * models the runtime the arm exists for: one without native zstd where the
 * operator never installed the optional peer.
 *
 * Running it as a child is also what keeps it honest.  `Bun.plugin` is
 * process-wide and has no uninstall, so registering this inside `bun test` would
 * take `fzstd` away from `ZstdDecompressResolution.test.ts` itself and from
 * `tests/unit/ci/OptionalPeerModuleShapes.test.ts` — the exact shape of leak
 * #1422 was about, with no `afterEach` able to undo it.
 *
 * Every line printed is a fact the parent asserts, and three of the four are
 * premises rather than the result: this runtime really can write zstd, a missing
 * peer costs its native read nothing, and the peer really was unreachable.  They
 * are there because the ways this fixture can go wrong all look like success — a
 * filter that stops matching leaves a runtime that still has `fzstd`, which
 * decodes the frame perfectly.
 */
import { plugin } from 'bun';

/**
 * The message the arm must carry through as its cause, distinctive enough to
 * prove it travelled.  Deliberately plain ASCII: it crosses a pipe to the parent
 * and back through a regex, and an encoding question there would be the parent's
 * problem rather than the resolver's.
 */
const SUPPRESSED = "Cannot find package 'fzstd' (suppressed by the fixture's resolver plugin)";

/**
 * Matches the bare specifier and the resolved path alike.
 *
 * bun hands `onResolve` the path it already resolved — measured:
 * `…/node_modules/fzstd/esm/index.mjs`, with an empty `importer` — so a
 * `/^fzstd$/` filter matches nothing and the plugin silently does not fire.
 * That failure looks exactly like a passing native read, which is why the parent
 * asserts on the suppression rather than only on the arm.
 */
const FZSTD_SPECIFIER = /(^|[\\/])fzstd([\\/]|$)/;

plugin({
  name: 'no-fzstd',
  setup(build) {
    build.onResolve({ filter: FZSTD_SPECIFIER }, () => {
      throw new Error(SUPPRESSED);
    });
  },
});

const {
  compressorFor,
  resetCompressionCache,
  setNativeZstdDecompressCandidatesOverride,
} = await import('../../../../../src/persistence/object-storage/Compression.js');

const PAYLOAD = new TextEncoder().encode('actor-ts zstd read fallback '.repeat(64));

/**
 * Flatten a thrown error onto one line so the parent can match it whole.
 *
 * Only the line breaks go — the arm's own spacing is part of the wording the
 * parent asserts, and collapsing every run of whitespace would quietly make the
 * assertion weaker than the sentence it quotes.
 */
function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\r?\n/g, ' | ');
}

// The peer is gone, but this runtime has native zstd — so the write still works
// and so does the read.  Both are premises of the suppression below, and both
// are also the reason an absent `fzstd` is invisible on Bun and Node: the ladder
// reaches the peer only after the natives have failed to decode the canary.
const frame = await compressorFor('zstd').compress(PAYLOAD, 3);
console.log(`wrote=${frame.length}`);
resetCompressionCache();
try {
  const readBack = await compressorFor('zstd').decompress(frame);
  console.log(`native-read=${readBack.length === PAYLOAD.length ? 'ok' : `wrong-length-${readBack.length}`}`);
} catch (e) {
  // Caught rather than allowed to escape, so a ladder that consults the peer
  // ABOVE the natives fails the parent's premise assertion by name instead of
  // killing the child and failing on its exit code.
  console.log(`native-read=${oneLine(e)}`);
}

// Now take the natives away too, and the ladder has nowhere left to go.
resetCompressionCache();
setNativeZstdDecompressCandidatesOverride({});
try {
  await compressorFor('zstd').decompress(frame);
  console.log('no-decompressor=DECODED');
} catch (e) {
  console.log(`no-decompressor=${oneLine(e)}`);
}

// Stated separately so "the plugin stopped firing" and "the arm stopped
// throwing" are different failures in the parent's output.
try {
  await import('fzstd');
  console.log('peer-import=loaded');
} catch {
  console.log('peer-import=failed');
}
