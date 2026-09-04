/**
 * The boot config dump — `actor-ts.diagnostics.log-config-on-start` (#867).
 *
 * Two halves.  The renderer is asserted directly, because the properties that
 * matter are properties of the *text*: what it withholds, what it admits it
 * does not withhold, and that a value cannot write a line of its own.  Then
 * the switch is asserted through a real `ActorSystem`, because "once, at
 * startup, only when asked" is a fact about the constructor and nothing
 * smaller can state it.
 *
 * **The gap is pinned deliberately.**  One case asserts that a secret in a
 * key named `dsn` is printed in full.  That is not an oversight left
 * un-fixed: redaction is by key name and cannot be anything else — a
 * `${?DATABASE_PASSWORD}` has resolved to a plain string long before the
 * merged tree exists — and the documentation says so in both languages.  A
 * test that only showed the heuristic working would let that sentence rot
 * into a promise the code does not keep.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { configDumpLines } from '../../../src/diagnostics/ConfigDump.js';
import { DiagnosticsOptions } from '../../../src/diagnostics/DiagnosticsOptions.js';
import { RecordingLogger, type RecordedLog } from '../../util/RecordingLogger.js';

/**
 * A layered config with no `application.conf` in the middle.
 *
 * The path is named and does not exist, so the middle layer is empty whatever
 * the working directory holds — a real `application.conf` beside the test
 * runner would otherwise change what the header prints.
 */
const layered = (overrides: Record<string, unknown>): Config =>
  Config.load({ appConfPath: 'no-such-application.conf', overrides });

const dumpOf = (log: RecordingLogger): RecordedLog[] =>
  log.records.filter((record) => record.message.startsWith('configuration in effect'));

describe('configDumpLines — the text the dump writes', () => {
  test('a value whose KEY says it is a secret is withheld', () => {
    const text = configDumpLines(layered({
      'actor-ts': { cache: { redis: { password: 'hunter2' } } },
    }));

    expect(text).toContain('actor-ts.cache.redis.password = <redacted>');
    expect(text).not.toContain('hunter2');
  });

  test('a secret whose key does NOT say so is printed — the stated gap', () => {
    // `dsn` matches none of pass|secret|token|key|credential|auth, and the
    // value carries the password inside a URL.  Both docs pages say this in
    // as many words; this is the assertion that keeps them true.
    const text = configDumpLines(layered({
      'my-app': { database: { dsn: 'postgres://user:hunter2@db/app' } },
    }));

    expect(text).toContain('my-app.database.dsn = "postgres://user:hunter2@db/app"');
  });

  test('every key names the layer it came from, and says when it displaced one', () => {
    const text = configDumpLines(layered({ 'actor-ts': { actor: { throughput: 7 } } }));

    // `actor.throughput` ships in reference.conf, so an override displaces a
    // real lower-layer value — which is the whole question the dump answers.
    expect(text).toContain('actor-ts.actor.throughput = 7  [override, overrides a lower layer]');
    // A key only reference.conf sets is reported plainly, with no claim that
    // anything was displaced.
    expect(text).toContain('actor-ts.dispatcher.throughput = 16  [reference]');
  });

  test('the header counts what it withheld and names the file it looked for', () => {
    const text = configDumpLines(layered({
      'actor-ts': { cache: { redis: { password: 'hunter2' } } },
    }));
    const head = text.split('\n')[0]!;

    expect(head).toContain('configuration in effect');
    expect(head).toContain('redacted by key name');
    expect(head).toContain('no-such-application.conf');
    // The count is a number of keys, and there are a great many; a header
    // reporting `0 keys` would mean the walk found nothing and every other
    // assertion here would be vacuous.
    expect(head).toMatch(/— (\d+) keys/);
    expect(Number(/— (\d+) keys/.exec(head)![1])).toBeGreaterThan(100);
  });

  test('a config with no layers says so rather than reporting everything as reference', () => {
    // `parseString` has one source and no precedence to explain.  Calling all
    // of it `reference` would be a guess dressed as an answer.
    const text = configDumpLines(Config.parseString('actor-ts.actor.throughput = 5'));

    expect(text.split('\n')[0]!).toContain('layers unavailable');
  });

  test('a newline inside a value cannot forge a line of the dump', () => {
    // The realistic route in is `${?SOMETHING}` out of the environment, which
    // resolves into the merged tree as an ordinary string.  JSON-encoding the
    // value is what keeps a dump line one dump line.
    const forgery = 'billing\n  actor-ts.cluster.seed-nodes = ["evil"]  [reference]';
    const text = configDumpLines(layered({ 'actor-ts': { system: { name: forgery } } }));

    expect(text.split('\n')).not.toContain('  actor-ts.cluster.seed-nodes = ["evil"]  [reference]');
    expect(text).toContain('actor-ts.system.name = "billing\\n  actor-ts.cluster.seed-nodes');
  });

  test('a list stays a list', () => {
    // Flattening `seed-nodes` into `seed-nodes.0` and `seed-nodes.1` would
    // turn one setting nobody configured into two.
    const text = configDumpLines(layered({
      'actor-ts': { cluster: { 'seed-nodes': ['one', 'two'] } },
    }));

    expect(text).toContain('actor-ts.cluster.seed-nodes = ["one","two"]');
  });
});

describe('actor-ts.diagnostics.log-config-on-start — the switch', () => {
  test('a system nobody configured writes no dump', async () => {
    const log = new RecordingLogger();
    const system = ActorSystem.create('dump-off', ActorSystemOptions.create().withLogger(log));

    // An absence, and it needs no polling: the dump is written on the
    // constructor's own stack or not at all.
    expect(dumpOf(log)).toHaveLength(0);
    await system.terminate();
  });

  test('HOCON turns it on, and the dump appears exactly once, at info', async () => {
    const log = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withConfig({ 'actor-ts': { diagnostics: { 'log-config-on-start': true } } });
    const system = ActorSystem.create('dump-on', systemOptions);

    expect(dumpOf(log)).toHaveLength(1);
    expect(dumpOf(log)[0]!.level).toBe('info');
    // `info` and not `debug`: an operator who asked for the dump has asked
    // for output, and a switch that needs a second switch reads as broken.
    expect(dumpOf(log)[0]!.message).toContain('actor-ts.diagnostics.log-config-on-start = true');

    // Still exactly one after the system has finished starting: the record is
    // written in the constructor, so nothing later can produce a second.
    await system.terminate();
    expect(dumpOf(log)).toHaveLength(1);
  });

  test('withDiagnostics turns it on too, so the explicit layer is reachable', async () => {
    const log = new RecordingLogger();
    const diagnosticsOptions = DiagnosticsOptions.create().withLogConfigOnStart();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withDiagnostics(diagnosticsOptions);
    const system = ActorSystem.create('dump-on-code', systemOptions);

    expect(dumpOf(log)).toHaveLength(1);
    await system.terminate();
  });

  test('the record a real system writes redacts the same keys the renderer does', async () => {
    const log = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withConfig({
        'actor-ts': {
          diagnostics: { 'log-config-on-start': true },
          cache: { redis: { password: 'hunter2' } },
        },
      });
    const system = ActorSystem.create('dump-redacts', systemOptions);

    expect(dumpOf(log)[0]!.message).toContain('actor-ts.cache.redis.password = <redacted>');
    expect(dumpOf(log)[0]!.message).not.toContain('hunter2');
    await system.terminate();
  });
});
