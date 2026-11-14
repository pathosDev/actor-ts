/**
 * The deep half of the byte-level decoder properties (#1369): every per-commit
 * fuzz file, run with many more cases.
 *
 * **Not collected by `bun test`, by its name** — a `.nightly.ts` file runs only
 * when named by path, which `.github/workflows/nightly-flakes.yml` does:
 *
 *     bun test ./tests/nightly/DecoderFuzzDeep.nightly.ts
 *
 * so the run count stays out of the per-commit suite without an environment
 * variable deciding whether a test runs (`NoEnvironmentGatedSkips.test.ts`).
 *
 * The properties are imported rather than restated, so the deep run cannot
 * drift from the per-commit one: the imports register the same tests, and the
 * two lines before them raise what those tests read when they run — the case
 * count, and the per-test cap that count needs.  Only the numbers change: the
 * seed stays the preload's, so a red night replays locally with the command
 * above, and its counterexample goes into the per-commit file as an example
 * test before anything is fixed.  A property that sets its own `numRuns` (the
 * deep-nesting ones, where each case is already tens of thousands of levels)
 * keeps it.
 *
 * The imports are dynamic so that they run *after* those two lines: a static
 * import is hoisted above them, and its tests would register under the 5 s
 * default.  The cap is raised here rather than with `--timeout` on the command
 * line, which `WorkflowHygiene.test.ts` refuses for every workflow — a
 * run-wide flag would cover whatever else a later edit put on that line, where
 * this covers exactly the files imported below.
 */
import { setDefaultTimeout } from 'bun:test';
import fc from 'fast-check';

/** Cases per property per night — 80 times the per-commit 120; about 80 s in all on a developer machine. */
const NIGHTLY_RUNS = 10_000;

/** The cap for each imported property, sized to the slowest of them (~20 s locally) with room for a slow runner. */
const NIGHTLY_TIMEOUT_MS = 15 * 60_000;

fc.configureGlobal({ ...fc.readConfigureGlobal(), numRuns: NIGHTLY_RUNS });
setDefaultTimeout(NIGHTLY_TIMEOUT_MS);

await import('../unit/serialization/CborDecoderFuzz.test.js');
await import('../unit/serialization/JsonTreeDecoderFuzz.test.js');
await import('../unit/serialization/CodecDifferentialFuzz.test.js');
await import('../unit/cluster/FrameDecoderFuzz.test.js');
await import('../unit/http/websocket/InboundFrameFuzz.test.js');
await import('../unit/config/HoconParserFuzz.test.js');
