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
import { readClusterOptionsFromConfig } from '../../../src/cluster/ClusterOptions.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { Dispatchers } from '../../../src/Dispatcher.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MsSqlJournalOptionsValidator } from '../../../src/persistence/journals/MsSqlJournalOptions.js';
import { readMsSqlJournalOptionsFromConfig } from '../../../src/persistence/journals/MsSqlPluginOptions.js';
import { PostgresJournalOptionsValidator } from '../../../src/persistence/journals/PostgresJournalOptions.js';
import { readPostgresJournalOptionsFromConfig } from '../../../src/persistence/journals/PostgresPluginOptions.js';
import { bunIdleTimeoutOf } from '../../../src/runtime/http/BunHonoRunner.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

/** A docs page by its path under `docs/src/content/docs`, the German mirror under `de/`. */
function page(relative: string): string {
  return readFileSync(join(DOCS_ROOT, relative), 'utf8');
}

/**
 * Text with HOCON comment markers and line breaks folded away: a sentence
 * reads as one line.  An MDX comment renders nothing, so it is cut first — a
 * sentence that lives only in one does not count as said.
 */
function prose(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*#[ \t]?/gm, '')
    .replace(/\s+/g, ' ');
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

describe('a WorkerMesh pool and the secrets file (#1546)', () => {
  // WorkerMeshProfile.test.ts pins the mesh half ('a profile selected in code
  // reaches the workers, whatever ACTOR_TS_PROFILE names'), ConfigProfiles
  // the file half ('a ./secrets.conf nothing named says it was read from the
  // working directory').
  test.each([
    [
      'reference/configuration.mdx',
      '`KubernetesLease` and `WorkerCluster.spawn`, and the exported',
      'A `WorkerMesh` hands its worker pool the main system\'s `system.config`, and its workers select no profile of their own: they run with the values the main system\'s profile produced.',
      'including the worker pool a `WorkerMesh` starts',
    ],
    [
      'de/reference/configuration.mdx',
      '`KubernetesLease` und `WorkerCluster.spawn` sowie die',
      'Ein `WorkerMesh` übergibt seinem Worker-Pool die `system.config` des Main-Systems, und seine Worker wählen kein eigenes Profil: Sie laufen mit den Werten, die das Profil des Main-Systems ergeben hat.',
      'samt dem Worker-Pool, den ein `WorkerMesh` startet',
    ],
  ])('%s no longer counts the mesh pool among the components that see only ACTOR_TS_PROFILE', (path, listed, meshSentence, retired) => {
    const text = prose(page(path));
    expect(text).toContain(listed);
    expect(text).toContain(meshSentence);
    expect(text).not.toContain(retired);
  });

  test.each([
    ['reference/configuration.mdx', 'A file that is there is read on every start, so a `secrets.conf` in the working directory that belongs to another tool stops startup: the `ConfigError` names the file and why it was read — move such a file, or name the right one with `ACTOR_TS_SECRETS_CONF`.'],
    ['de/reference/configuration.mdx', 'Eine Datei, die da ist, wird bei jedem Start gelesen — eine `secrets.conf` im Arbeitsverzeichnis, die zu einem anderen Werkzeug gehört, hält den Start also an: Der `ConfigError` nennt die Datei und den Grund, aus dem sie gelesen wurde; verschiebe eine solche Datei oder nenne die richtige mit `ACTOR_TS_SECRETS_CONF`.'],
  ])('%s says a foreign secrets.conf stops startup, and how to get past it', (path, sentence) => {
    expect(prose(page(path))).toContain(sentence);
  });
});

describe('the dead-key gate as the reference-conf page describes it (#1425)', () => {
  // The registry knows which registered reader calls which, so between two of
  // them the gate does say whether the runtime asks the reader; and a leaf
  // that ships empty has no "other value of the same kind", so it is set to
  // two non-empty ones.
  test.each([
    [
      'reference/reference-conf.mdx',
      'requires at least one of them to answer differently; a leaf that ships empty is set to two non-empty values instead, which a reader has to tell apart.',
      'That the runtime asks the reader, or keeps its answer — except between two registered readers: a reader that another registered reader calls, such as a sink\'s delivery block or the cluster\'s downing provider, counts only where that caller answers to the same leaf.',
    ],
    [
      'de/reference/reference-conf.mdx',
      'verlangt, dass mindestens einer anders antwortet; ein leer ausgelieferter Key wird stattdessen auf zwei nicht leere Werte gesetzt, die ein Leser unterscheiden muss.',
      'Dass die Laufzeit den Leser fragt oder seine Antwort behält — außer zwischen zwei registrierten Lesern: Ein Leser, den ein anderer registrierter Leser aufruft, etwa der delivery-Block einer Senke oder der Downing-Provider des Clusters, zählt nur dort, wo dieser Aufrufer auf denselben Key antwortet.',
    ],
  ])('%s', (path, emptyLeaf, notProven) => {
    const text = prose(page(path));
    expect(text).toContain(emptyLeaf);
    expect(text).toContain(notProven);
  });
});

describe('app-version = ${?APP_VERSION} and a version that reads as a number (#843)', () => {
  /** The label `app-version = ${?APP_VERSION}` reads back with `APP_VERSION` set to `value`, through the cluster's own reader. */
  function appVersionFrom(value: string): string | undefined {
    const previous = process.env.APP_VERSION;
    process.env.APP_VERSION = value;
    try {
      return readClusterOptionsFromConfig(Config.parseString('actor-ts.cluster.app-version = ${?APP_VERSION}')).appVersion;
    } finally {
      if (previous === undefined) delete process.env.APP_VERSION;
      else process.env.APP_VERSION = previous;
    }
  }

  // The HOCON layer reads an environment value as JSON first (until that
  // parser behaviour is decided), which is what every sentence below warns of.
  test('a numeric-looking version comes back in the number\'s spelling, and a quoted one as written', () => {
    expect(appVersionFrom('1.10')).toBe('1.1');
    expect(appVersionFrom('2.0')).toBe('2');
    expect(appVersionFrom('1e3')).toBe('1000');
    expect(appVersionFrom('"1.10"')).toBe('1.10');
    expect(appVersionFrom('1.2.3')).toBe('1.2.3');
    expect(appVersionFrom('v1.10')).toBe('v1.10');
    expect(() => appVersionFrom('null')).toThrow(ConfigError);
  });

  test('reference.conf says so beside the substitution form', () => {
    expect(REFERENCE).toContain('An environment value is read as JSON first, so APP_VERSION=1.10 reads back as "1.1" and 2.0 as "2" -- releases 1.1 and 1.10 print the same label; quote such a value inside the variable (APP_VERSION=\'"1.10"\').');
  });

  const EN = 'A version that reads as a number comes back in that number\'s own spelling — `1.10` as `1.1`, `2.0` as `2`, `1e3` as `1000` — so releases `1.1` and `1.10` print the same label';
  const DE = 'Eine Version, die sich wie eine Zahl liest, kommt in der Schreibweise dieser Zahl zurück — `1.10` als `1.1`, `2.0` als `2`, `1e3` als `1000` —, die Releases `1.1` und `1.10` tragen also dasselbe Label';
  const REMEDY = '(`APP_VERSION=\'"1.10"\'`)';

  test.each([
    ['reference/configuration.mdx', EN],
    ['de/reference/configuration.mdx', DE],
    ['operations/upgrades/upgrade-strategies.mdx', EN],
    ['de/operations/upgrades/upgrade-strategies.mdx', DE],
  ])('%s says what an unquoted version becomes, and how to quote it', (path, sentence) => {
    const text = prose(page(path));
    expect(text).toContain('${?APP_VERSION}');
    expect(text).toContain(sentence);
    expect(text).toContain(REMEDY);
  });

  test.each([
    ['cluster/overview.mdx', 'an environment value is read as JSON first, so an unquoted `1.10` reaches the peers as `1.1`'],
    ['de/cluster/overview.mdx', 'ein Wert aus der Umgebung wird zuerst als JSON gelesen, ein ungequotetes `1.10` erreicht die Peers also als `1.1`'],
  ])('%s carries the caveat in the appVersion row', (path, sentence) => {
    const row = rowOf(path, '| `appVersion` |');
    expect(row).toContain('${?APP_VERSION}');
    expect(row).toContain(sentence);
    expect(row).toContain(REMEDY);
  });
});

describe('when a bad persistence client leaf fails (#1490)', () => {
  /** Where building a store from `block` fails: the read, the store's own check, or neither. */
  function failureOf(read: () => unknown, check: (settings: never) => void): { readonly at: string; readonly error?: Error } {
    let settings: unknown;
    try {
      settings = read();
    } catch (error) {
      return { at: 'read', error: error as Error };
    }
    try {
      check(settings as never);
    } catch (error) {
      return { at: 'check', error: error as Error };
    }
    return { at: 'nowhere' };
  }
  const postgres = (leaf: string): ReturnType<typeof failureOf> => failureOf(
    () => readPostgresJournalOptionsFromConfig(Config.parseString(`actor-ts.persistence.journal.postgres { url = "postgres://h/db", ${leaf} }`)),
    (settings) => new PostgresJournalOptionsValidator().validate(settings),
  );
  const msSql = (leaf: string): ReturnType<typeof failureOf> => failureOf(
    () => readMsSqlJournalOptionsFromConfig(Config.parseString(`actor-ts.persistence.journal.mssql { ${leaf} }`)),
    (settings) => new MsSqlJournalOptionsValidator().validate(settings),
  );

  test('the wrong kind fails the read, naming the leaf — a duration that does not parse names only the value', () => {
    const word = postgres('max-pool-size = lots');
    expect(word.at).toBe('read');
    expect(word.error).toBeInstanceOf(ConfigError);
    expect(word.error?.message).toContain('actor-ts.persistence.journal.postgres.max-pool-size');
    const duration = postgres('connect-timeout = soon');
    expect(duration.at).toBe('read');
    expect(duration.error?.message).toBe('Invalid duration: soon');
  });

  test('a value of the right kind out of range is the store\'s OptionsError, and so is an mssql:// url', () => {
    const zero = postgres('max-pool-size = 0');
    expect(zero.at).toBe('check');
    expect(zero.error).toBeInstanceOf(OptionsError);
    const url = msSql('url = "mssql://sa:secret@host:1433/app"');
    expect(url.at).toBe('check');
    expect(url.error).toBeInstanceOf(OptionsError);
  });

  const STANDARD = 'Each is read when the store is built: a value of the wrong kind fails that read with a ConfigError naming the leaf (a duration that does not parse, with an error naming only the value), and one out of range is then refused with an OptionsError.';

  test('reference.conf says so for every block that has the leaves, and for the url', () => {
    expect(REFERENCE).not.toContain('A bad value is refused with an OptionsError when the store is built');
    expect(REFERENCE.split(STANDARD).length - 1).toBe(3);
    expect(REFERENCE).toContain('An mssql:// url passes the read like any other string and is refused with an OptionsError when the store is built');
  });

  test.each([
    [
      'reference/configuration.mdx',
      'An `mssql://` url passes the read like any other string and is refused with an `OptionsError` when the store is built',
      'Each is read when the store is built. A value of the wrong kind — a word where a number goes, a fraction where a count goes, a duration that does not parse — fails that read, with a `ConfigError` naming the leaf, or for the duration an error naming only the value.',
    ],
    [
      'de/reference/configuration.mdx',
      'Eine `mssql://`-URL besteht das Lesen wie jeder andere String und wird beim Bau des Stores mit einem `OptionsError` abgelehnt',
      'Gelesen wird jedes beim Bau des Stores. Ein Wert der falschen Art — ein Wort, wo eine Zahl hingehört, ein Bruch, wo eine Anzahl hingehört, eine Dauer, die sich nicht parsen lässt — scheitert schon beim Lesen, mit einem `ConfigError`, der das Blatt nennt, bei der Dauer mit einem Fehler, der nur den Wert nennt.',
    ],
  ])('%s says when each fails', (path, url, leaves) => {
    const text = prose(page(path));
    expect(text).toContain(url);
    expect(text).toContain(leaves);
  });
});

describe('idle-timeout and request-timeout on an HTTP/2 listener (#870)', () => {
  // The framework's own session and stream timers replaced the runtime's
  // session timer; Http2SessionIdle.test.ts and the stream receive-deadline
  // suites pin them.  What the page described before was the replaced timer:
  // armed through the runtime, doubled on Bun, Fastify's 72 s when unset.
  test.each([
    [
      'reference/configuration.mdx',
      [
        'It bounds an idle **HTTP/2 session** too, and `request-timeout` an HTTP/2 stream\'s receive.',
        'a session that has had no stream open for `idle-timeout` is closed with a GOAWAY — the same value on both runtimes, and a PING frame resets nothing — and a stream whose request is still arriving at `request-timeout` is answered `408` and reset.',
        'Unset, an idle HTTP/2 session is left to Fastify\'s own session timer — 72 s on Node, 144 s on Bun, which fires it at twice the value and lets a PING reset it — and on Hono over Node to nothing at all.',
        'On Bun the HTTP/2 listener bounds a connection that negotiates HTTP/1.1 on the same port by neither key, so there both are reported held for HTTP/2 only and `bind()` warns.',
        'None of this is the Hono backend under Bun',
      ],
      ['actor-ts states that rather than halving the number on Bun', 'actor-ts also arms each session\'s own idle timer'],
    ],
    [
      'de/reference/configuration.mdx',
      [
        'Er begrenzt auch eine untätige **HTTP/2-Session**, und `request-timeout` das Empfangen eines HTTP/2-Streams.',
        'eine Session, die `idle-timeout` lang keinen offenen Stream hatte, wird mit einem GOAWAY geschlossen — derselbe Wert auf beiden Runtimes, und ein PING-Frame setzt nichts zurück —, und ein Stream, dessen Request bei `request-timeout` noch eintrifft, wird mit `408` beantwortet und zurückgesetzt.',
        'Ungesetzt bleibt eine untätige HTTP/2-Session Fastifys eigenem Session-Timer überlassen — 72 s auf Node, 144 s auf Bun, das ihn beim doppelten Wert feuern lässt und von einem PING zurücksetzen lässt —, auf Hono über Node gar keiner Schranke.',
        'Auf Bun begrenzt der HTTP/2-Listener eine Verbindung, die auf demselben Port HTTP/1.1 aushandelt, mit keinem der beiden Keys; dort werden beide als nur für HTTP/2 wirksam gemeldet, und `bind()` warnt.',
        'Nichts davon betrifft das Hono-Backend unter Bun',
      ],
      ['statt die Zahl auf Bun zu halbieren', 'stellt actor-ts deshalb zusätzlich den eigenen Idle-Timer jeder Session scharf'],
    ],
  ])('%s describes the timers actor-ts runs, not the replaced one', (path, sentences, retired) => {
    const text = prose(page(path));
    for (const sentence of sentences) expect(text).toContain(sentence);
    for (const gone of retired) expect(text).not.toContain(gone);
  });
});
