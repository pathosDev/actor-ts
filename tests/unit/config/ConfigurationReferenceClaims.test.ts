/**
 * Sentences the configuration reference publishes about behaviour, held to
 * that behaviour.
 *
 * Each one below was true when it was written, or incomplete in a way nobody
 * could see, until a later change to the code it describes made it false —
 * and nothing failed, because the suites that pin the behaviour never open a
 * page.  So each is pinned here from both ends where it can be: the page has
 * to say it, in English and in German, and where a unit test can reach the
 * behaviour the number the sentence quotes is taken from the code rather than
 * from a second copy of the words.
 *
 * `REFERENCE_CONF` stands for `src/config/Reference.ts` and for the HOCON fence
 * of both `reference-conf.mdx` pages, which `ReferenceConfDocs` holds
 * byte-identical to it.  Prose is compared with its line breaks and HOCON
 * comment markers folded away, so rewrapping a paragraph moves no pin.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { Dispatchers } from '../../../src/Dispatcher.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { bunIdleTimeoutOf } from '../../../src/runtime/http/BunHonoRunner.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

/** A docs page by its path under `docs/src/content/docs`, the German mirror under `de/`. */
function page(relative: string): string {
  return readFileSync(join(DOCS_ROOT, relative), 'utf8');
}

/** Text with HOCON comment markers and line breaks folded away: a sentence reads as one line. */
function prose(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/^[ \t]*#[ \t]?/gm, '').replace(/\s+/g, ' ');
}

const REFERENCE = prose(REFERENCE_CONF);
const reference = Config.parseString(REFERENCE_CONF);

describe('idle-timeout on the Hono backend under Bun (#1487)', () => {
  // The reference's own example value, read off the commented-out leaf.
  const example = /idle-timeout = (\d+)s/.exec(REFERENCE)?.[1];
  const exampleMs = Number(example) * 1_000;
  const deadlineMs = reference.getDuration(ConfigKeys.http.requestTimeout.deadline);
  const earliestCutSeconds = (bunIdleTimeoutOf({ idleTimeoutMs: exampleMs, requestDeadlineMs: deadlineMs }).earliestCutMs ?? NaN) / 1_000;

  test('0 is written as Bun.serve\'s own 0, which never closes, and the example is one bind() warns about', () => {
    expect(bunIdleTimeoutOf({ idleTimeoutMs: 0, requestDeadlineMs: deadlineMs }).seconds).toBe(0);
    expect(example).toBe('5');
    // A cut is reported only when it lands less than 2 s past the deadline,
    // which is what makes bind() warn.
    expect(earliestCutSeconds).toBeLessThan(deadlineMs / 1_000 + 2);
  });

  // Both pages carry an unrelated "only bound" (dead-letters retention), so
  // the pin is the whole clause rather than the two words.
  const ONLY_BOUND = 'the only bound on a request whose body stops arriving';
  const EINZIGE_SCHRANKE = 'die einzige Schranke für einen Request, dessen Body nicht mehr weiterkommt';

  test('reference.conf says 0 there leaves a stalled connection open, and where the example cuts', () => {
    expect(REFERENCE).toContain(`${ONLY_BOUND} and on a connection idle between requests`);
    expect(REFERENCE).toContain('so 0 leaves such a connection open until the client closes it');
    expect(REFERENCE).toContain(`the ${example}s below cuts a handler that has written nothing from ${earliestCutSeconds}s on`);
  });

  test.each([
    ['reference/configuration.mdx', ONLY_BOUND, 'until the client closes it'],
    ['de/reference/configuration.mdx', EINZIGE_SCHRANKE, 'bis der Client sie schließt'],
    ['http/security.mdx', ONLY_BOUND, 'until the client closes it'],
    ['de/http/security.mdx', EINZIGE_SCHRANKE, 'bis der Client sie schließt'],
  ])('%s says 0 leaves a stalled connection open there', (path, onlyBound, untilClosed) => {
    const text = prose(page(path));
    expect(text).toContain(onlyBound);
    expect(text).toContain(untilClosed);
  });

  test.each([
    ['reference/configuration.mdx', `the \`${example}s\` of the example above cuts a handler that has written nothing from ${earliestCutSeconds} s on`],
    ['de/reference/configuration.mdx', `die \`${example}s\` des Beispiels oben schneiden einen Handler, der nichts geschrieben hat, ab ${earliestCutSeconds} s ab`],
  ])('%s says where the example cuts', (path, sentence) => {
    const text = prose(page(path));
    expect(text).toContain(`idle-timeout = ${example}s`);
    expect(text).toContain(sentence);
  });
});

describe('the shard-region readiness check through a leader change (#1465)', () => {
  // The behaviour is ReadinessChecks.test.ts's 'a leader change keeps a
  // registered node green while its region registers again': a leader change
  // re-registers the region without taking its registration away.
  test('reference.conf no longer lists a leader change among what turns the check red', () => {
    expect(REFERENCE).not.toContain('from a start, a leader change or an eviction until the acknowledgment');
    expect(REFERENCE).not.toContain('a leader change reaches a coordinator that accepts it');
    expect(REFERENCE).toContain('from a start, an eviction or a lapsed refusal until the acknowledgment; a leader change alone keeps it green');
    expect(REFERENCE).toContain('A refusal lasts until the counts agree or the leader changes, which lifts it until the next coordinator decides');
  });
});

describe('the bootstrap\'s election budget needs new-cluster-enabled (#1500)', () => {
  // With new-cluster-enabled off the join plan carries no self-election grace
  // (ClusterBootstrap.ts: selfElection 'never'), so neither the computed
  // await-ready budget nor the give-up refusal is grace-based there.
  test('reference.conf names the condition for the give-up refusal and the computed budget', () => {
    expect(REFERENCE).not.toContain('and behind stable observation it must exceed');
    expect(REFERENCE).toContain('behind stable observation with new-cluster-enabled on it must exceed self-election-grace + 5s, or the bootstrap refuses it');
    expect(REFERENCE).toContain('default: self-election-grace + 5s behind stable observation with new-cluster-enabled on, 5s otherwise');
  });

  test.each([
    ['reference/configuration.mdx', '(`self-election-grace + 5s` behind stable observation with `new-cluster-enabled` on, `5s` otherwise)'],
    ['de/reference/configuration.mdx', '(`self-election-grace + 5s` hinter der Stable Observation mit `new-cluster-enabled` an, sonst `5s`)'],
  ])('%s names the condition in the await-ready row', (path, clause) => {
    expect(prose(page(path))).toContain(clause);
  });
});

describe('how far the φ first-contact estimate reaches (#1451)', () => {
  // The behaviour is PhiAccrualFailureDetector.test.ts's 'one heartbeat
  // leaves the estimate in place' and 'the first measured interval replaces
  // the estimate': a first heartbeat has nothing to be measured from, so the
  // estimate covers the gap to the second one too.
  test('reference.conf says the estimate stands until the first interval is measured', () => {
    expect(REFERENCE).not.toContain('assumes before a peer\'s first heartbeat');
    expect(REFERENCE).toContain('The mean phi assumes until a peer\'s first heartbeat interval is measured, with a deviation of a quarter of it');
  });

  test.each([
    ['reference/configuration.mdx', 'The inter-arrival time φ assumes until a peer\'s first heartbeat interval is measured, with a deviation of a quarter of it.', 'before a peer\'s first heartbeat'],
    ['de/reference/configuration.mdx', 'Die Zwischenankunftszeit, die φ annimmt, bis das erste Heartbeat-Intervall eines Peers gemessen ist, mit einer Standardabweichung von einem Viertel davon.', 'vor dem ersten Heartbeat eines Peers'],
  ])('%s says the same in the expected-response-after row', (path, sentence, retired) => {
    const text = prose(page(path));
    expect(text).toContain(sentence);
    expect(text).not.toContain(retired);
  });
});

/** The one table row of `path` that starts with `prefix`, the cell text as written. */
function rowOf(path: string, prefix: string): string {
  const rows = page(path).split(/\r?\n/).filter((line) => line.startsWith(prefix));
  expect(rows, `${path}: exactly one row starting with ${prefix}`).toHaveLength(1);
  return rows[0]!;
}

describe('a dispatcher budget is an integer from 1 up (#1461)', () => {
  // Dispatcher.test.ts pins the refusals themselves ('Hybrid(%p) is refused,
  // naming the argument', 'a system configured with a throughput of 0 is
  // refused at startup'); this ties the two sentences to the error they name.
  test('a configured throughput of 0 fails ActorSystem.create with an OptionsError from ThroughputDispatcher', () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig(Config.parseString('actor-ts.dispatcher { default = throughput, throughput = 0 }'));
    let refusal: unknown;
    try {
      ActorSystem.create('documented-throughput-zero', systemOptions);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(OptionsError);
    expect((refusal as OptionsError).message).toStartWith('ThroughputDispatcher: throughput must be an integer >= 1');
    expect(() => Dispatchers.Hybrid(0)).toThrow(OptionsError);
  });

  test.each([
    ['reference/configuration.mdx', 'An integer from `1` up; unlike `actor.throughput` it is not raised to `1` — with `default = throughput`, a `0` or below fails `ActorSystem.create` with an `OptionsError` from `ThroughputDispatcher`.'],
    ['de/reference/configuration.mdx', 'Eine ganze Zahl ab `1`; anders als `actor.throughput` wird sie nicht auf `1` angehoben — mit `default = throughput` lässt eine `0` oder weniger `ActorSystem.create` mit einem `OptionsError` aus `ThroughputDispatcher` scheitern.'],
  ])('%s states the domain in the dispatcher.throughput row', (path, clause) => {
    expect(rowOf(path, '| `dispatcher.throughput` |')).toContain(clause);
  });

  test.each([
    ['fundamentals/actor-system.mdx', 'A budget is an integer from `1` up: `Dispatchers.Hybrid(0)` is refused with an `OptionsError` when it is built, and with `actor-ts.dispatcher.default = throughput` a configured `throughput` of `0` fails `ActorSystem.create` the same way.'],
    ['de/fundamentals/actor-system.mdx', 'Ein Budget ist eine ganze Zahl ab `1`: `Dispatchers.Hybrid(0)` wird beim Bau mit einem `OptionsError` abgelehnt, und mit `actor-ts.dispatcher.default = throughput` lässt ein konfiguriertes `throughput` von `0` `ActorSystem.create` ebenso scheitern.'],
  ])('%s states the domain in the dispatcher row', (path, clause) => {
    expect(rowOf(path, '| `dispatcher` |')).toContain(clause);
  });
});

describe('a run for a node that could not join is a failure (#1455, #1500)', () => {
  // CoordinatedShutdown.exitStatus: a run for a failure exits 1 where
  // exit-code is 0, and ClusterJoinUnsuccessfulReason reports a failure —
  // the give-up and a failed Cluster.bootstrap readiness wait or refusal all
  // run the pipeline with it.  CoordinatedShutdown's own suites pin that.
  const JOIN_FAILURE = 'a run for a node that could not join (ClusterJoinUnsuccessfulReason: the join give-up, a failed Cluster.bootstrap readiness wait or refusal)';

  test('reference.conf lists it among the runs that exit 1', () => {
    expect(REFERENCE).toContain(`A run for a failed startup, ${JOIN_FAILURE}, and a run that a phase with recover = false halted, exit 1 where this is 0`);
  });

  test.each([
    ['reference/configuration.mdx', 'A run for a failed startup, a run for a node that could not join (`ClusterJoinUnsuccessfulReason`: the join give-up, a failed `Cluster.bootstrap` readiness wait or refusal), and a run that a phase with `recover = false` halts, exit `1` where this is `0`'],
    ['de/reference/configuration.mdx', 'Ein Lauf für einen fehlgeschlagenen Start, ein Lauf für einen Node, der nicht beitreten konnte (`ClusterJoinUnsuccessfulReason`: das Aufgeben des Joins, ein gescheitertes Readiness-Warten oder eine Ablehnung von `Cluster.bootstrap`), und ein Lauf, den eine Phase mit `recover = false` anhält, enden mit `1`, wo hier `0` steht'],
  ])('%s says so in the exit-code row', (path, sentence) => {
    expect(rowOf(path, '| `coordinated-shutdown.exit-code` |')).toContain(sentence);
  });

  test.each([
    ['cluster/joining-and-seeds.mdx', 'exits only with `coordinated-shutdown.exit-process = on`, and then never with status `0`'],
    ['de/cluster/joining-and-seeds.mdx', 'beendet sich nur mit `coordinated-shutdown.exit-process = on`, und dann nie mit Status `0`'],
  ])('%s says a give-up never exits 0', (path, sentence) => {
    expect(prose(page(path))).toContain(sentence);
  });

  test.each([
    ['fundamentals/actor-system.mdx', 'outside the pipeline, await `system.whenTerminated()` when you need the system down — a task must not', 'starts nothing and resolves at once; await `system.whenTerminated()` when you need the system down.'],
    ['de/fundamentals/actor-system.mdx', 'außerhalb der Pipeline await `system.whenTerminated()`, wenn du das System unten brauchst — ein Task darf das nicht', 'startet nichts und resolved sofort; await `system.whenTerminated()`, wenn du das System unten brauchst.'],
  ])('%s keeps a pipeline task from awaiting whenTerminated()', (path, sentence, retired) => {
    const text = prose(page(path));
    expect(text).toContain(sentence);
    expect(text).not.toContain(retired);
  });
});
