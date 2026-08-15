/**
 * #591 — `actor-ts.remote.tls.enabled` shipped in `reference.conf`, was
 * documented, and was read by nothing.  `Cluster` hard-codes `null` for the
 * TLS argument of the transport it builds, so an operator who set the flag got
 * a plaintext cluster wire with no error, no log line and no way to tell from
 * the running node that the setting had been ignored.
 *
 * Implementing TLS is #941.  What is pinned here is the smaller promise this
 * issue makes: the node **says** the flag is not honoured, exactly once, at
 * startup, stays quiet in every case where saying it would be wrong, and
 * refuses to start on a value it cannot read as a boolean rather than picking
 * one of two defensible guesses about a security setting.
 *
 * The warning is emitted from the `Cluster` constructor, which these tests
 * reach directly instead of through `Cluster.join`.  `join` also `_start`s the
 * node, and the one configuration that produces the warning is the one with no
 * injected transport — so going through `join` would bind a real TCP listener
 * to observe a log line, adding a port to collide on and a teardown to get
 * wrong.  The constructor allocates and assigns; it opens no socket and arms
 * no timer.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import type { ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { LogLevel, type Logger } from '../../../src/Logger.js';

type LogRecord = { readonly level: string; readonly message: string };

/** Collects everything the system logger was told, including via `withSource`. */
class RecordingLogger implements Logger {
  readonly records: LogRecord[] = [];

  constructor(
    readonly level: LogLevel = LogLevel.Debug,
    private readonly root: RecordingLogger | null = null,
  ) {}

  private get sink(): RecordingLogger { return this.root ?? this; }

  private record(level: string, message: string): void {
    this.sink.records.push({ level, message });
  }

  debug(message: string): void { this.record('debug', message); }
  info(message: string): void { this.record('info', message); }
  warn(message: string): void { this.record('warn', message); }
  error(message: string): void { this.record('error', message); }

  withSource(_source: string): Logger { return new RecordingLogger(this.level, this.sink); }
  withFields(_fields: LogContextData): Logger { return new RecordingLogger(this.level, this.sink); }
}

/**
 * The private constructor these tests call.  A construct signature, so it is
 * an `interface` — and a deliberate reach past `private`, which is a
 * compile-time visibility rule and not a runtime one.
 */
interface ClusterConstructor {
  new (system: ActorSystem, options: ClusterOptionsType): Cluster;
}

const SELF = new NodeAddress('tls-warning', '127.0.0.1', 2_552);

const started: ActorSystem[] = [];

afterEach(async () => {
  const systems = started.splice(0, started.length);
  for (const system of systems) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

/**
 * A system whose config is `hocon` layered over the shipped defaults — the
 * same layering `ActorSystem.create` gives a real deployment, so the shipped
 * `enabled = false` is genuinely present underneath.
 */
function newSystem(hocon: string): { system: ActorSystem; log: RecordingLogger } {
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(log)
    .withConfig(Config.parseString(hocon));
  const system = ActorSystem.create('tls-warning', systemOptions);
  started.push(system);
  return { system, log };
}

function construct(system: ActorSystem, options: Partial<ClusterOptionsType> = {}): void {
  const full = { host: SELF.host, port: SELF.port, ...options } as ClusterOptionsType;
  new (Cluster as unknown as ClusterConstructor)(system, full);
}

function warningsIn(log: RecordingLogger): LogRecord[] {
  return log.records.filter((record) => record.message.includes(ConfigKeys.remote.tls.enabled));
}

describe('a node whose config asks for TLS says the wire is still plaintext', () => {
  test('the flag set to true warns once, naming the key and the follow-up issue', () => {
    const { system, log } = newSystem('actor-ts.remote.tls.enabled = true');

    construct(system);

    const warnings = warningsIn(log);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.level).toBe('warn');
    // The operator has to be able to act on this: which key, and what the node
    // is actually doing instead.  #941 is where the fix lands.
    expect(warnings[0]!.message).toContain('actor-ts.remote.tls.enabled');
    expect(warnings[0]!.message).toContain('plaintext');
    expect(warnings[0]!.message).toContain('#941');
  });

  test('a config that spells the shipped default out stays silent', () => {
    // `reference.conf` ships `enabled = false`, so a deployment that copied the
    // file wholesale must behave like one that never mentioned the key — the
    // rule `tombstone.min-retention` already follows (#841).
    const { system, log } = newSystem('actor-ts.remote.tls.enabled = false');

    construct(system);

    expect(warningsIn(log)).toEqual([]);
  });

  test('a config that never mentions TLS stays silent', () => {
    const { system, log } = newSystem('actor-ts.cluster.gossip-interval = 1s');

    construct(system);

    expect(warningsIn(log)).toEqual([]);
  });

  test('an injected transport is not warned about, even with the flag on', () => {
    // The caller built that transport and may have given it TLS material of its
    // own; the hard-coded `null` this warning is about only reaches a transport
    // the constructor built itself.
    const { system, log } = newSystem('actor-ts.remote.tls.enabled = true');

    construct(system, { transport: new InMemoryTransport(SELF) });

    expect(warningsIn(log)).toEqual([]);
  });

  test('the guard reads config, not the options object', () => {
    // Nothing in `ClusterOptionsType` carries TLS yet, so passing options can
    // neither silence the warning nor raise it — the only input is HOCON.
    const { system, log } = newSystem('actor-ts.remote.tls.enabled = true');

    construct(system, { maxFrameBytes: 1_024, roles: ['worker'] });

    expect(warningsIn(log)).toHaveLength(1);
  });

  test('an `on` spelling warns too, and the text does not quote back a spelling', () => {
    // HOCON's booleans are `true` / `on` / `yes`, and the config shape proposed
    // on #591 itself writes `off` — so the `on` spelling will occur in the
    // wild.  A message that said "is true" would send that operator hunting
    // their config for a line they never wrote.
    const { system, log } = newSystem('actor-ts.remote.tls.enabled = on');

    construct(system);

    const warnings = warningsIn(log);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).not.toContain('is true');
  });

  test('an explicitly null transport is warned about, like the absent one', () => {
    // The line the guard protects picks the transport with `??`, which falls
    // through on `null` as well — so a `null` builds the same plaintext
    // transport that `undefined` does and must not buy silence.  Unreachable
    // from typed code (`readonly transport?: Transport`), hence the cast; it is
    // pinned because the guard and the expression it guards drifting apart is
    // how the warning would go quiet without any test noticing.
    const { system, log } = newSystem('actor-ts.remote.tls.enabled = true');

    construct(system, { transport: null } as unknown as Partial<ClusterOptionsType>);

    expect(warningsIn(log)).toHaveLength(1);
  });
});

describe('a malformed value for the flag stops the node instead of guessing', () => {
  // The read goes through `Config.getBoolean`, so a value that is not a boolean
  // in any of HOCON's spellings throws `ConfigError` out of the constructor and
  // the node never comes up.  That is the deliberate half of #591's residual:
  // the tolerant alternative — treat anything unparseable as "not requested" —
  // would put the operator back in the state this issue is about, running
  // plaintext while their config says otherwise.  Startup is also the only
  // moment the mistake is cheap to see.
  test.each([
    ['a word that is not a boolean', 'maybe'],
    ['a numeric truthy', '1'],
  ])('%s throws out of the constructor', (_case, value) => {
    const { system } = newSystem(`actor-ts.remote.tls.enabled = ${value}`);

    expect(() => construct(system)).toThrow(ConfigError);
    // Actionable without reading the source: which key, and what it wanted.
    expect(() => construct(system)).toThrow(/actor-ts\.remote\.tls\.enabled/);
    expect(() => construct(system)).toThrow(/boolean/);
  });

  test('an injected transport is not held up by it', () => {
    // The value is only ever read to decide whether to warn, and an injected
    // transport is never warned about — so the node that cannot be wrong about
    // its own encryption is also the node that does not have to fix its config
    // first.  Keeps the strictness proportional to what it buys.
    const { system, log } = newSystem('actor-ts.remote.tls.enabled = maybe');

    expect(() => construct(system, { transport: new InMemoryTransport(SELF) })).not.toThrow();

    expect(warningsIn(log)).toEqual([]);
  });
});
