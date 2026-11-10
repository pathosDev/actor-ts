/**
 * Fixture for `ExportSurface.test.ts` (#1507) — a barrel that publishes the
 * internal seams the way the guard used to miss entirely.
 *
 * Appending `export * as compression from
 * './persistence/object-storage/Compression.js'` to `src/index.ts` put all
 * five Compression seams on the published surface — including the process-wide
 * `node:zlib` kill switch #580 exists to bound — while the whole file measured
 * 30 pass / 0 fail at exit 0, and a probe in that same tree read
 * `root.compression.setNativeZstdDecompressCandidatesOverride` back as the
 * identical function object.  Neither compare could see it: the seam's *name*
 * is a key of the namespace object rather than of the door, and the door's own
 * value is that object rather than the function.
 *
 * The door is a fixture rather than a real barrel for the obvious reason — the
 * measurement above required a tree in which the package published a kill
 * switch, which is not a tree to commit.  Asking the guard's own question of a
 * fixture door is also what makes the block a test of the *guard*: it fails
 * when the walk is removed, whatever `src/` happens to look like that week.
 *
 * Each export below is one shape the walk has to survive, and the block names
 * them by the path the guard reports, so a walk that handles only the first
 * fails on the rest instead of passing narrowly.
 */

/** The plain shape, exactly as a barrel-widening sweep would write it. */
export * as compression from '../../../src/persistence/object-storage/Compression.js';

/**
 * The same module under a name that shares no substring with it, so nothing
 * about catching it can rest on what the binding happens to be called.
 */
export * as zlibInternals from '../../../src/persistence/object-storage/Compression.js';

/** The other pinned module, so the block is not one module's accident. */
export * as runtimeInternals from '../../../src/runtime/Detect.js';

/** A renamed binding and a namespace one level deeper — see that module. */
export * as renamedSeams from './export-surface-renamed-seams.js';

/**
 * A namespace that contains itself.  `export * as self from` a module's own
 * path is legal, and it makes the binding graph cyclic: a walk without a
 * termination rule recurses until the stack ends rather than reporting
 * anything at all, which would turn the repair into a different silent
 * failure of the same guard.
 */
export * as self from './export-surface-namespace-doors.js';
