/**
 * Fixture for `ExportSurface.test.ts` (#1507) — two ways a namespace re-export
 * hides a seam one step further than the obvious one.
 *
 * A **renamed** binding is invisible to a name compare, so only the identity
 * compare can see it; a **nested** namespace sits one level below the door
 * itself, so a walk that stops after a single step misses it.  Putting both in
 * one module lets the door fixture beside this one reach them through a single
 * `export * as`, which is how a real barrel would acquire them: nobody writes
 * the nesting on purpose, they re-export a module that already had it.
 *
 * It re-exports the real seams rather than standing in for them.  A
 * `{ [Symbol.toStringTag]: 'Module' }` object literal would satisfy the
 * guard's namespace test by construction and would prove nothing about what
 * `export * as` actually produces — the fake-satisfies-the-stub shape that
 * `AGENTS.md` warns about for optional peers, applied to a language feature.
 */
export { setNativeZstdDecompressCandidatesOverride as forceZstdCandidates } from '../../../src/persistence/object-storage/Compression.js';
export * as compression from '../../../src/persistence/object-storage/Compression.js';
