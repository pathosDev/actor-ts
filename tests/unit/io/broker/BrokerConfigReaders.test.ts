import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { Config, ConfigError } from '../../../../src/config/Config.js';
import {
  readWebsocketClientOptionsFromConfig,
  WebsocketClientActor,
} from '../../../../src/http/websocket/WebsocketClientActor.js';
import { ConfigKeys } from '../../../../src/config/ConfigKeys.js';
import { rejectRetiredLeaves, type RetiredLeaves } from '../../../../src/config/RetiredKeys.js';
import { AmqpActor, readAmqpOptionsFromConfig } from '../../../../src/io/broker/AmqpActor.js';
import { BrokerActor, type OutboundEnvelope } from '../../../../src/io/broker/BrokerActor.js';
import * as BrokerActorModule from '../../../../src/io/broker/BrokerActor.js';
import {
  brokerCommonKeysUnder,
  readBrokerCommonOptionsFromConfig,
  RETIRED_BROKER_COMMON_LEAVES,
  type BrokerCommonOptionsType,
} from '../../../../src/io/broker/BrokerOptions.js';
import * as BrokerOptionsModule from '../../../../src/io/broker/BrokerOptions.js';
import { EmailBridgeActor, readEmailBridgeOptionsFromConfig } from '../../../../src/io/broker/EmailBridgeActor.js';
import { GrpcClientActor, readGrpcClientOptionsFromConfig } from '../../../../src/io/broker/GrpcClientActor.js';
import { GrpcServerActor, readGrpcServerOptionsFromConfig } from '../../../../src/io/broker/GrpcServerActor.js';
import { JetStreamActor, readJetStreamOptionsFromConfig } from '../../../../src/io/broker/JetStreamActor.js';
import {
  JetStreamKeyValueActor,
  readJetStreamKeyValueOptionsFromConfig,
} from '../../../../src/io/broker/JetStreamKeyValueActor.js';
import {
  JetStreamObjectStoreActor,
  readJetStreamObjectStoreOptionsFromConfig,
} from '../../../../src/io/broker/JetStreamObjectStoreActor.js';
import { KafkaActor, readKafkaOptionsFromConfig } from '../../../../src/io/broker/KafkaActor.js';
import { MqttActor, readMqttOptionsFromConfig } from '../../../../src/io/broker/MqttActor.js';
import type { MqttMessage } from '../../../../src/io/broker/MqttMessages.js';
import { NatsActor, readNatsOptionsFromConfig } from '../../../../src/io/broker/NatsActor.js';
import { readRedisStreamsOptionsFromConfig, RedisStreamsActor } from '../../../../src/io/broker/RedisStreamsActor.js';
import { readSseOptionsFromConfig, SseActor } from '../../../../src/io/broker/SseActor.js';
import { readTcpServerOptionsFromConfig, TcpServerActor } from '../../../../src/io/broker/TcpServerActor.js';
import { readTcpSocketOptionsFromConfig, TcpSocketActor } from '../../../../src/io/broker/TcpSocketActor.js';
import { readUdpSocketOptionsFromConfig, UdpSocketActor } from '../../../../src/io/broker/UdpSocketActor.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { expectExactOptions } from '../../../util/ExactOptions.js';
import { createTestActorSystem } from '../../../util/TestActorSystem.js';

/**
 * The HOCON readers of the broker actors, block by block (#1443).
 *
 * The broker blocks publish no `reference.conf` leaves — their keys are
 * required-or-unset, so there is no default to ship — which means none of the
 * config guards that perturb `reference.conf` ever sets one.  What binds a
 * broker leaf is a test that writes it the way an operator would and checks
 * what the reader made of it, so that is what this file holds: an exact-object
 * read of each block, and for every spelling a rename retired, the refusal of
 * the old one beside the acceptance of the new one.
 */

/** Where the refusal looks, and the shape every broker root shares. */
const ROOT = 'actor-ts.io.broker.probe';

/** What `rejectRetiredLeaves` throws for `hocon`, or a failure naming its absence. */
function refusalOf(hocon: string, retired: Readonly<Record<string, string>>, codeNote?: string): ConfigError {
  const config = Config.parseString(hocon);
  try {
    if (codeNote === undefined) rejectRetiredLeaves(config, ROOT, retired);
    else rejectRetiredLeaves(config, ROOT, retired, codeNote);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error(`nothing refused ${hocon}`);
}

describe('the retired-leaf refusal a broker table relies on', () => {
  test('a dotted entry refuses a renamed child under its parent, naming both full paths', () => {
    // A broker block nests: the reconnect policy is a group, and the rename
    // moves its children while the group keeps its name.
    const refusal = refusalOf(
      `${ROOT}.reconnect.initialDelayMs = 200`,
      { 'reconnect.initialDelayMs': 'reconnect.initial-delay' },
    );
    expect(refusal.message).toContain(
      `${ROOT}.reconnect.initialDelayMs has been renamed to ${ROOT}.reconnect.initial-delay`,
    );
  });

  test('an old child under a renamed parent is caught by its own entry', () => {
    // `circuit-breaker { failureThreshold = 3 }` is half-converted: the group
    // entry cannot see it, because the group is already spelled the new way.
    const refusal = refusalOf(
      `${ROOT}.circuit-breaker { failureThreshold = 3, reset = 1s }`,
      { circuitBreaker: 'circuit-breaker', 'circuit-breaker.failureThreshold': 'circuit-breaker.failure-threshold' },
    );
    expect(refusal.message).toContain(
      `${ROOT}.circuit-breaker.failureThreshold has been renamed to ${ROOT}.circuit-breaker.failure-threshold`,
    );
  });

  test('a table that renamed code as well says so instead of the default note', () => {
    const note = 'The TypeScript field was renamed too: maxLineLen is maxLineBytes now.';
    const refusal = refusalOf(`${ROOT}.framing.maxLineLen = 4096`, { 'framing.maxLineLen': 'framing.max-line-bytes' }, note);
    expect(refusal.message).toContain(note);
    // The default claims the opposite, and the two cannot both stand.
    expect(refusal.message).not.toContain('field names and builder methods are unchanged');
  });

  test('without a note of its own, a table keeps the default: no code change', () => {
    const refusal = refusalOf(`${ROOT}.outboundBuffer = 10`, { outboundBuffer: 'outbound-buffer' });
    expect(refusal.message).toContain(
      'The TypeScript field names and builder methods are unchanged, so no code change is needed.',
    );
  });

  test('the message states the convention, not that the whole block is converted', () => {
    // The shared broker leaves are converted ahead of each protocol's own, so
    // a broker block is mixed in between; "every leaf in this block is
    // kebab-case now" would send an operator looking for a conversion that has
    // not happened yet.
    const refusal = refusalOf(`${ROOT}.outboundBuffer = 10`, { outboundBuffer: 'outbound-buffer' });
    expect(refusal.message).not.toContain('in this block is kebab-case');
    expect(refusal.message).toContain('HOCON keys are kebab-case');
  });
});

/* ------------------- the leaves every broker block shares ------------------- */

/** Every shared leaf, spelled the way an operator writes it. */
const FULL_COMMON_BLOCK = `
${ROOT} {
  reconnect {
    initial-delay = 250ms
    max-delay     = 20s
    factor        = 1.5
    max-attempts  = 7
    random-factor = 0.25
  }
  circuit-breaker {
    failure-threshold = 4
    reset             = 15s
  }
  outbound-buffer = 42
}
`;

describe('readBrokerCommonOptionsFromConfig', () => {
  test('a full kebab block reads into every field, and into nothing else', () => {
    // The values are chosen so a wrong accessor cannot pass: `250ms` is not a
    // number, `0.25` is not an integer, and `15s` is neither.
    const config = Config.parseString(FULL_COMMON_BLOCK);
    expectExactOptions(readBrokerCommonOptionsFromConfig(config, brokerCommonKeysUnder(ROOT)), {
      reconnect: { initialDelayMs: 250, maxDelayMs: 20_000, factor: 1.5, maxAttempts: 7, randomFactor: 0.25 },
      circuitBreaker: { failureThreshold: 4, resetMs: 15_000 },
      outboundBuffer: 42,
    });
  });

  test('an unset leaf is omitted, not written as undefined', () => {
    // An own `undefined` would shadow a lower layer in any spread; the reader
    // contract is that an unset leaf leaves no key behind.
    const config = Config.parseString(`${ROOT}.reconnect { max-attempts = 1 }`);
    expectExactOptions(readBrokerCommonOptionsFromConfig(config, brokerCommonKeysUnder(ROOT)), { reconnect: { maxAttempts: 1 } });
  });

  test('a root with no shared block reads as nothing at all', () => {
    const config = Config.parseString(`${ROOT}.endpoint = "probe.local"`);
    expectExactOptions(readBrokerCommonOptionsFromConfig(config, brokerCommonKeysUnder(ROOT)), {});
  });

  test('the composer reads the block under whichever root it is given', () => {
    // A subclass outside this package picks its own `configKey()`; the leaves
    // under it are read the same way, and a neighbouring broker's block is not.
    const config = Config.parseString(`
      acme.messaging.ledger { outbound-buffer = 9 }
      ${ROOT} { outbound-buffer = 42 }
    `);
    expectExactOptions(readBrokerCommonOptionsFromConfig(config, brokerCommonKeysUnder('acme.messaging.ledger')), { outboundBuffer: 9 });
  });

  test('every shared leaf is spelled in kebab-case, with the unit suffix dropped', () => {
    expectExactOptions(brokerCommonKeysUnder('acme.broker'), {
      root: 'acme.broker',
      reconnect: {
        root: 'acme.broker.reconnect',
        initialDelay: 'acme.broker.reconnect.initial-delay',
        maxDelay: 'acme.broker.reconnect.max-delay',
        factor: 'acme.broker.reconnect.factor',
        maxAttempts: 'acme.broker.reconnect.max-attempts',
        randomFactor: 'acme.broker.reconnect.random-factor',
      },
      circuitBreaker: {
        root: 'acme.broker.circuit-breaker',
        failureThreshold: 'acme.broker.circuit-breaker.failure-threshold',
        reset: 'acme.broker.circuit-breaker.reset',
      },
      outboundBuffer: 'acme.broker.outbound-buffer',
    });
  });

  test('`reconnect = false` is refused rather than read as an empty policy', () => {
    // The boolean form exists only as a constructor argument.  Read by full
    // path, `false` has no leaves to find, and the reader would hand back `{}`
    // — "retry forever on the defaults", the opposite of what was written.
    const config = Config.parseString(`${ROOT}.reconnect = false`);
    expect(() => readBrokerCommonOptionsFromConfig(config, brokerCommonKeysUnder(ROOT))).toThrow(`${ROOT}.reconnect`);
  });

  test('a circuit-breaker block needs both of its leaves', () => {
    const config = Config.parseString(`${ROOT}.circuit-breaker { failure-threshold = 3 }`);
    expect(() => readBrokerCommonOptionsFromConfig(config, brokerCommonKeysUnder(ROOT))).toThrow(`${ROOT}.circuit-breaker.reset`);
  });

  test('has one name, exported beside the keys it reads', () => {
    // The reader used to be `readCommonOptions`, with a one-line forwarder in
    // `BrokerActor.ts` carrying the name the dead-key gate registers: two
    // names for one function, and nothing saying which one a caller should
    // import.  The gate keys on the name alone, so it cannot see a forwarder.
    expect(Object.keys(BrokerOptionsModule)).toContain('readBrokerCommonOptionsFromConfig');
    expect(Object.keys(BrokerOptionsModule)).not.toContain('readCommonOptions');
    expect(Object.keys(BrokerActorModule)).not.toContain('readBrokerCommonOptionsFromConfig');
  });
});

/* --------------------- the same leaves through the actor --------------------- */

type ProbeOptions = BrokerCommonOptionsType & {
  readonly endpoint?: string;
  /** Never set by the constructor, so HOCON is the only layer that can supply it. */
  readonly tag?: string;
};

/**
 * The smallest broker that resolves its options the way every broker does,
 * in `preStart`, and keeps what came of it.  A failed resolution is recorded
 * rather than rethrown, so the system does not restart the actor into the same
 * failure while the test is reading it.
 */
class ProbeBroker extends BrokerActor<ProbeOptions, never, string> {
  preStartFailure: unknown = null;
  preStartSettled = false;

  constructor() { super({ endpoint: 'probe.local' }); }

  protected configKey(): string { return ROOT; }
  protected builtInDefaultOptions(): Partial<ProbeOptions> { return {}; }
  protected readOptionsFromConfig(_config: Config): Partial<ProbeOptions> { return {}; }
  protected requiredOptions(): ReadonlyArray<keyof ProbeOptions> { return ['endpoint']; }
  protected endpointLabel(): string { return 'probe.local'; }
  protected async connectImplementation(): Promise<void> {}
  protected async disconnectImplementation(): Promise<void> {}
  protected async dispatchOutgoing(_envelope: OutboundEnvelope<string>): Promise<void> {}
  protected override onCommand(_command: never): void {}

  override async preStart(): Promise<void> {
    try { await super.preStart(); }
    catch (e) { this.preStartFailure = e; }
    finally { this.preStartSettled = true; }
  }

  /** What `preStart` resolved — the base class keeps it protected. */
  resolved(): ProbeOptions { return this.options; }
}

/** Start a {@link ProbeBroker} under `hocon` and wait for its `preStart` to settle. */
async function startProbe<B extends ProbeBroker = ProbeBroker>(
  hocon: string,
  create: () => B = () => new ProbeBroker() as B,
): Promise<{ broker: B; terminate: () => Promise<void> }> {
  const system = createTestActorSystem({ name: 'broker-config-readers', config: Config.parseString(hocon) });
  let broker: B | null = null;
  system.spawnAnonymous(() => {
    broker = create();
    return broker as unknown as Actor<never>;
  });
  await awaitCondition(() => broker?.preStartSettled === true, {
    timeoutMs: 4_000, label: "the probe broker's preStart settled",
  });
  return { broker: broker!, terminate: () => system.terminate() };
}

/** One retired spelling, written both ways under the probe root. */
type RetiredSpelling = {
  /** The old path, relative to the root. */
  readonly retired: string;
  /** The path that replaced it. */
  readonly current: string;
  /** A block that sets the leaf the old way… */
  readonly retiredBlock: string;
  /** …and the same block the new way. */
  readonly currentBlock: string;
  /** The options field the new spelling lands in, and its value there. */
  readonly field: keyof BrokerCommonOptionsType;
  readonly resolved: unknown;
};

/**
 * The eight spellings the shared leaves had before #1443.  Spelled out here
 * rather than read from `RETIRED_BROKER_COMMON_LEAVES`: a list derived from the
 * table would lose a case with every entry deleted from it.
 */
const RETIRED_COMMON_SPELLINGS: ReadonlyArray<RetiredSpelling> = [
  {
    retired: 'reconnect.initialDelayMs',
    current: 'reconnect.initial-delay',
    retiredBlock: 'reconnect { initialDelayMs = 50 }',
    currentBlock: 'reconnect { initial-delay = 50 }',
    field: 'reconnect',
    resolved: { initialDelayMs: 50 },
  },
  {
    retired: 'reconnect.maxDelayMs',
    current: 'reconnect.max-delay',
    retiredBlock: 'reconnect { maxDelayMs = 500 }',
    currentBlock: 'reconnect { max-delay = 500 }',
    field: 'reconnect',
    resolved: { maxDelayMs: 500 },
  },
  {
    retired: 'reconnect.maxAttempts',
    current: 'reconnect.max-attempts',
    retiredBlock: 'reconnect { maxAttempts = 3 }',
    currentBlock: 'reconnect { max-attempts = 3 }',
    field: 'reconnect',
    resolved: { maxAttempts: 3 },
  },
  {
    retired: 'reconnect.randomFactor',
    current: 'reconnect.random-factor',
    retiredBlock: 'reconnect { randomFactor = 0 }',
    currentBlock: 'reconnect { random-factor = 0 }',
    field: 'reconnect',
    resolved: { randomFactor: 0 },
  },
  {
    retired: 'circuitBreaker',
    current: 'circuit-breaker',
    retiredBlock: 'circuitBreaker { failureThreshold = 3, resetMs = 1000 }',
    currentBlock: 'circuit-breaker { failure-threshold = 3, reset = 1000 }',
    field: 'circuitBreaker',
    resolved: { failureThreshold: 3, resetMs: 1000 },
  },
  {
    retired: 'circuit-breaker.failureThreshold',
    current: 'circuit-breaker.failure-threshold',
    retiredBlock: 'circuit-breaker { failureThreshold = 3, reset = 1000 }',
    currentBlock: 'circuit-breaker { failure-threshold = 3, reset = 1000 }',
    field: 'circuitBreaker',
    resolved: { failureThreshold: 3, resetMs: 1000 },
  },
  {
    retired: 'circuit-breaker.resetMs',
    current: 'circuit-breaker.reset',
    retiredBlock: 'circuit-breaker { failure-threshold = 3, resetMs = 1000 }',
    currentBlock: 'circuit-breaker { failure-threshold = 3, reset = 1000 }',
    field: 'circuitBreaker',
    resolved: { failureThreshold: 3, resetMs: 1000 },
  },
  {
    retired: 'outboundBuffer',
    current: 'outbound-buffer',
    retiredBlock: 'outboundBuffer = 7',
    currentBlock: 'outbound-buffer = 7',
    field: 'outboundBuffer',
    resolved: 7,
  },
];

describe('the shared leaves under a broker root', () => {
  test('the retired table names exactly the eight spellings, each with its replacement', () => {
    expect(RETIRED_BROKER_COMMON_LEAVES).toEqual(
      Object.fromEntries(RETIRED_COMMON_SPELLINGS.map((spelling) => [spelling.retired, spelling.current])),
    );
  });

  test.each([...RETIRED_COMMON_SPELLINGS])('$retired fails preStart, naming $current', async (spelling) => {
    const { broker, terminate } = await startProbe(`${ROOT} { ${spelling.retiredBlock} }`);
    try {
      expect(broker.preStartFailure).toBeInstanceOf(ConfigError);
      const message = (broker.preStartFailure as ConfigError).message;
      expect(message).toContain(`${ROOT}.${spelling.retired} has been renamed to ${ROOT}.${spelling.current}`);
    } finally {
      await terminate();
    }
  });

  test.each([...RETIRED_COMMON_SPELLINGS])('$current starts the actor and reaches its options', async (spelling) => {
    const { broker, terminate } = await startProbe(`${ROOT} { ${spelling.currentBlock} }`);
    try {
      expect(broker.preStartFailure).toBeNull();
      expectExactOptions<unknown>(broker.resolved()[spelling.field], spelling.resolved);
    } finally {
      await terminate();
    }
  });

  test('the full kebab block starts the actor with every field resolved', async () => {
    const { broker, terminate } = await startProbe(FULL_COMMON_BLOCK);
    try {
      expect(broker.preStartFailure).toBeNull();
      const resolved = broker.resolved();
      expectExactOptions(
        { reconnect: resolved.reconnect, circuitBreaker: resolved.circuitBreaker, outboundBuffer: resolved.outboundBuffer },
        {
          reconnect: { initialDelayMs: 250, maxDelayMs: 20_000, factor: 1.5, maxAttempts: 7, randomFactor: 0.25 },
          circuitBreaker: { failureThreshold: 4, resetMs: 15_000 },
          outboundBuffer: 42,
        },
      );
    } finally {
      await terminate();
    }
  });
});

/* ------------------ the readOptionsFromConfig contract ------------------ */

/** A probe whose own leaves are read, and retired, the way the test says. */
class ContractProbe extends ProbeBroker {
  constructor(
    private readonly read: (config: Config) => Partial<ProbeOptions>,
    private readonly retired: RetiredLeaves = {},
  ) { super(); }

  protected override readOptionsFromConfig(config: Config): Partial<ProbeOptions> { return this.read(config); }
  protected override retiredLeaves(): RetiredLeaves { return this.retired; }
}

/** The hook as it is meant to be written: full paths under `configKey()`. */
const readTagAtFullPath = (config: Config): Partial<ProbeOptions> =>
  (config.hasPath(`${ROOT}.tag`) ? { tag: config.getString(`${ROOT}.tag`) } : {});

/** The hook as the old contract had it: a name relative to the block. */
const readTagRelative = (config: Config): Partial<ProbeOptions> =>
  (config.hasPath('tag') ? { tag: config.getString('tag') } : {});

describe('readOptionsFromConfig is handed the system config', () => {
  test('a full path under configKey() reaches the resolved options', async () => {
    const { broker, terminate } = await startProbe(`${ROOT} { tag = "from-hocon" }`, () => new ContractProbe(readTagAtFullPath));
    try {
      expect(broker.preStartFailure).toBeNull();
      expect(broker.resolved().tag).toBe('from-hocon');
    } finally {
      await terminate();
    }
  });

  test('an override reading a relative name fails preStart, naming configKey() and the contract', async () => {
    const { broker, terminate } = await startProbe(`${ROOT} { tag = "from-hocon" }`, () => new ContractProbe(readTagRelative));
    try {
      expect(broker.preStartFailure).toBeInstanceOf(ConfigError);
      const message = (broker.preStartFailure as ConfigError).message;
      expect(message).toContain(`"${ROOT}"`);
      expect(message).toContain('"tag"');
      expect(message).toContain('full dotted paths under configKey()');
    } finally {
      await terminate();
    }
  });

  test('the refusal does not wait for the old name to be set: reading nothing is what it prevents', async () => {
    // The block exists for another reason, so the override's relative lookup
    // would have found nothing and the actor would have started on defaults.
    const { broker, terminate } = await startProbe(`${ROOT} { outbound-buffer = 5 }`, () => new ContractProbe(readTagRelative));
    try {
      expect(broker.preStartFailure).toBeInstanceOf(ConfigError);
      expect((broker.preStartFailure as ConfigError).message).toContain(`"${ROOT}"`);
    } finally {
      await terminate();
    }
  });

  test.each([
    ['another broker\'s block', 'actor-ts.io.broker.kafka.brokers'],
    ['a root that only shares the prefix', `${ROOT}-two.tag`],
    ['the parent of configKey()', 'actor-ts.io.broker'],
  ])('a path outside configKey() is refused: %s', async (_name, path) => {
    const hocon = [
      `${ROOT} { tag = "x" }`,
      `${ROOT}-two { tag = "y" }`,
      'actor-ts.io.broker.kafka { brokers = ["k:9092"] }',
    ].join('\n');
    const { broker, terminate } = await startProbe(
      hocon,
      () => new ContractProbe((config) => (config.hasPath(path) ? { tag: 'seen' } : {})),
    );
    try {
      expect(broker.preStartFailure).toBeInstanceOf(ConfigError);
      expect((broker.preStartFailure as ConfigError).message).toContain(`"${path}"`);
    } finally {
      await terminate();
    }
  });

  test('the view is still a Config, and getConfig(configKey()) hands out the block', async () => {
    let wasConfig = false;
    const { broker, terminate } = await startProbe(`${ROOT} { tag = "via-block" }`, () => new ContractProbe((config) => {
      wasConfig = config instanceof Config;
      return { tag: config.getConfig(ROOT).getString('tag') };
    }));
    try {
      expect(broker.preStartFailure).toBeNull();
      expect(wasConfig).toBe(true);
      expect(broker.resolved().tag).toBe('via-block');
    } finally {
      await terminate();
    }
  });

  test('the hook is not called when the block is absent', async () => {
    const { broker, terminate } = await startProbe('actor-ts.io.broker.kafka { brokers = ["k:9092"] }', () => new ContractProbe(() => {
      throw new Error('called without a block');
    }));
    try {
      expect(broker.preStartFailure).toBeNull();
    } finally {
      await terminate();
    }
  });
});

describe('retiredLeaves() refuses a subclass\'s own retired spellings', () => {
  test('a retired spelling fails preStart, naming both full paths', async () => {
    const { broker, terminate } = await startProbe(
      `${ROOT} { tagName = "old" }`,
      () => new ContractProbe(readTagAtFullPath, { tagName: 'tag' }),
    );
    try {
      expect(broker.preStartFailure).toBeInstanceOf(ConfigError);
      expect((broker.preStartFailure as ConfigError).message)
        .toContain(`${ROOT}.tagName has been renamed to ${ROOT}.tag`);
    } finally {
      await terminate();
    }
  });

  test('the spelling that replaced it is read', async () => {
    const { broker, terminate } = await startProbe(
      `${ROOT} { tag = "new" }`,
      () => new ContractProbe(readTagAtFullPath, { tagName: 'tag' }),
    );
    try {
      expect(broker.preStartFailure).toBeNull();
      expect(broker.resolved().tag).toBe('new');
    } finally {
      await terminate();
    }
  });

  test('a dotted entry reaches into a group', async () => {
    const { broker, terminate } = await startProbe(
      `${ROOT} { framing { maxLineLen = 64 } }`,
      () => new ContractProbe(readTagAtFullPath, { 'framing.maxLineLen': 'framing.max-line-bytes' }),
    );
    try {
      expect(broker.preStartFailure).toBeInstanceOf(ConfigError);
      expect((broker.preStartFailure as ConfigError).message)
        .toContain(`${ROOT}.framing.maxLineLen has been renamed to ${ROOT}.framing.max-line-bytes`);
    } finally {
      await terminate();
    }
  });

  test('by default a subclass retires nothing beyond the shared table', async () => {
    const { broker, terminate } = await startProbe(`${ROOT} { tagName = "old" }`);
    try {
      expect(broker.preStartFailure).toBeNull();
    } finally {
      await terminate();
    }
  });
});

/* ------------------------- each broker's own block ------------------------- */

/** The members of a broker this file reaches into: protected, so through a cast. */
type StartableBroker = {
  preStart(): Promise<void>;
  connectImplementation(): Promise<void>;
  disconnectImplementation(): Promise<void>;
  retiredLeaves(): RetiredLeaves;
  endpointLabel(): string;
  readonly options: Readonly<Record<string, unknown>>;
};

/** How starting a broker under a config came out. */
type BrokerStart = {
  readonly failure: unknown;
  /**
   * What `preStart` resolved, or `null` when resolution itself failed.  Set
   * before validation, so a value the validator would refuse is still visible.
   */
  readonly options: Readonly<Record<string, unknown>> | null;
  /** The connection label the actor resolved to, or `null` when it resolved nothing. */
  readonly label?: string | null;
};

/** A live actor to hand a broker whose options require a `target`. */
class Sink extends Actor<unknown> {
  override onReceive(_message: unknown): void {}
}

/**
 * Start one of the package's brokers under `hocon` with its transport stubbed
 * out, and report how `preStart` ended.  The stub is what lets every block be
 * read the way the actor reads it — through `configKey()`, the retired tables
 * and the system-config view — with no driver installed and nothing dialled.
 */
async function startBroker(
  hocon: string,
  create: (target: ActorRef<never>) => Actor<never>,
): Promise<BrokerStart> {
  const system = createTestActorSystem({ name: 'broker-blocks', config: Config.parseString(hocon) });
  try {
    const target = system.spawnAnonymous(() => new Sink()) as unknown as ActorRef<never>;
    let broker: StartableBroker | null = null;
    let failure: unknown = null;
    let settled = false;
    system.spawnAnonymous(() => {
      const actor = create(target);
      const startable = actor as unknown as StartableBroker;
      const preStart = startable.preStart.bind(actor);
      startable.preStart = async (): Promise<void> => {
        try { await preStart(); }
        catch (e) { failure = e; }
        finally { settled = true; }
      };
      startable.connectImplementation = async (): Promise<void> => {};
      startable.disconnectImplementation = async (): Promise<void> => {};
      broker = startable;
      return actor as unknown as Actor<unknown>;
    });
    await awaitCondition(() => settled, { timeoutMs: 4_000, label: "the broker's preStart settled" });
    let options: Readonly<Record<string, unknown>> | null = null;
    let label: string | null = null;
    try {
      options = (broker as StartableBroker | null)?.options ?? null;
      label = (broker as StartableBroker | null)?.endpointLabel() ?? null;
    } catch {
      options = null;
    }
    return { failure, options, label };
  } finally {
    await system.terminate();
  }
}

/** The table a broker's `retiredLeaves()` returns. */
function retiredLeavesOf(actor: Actor<never>): RetiredLeaves {
  return (actor as unknown as StartableBroker).retiredLeaves();
}

/** One retired spelling of a block's own leaf, written both ways. */
type BlockSpelling = {
  /** The old path, relative to the block's root. */
  readonly retired: string;
  /** The path that replaced it. */
  readonly current: string;
  /** The leaf set the old way, inside the block… */
  readonly retiredHocon: string;
  /** …and the new way. */
  readonly currentHocon: string;
  /** The options field the new spelling lands in, and its value there. */
  readonly field: string;
  readonly resolved: unknown;
};

/** One broker block: its root, how to make its actor, and what it needs to start at all. */
type BlockUnderTest = {
  readonly name: string;
  readonly root: string;
  readonly create: (target: ActorRef<never>) => Actor<never>;
  /** Leaves the actor needs set before it starts, written inside the block. */
  readonly required: string;
  /**
   * The spellings the block's own table retires, spelled out here rather than
   * read from the table: a list derived from the table would lose a case with
   * every entry deleted from it.  A block with no retired leaf of its own lists
   * a shared one, so that its root is shown to refuse one at all.
   */
  readonly spellings: ReadonlyArray<BlockSpelling>;
  /** Whether `spellings` is the block's own table, or a shared leaf standing in for an empty one. */
  readonly ownTable: boolean;
};

/** The smallest concrete MQTT actor: the base class leaves only `onMessage` to write. */
class BareMqttActor extends MqttActor {
  override onMessage(_message: MqttMessage): void {}
}

/** The smallest concrete WebSocket client: the base class leaves only `onMessage` to write. */
class BareWebsocketClient extends WebsocketClientActor<unknown, unknown> {
  onMessage(_message: unknown): void {}
}

/** What either gRPC side needs before it starts, written inside its block. */
const GRPC_REQUIRED = [
  'proto-path = ["./service.proto"]',
  'package-name = "service.v1"',
  'service-name = "Service"',
  'endpoint = "service.local:50051"',
].join('\n');

const OUTBOUND_BUFFER_SPELLING: BlockSpelling = {
  retired: 'outboundBuffer',
  current: 'outbound-buffer',
  retiredHocon: 'outboundBuffer = 9',
  currentHocon: 'outbound-buffer = 9',
  field: 'outboundBuffer',
  resolved: 9,
};

const BLOCKS: ReadonlyArray<BlockUnderTest> = [
  {
    name: 'amqp',
    root: ConfigKeys.io.broker.amqp.root,
    create: () => new AmqpActor() as unknown as Actor<never>,
    required: 'url = "amqp://mq.local:5672"',
    ownTable: true,
    spellings: [
      {
        retired: 'autoAcknowledge',
        current: 'auto-acknowledge',
        retiredHocon: 'autoAcknowledge = false',
        currentHocon: 'auto-acknowledge = false',
        field: 'autoAcknowledge',
        resolved: false,
      },
    ],
  },
  {
    // A target needs an inbound side, so every case carries `imap.host`; the
    // smtp cases add the two leaves an smtp side cannot start without.
    name: 'email-bridge',
    root: ConfigKeys.io.broker.emailBridge.root,
    create: (target) => new EmailBridgeActor({ target }) as unknown as Actor<never>,
    required: 'imap { host = "imap.local" }',
    ownTable: true,
    spellings: [
      ...([
        ['onProcessed', 'on-processed', '"mark-seen"', { onProcessed: 'mark-seen' }],
        ['moveToMailbox', 'move-to-mailbox', '"Archive"', { moveToMailbox: 'Archive' }],
        ['disableIdle', 'disable-idle', 'true', { disableIdle: true }],
        ['maxIdleTimeMs', 'max-idle-time', '5m', { maxIdleTimeMs: 300_000 }],
        ['pollIntervalMs', 'poll-interval', '45s', { pollIntervalMs: 45_000 }],
        // The cap on one message: `25M` is a size, 26 214 400 bytes.
        ['maxMessageBytes', 'max-message-bytes', '25M', { maxMessageBytes: 26_214_400 }],
        ['acknowledgmentTimeoutMs', 'acknowledgment-timeout', '30s', { acknowledgmentTimeoutMs: 30_000 }],
      ] as const).map(([retired, current, value, fields]): BlockSpelling => ({
        retired: `imap.${retired}`,
        current: `imap.${current}`,
        retiredHocon: `imap { ${retired} = ${value} }`,
        currentHocon: `imap { ${current} = ${value} }`,
        field: 'imap',
        resolved: { host: 'imap.local', ...fields },
      })),
      ...([
        // The cap on pooled SMTP connections.
        ['maxConnections', 'max-connections', 3, { maxConnections: 3 }],
        ['maxMessages', 'max-messages', 50, { maxMessages: 50 }],
      ] as const).map(([retired, current, value, fields]): BlockSpelling => ({
        retired: `smtp.${retired}`,
        current: `smtp.${current}`,
        retiredHocon: `smtp { host = "smtp.local", from = "alerts@example.test", ${retired} = ${value} }`,
        currentHocon: `smtp { host = "smtp.local", from = "alerts@example.test", ${current} = ${value} }`,
        field: 'smtp',
        resolved: { host: 'smtp.local', from: 'alerts@example.test', ...fields },
      })),
    ],
  },
  {
    name: 'grpc.client',
    root: ConfigKeys.io.broker.grpc.client.root,
    create: () => new GrpcClientActor() as unknown as Actor<never>,
    required: GRPC_REQUIRED,
    ownTable: true,
    spellings: [
      {
        retired: 'protoPath',
        current: 'proto-path',
        retiredHocon: 'protoPath = ["./orders.proto"]',
        currentHocon: 'proto-path = ["./orders.proto"]',
        field: 'protoPath',
        resolved: './orders.proto',
      },
      {
        retired: 'packageName',
        current: 'package-name',
        retiredHocon: 'packageName = "orders.v2"',
        currentHocon: 'package-name = "orders.v2"',
        field: 'packageName',
        resolved: 'orders.v2',
      },
      {
        retired: 'serviceName',
        current: 'service-name',
        retiredHocon: 'serviceName = "Ledger"',
        currentHocon: 'service-name = "Ledger"',
        field: 'serviceName',
        resolved: 'Ledger',
      },
      {
        retired: 'deadlineMs',
        current: 'deadline',
        retiredHocon: 'deadlineMs = 2000',
        currentHocon: 'deadline = 2s',
        field: 'deadlineMs',
        resolved: 2_000,
      },
    ],
  },
  {
    name: 'jetstream',
    root: ConfigKeys.io.broker.jetstream.root,
    create: () => new JetStreamActor() as unknown as Actor<never>,
    required: 'servers = ["nats://a:4222"]',
    ownTable: false,
    spellings: [OUTBOUND_BUFFER_SPELLING],
  },
  {
    name: 'jetstream-key-value',
    root: ConfigKeys.io.broker.jetstreamKeyValue.root,
    create: () => new JetStreamKeyValueActor() as unknown as Actor<never>,
    required: 'servers = ["nats://a:4222"]\nbucket = "sessions"',
    ownTable: true,
    spellings: [
      {
        retired: 'timeToLive',
        current: 'time-to-live',
        retiredHocon: 'timeToLive = 3600000',
        currentHocon: 'time-to-live = 1h',
        field: 'timeToLive',
        resolved: 3_600_000,
      },
      {
        // The per-value cap of the bucket.
        retired: 'maxValueBytes',
        current: 'max-value-bytes',
        retiredHocon: 'maxValueBytes = 65536',
        currentHocon: 'max-value-bytes = 64K',
        field: 'maxValueBytes',
        resolved: 65_536,
      },
    ],
  },
  {
    name: 'jetstream-object-store',
    root: ConfigKeys.io.broker.jetstreamObjectStore.root,
    create: () => new JetStreamObjectStoreActor() as unknown as Actor<never>,
    required: 'servers = ["nats://a:4222"]\nbucket = "assets"',
    ownTable: true,
    spellings: [
      {
        // The whole-object ceiling.
        retired: 'maxObjectBytes',
        current: 'max-object-bytes',
        retiredHocon: 'maxObjectBytes = 4194304',
        currentHocon: 'max-object-bytes = 4M',
        field: 'maxObjectBytes',
        resolved: 4_194_304,
      },
    ],
  },
  {
    name: 'kafka',
    root: ConfigKeys.io.broker.kafka.root,
    create: () => new KafkaActor() as unknown as Actor<never>,
    required: 'brokers = ["kafka.local:9092"]',
    ownTable: true,
    spellings: [
      {
        retired: 'clientId',
        current: 'client-id',
        retiredHocon: 'clientId = "orders-service"',
        currentHocon: 'client-id = "orders-service"',
        field: 'clientId',
        resolved: 'orders-service',
      },
      ...([
        ['groupId', 'group-id', '"orders"', { groupId: 'orders' }],
        ['fromBeginning', 'from-beginning', 'true', { fromBeginning: true }],
        ['commitMode', 'commit-mode', '"manual"', { commitMode: 'manual' }],
        ['commitTimeoutMs', 'commit-timeout', '5s', { commitTimeoutMs: 5_000 }],
      ] as const).map(([retired, current, value, fields]): BlockSpelling => ({
        retired: `consumer.${retired}`,
        current: `consumer.${current}`,
        retiredHocon: `consumer { ${retired} = ${value} }`,
        currentHocon: `consumer { ${current} = ${value} }`,
        field: 'consumer',
        resolved: fields,
      })),
    ],
  },
  {
    name: 'mqtt',
    root: ConfigKeys.io.broker.mqtt.root,
    create: () => new BareMqttActor() as unknown as Actor<never>,
    required: 'broker-url = "mqtt://broker.local:1883"',
    ownTable: true,
    spellings: [
      {
        retired: 'brokerUrl',
        current: 'broker-url',
        retiredHocon: 'brokerUrl = "mqtt://other.local:1883"',
        currentHocon: 'broker-url = "mqtt://other.local:1883"',
        field: 'brokerUrl',
        resolved: 'mqtt://other.local:1883',
      },
      {
        retired: 'clientId',
        current: 'client-id',
        retiredHocon: 'clientId = "hub"',
        currentHocon: 'client-id = "hub"',
        field: 'clientId',
        resolved: 'hub',
      },
      {
        retired: 'cleanSession',
        current: 'clean-session',
        retiredHocon: 'cleanSession = false',
        currentHocon: 'clean-session = false',
        field: 'cleanSession',
        resolved: false,
      },
      {
        // Seconds as a bare count before, a duration in whole seconds now.
        retired: 'keepAlive',
        current: 'keep-alive',
        retiredHocon: 'keepAlive = 30',
        currentHocon: 'keep-alive = 30s',
        field: 'keepAlive',
        resolved: 30,
      },
      {
        retired: 'protocolVersion',
        current: 'protocol-version',
        retiredHocon: 'protocolVersion = 5',
        currentHocon: 'protocol-version = 5',
        field: 'protocolVersion',
        resolved: 5,
      },
    ],
  },
  {
    name: 'nats',
    root: ConfigKeys.io.broker.nats.root,
    create: () => new NatsActor() as unknown as Actor<never>,
    required: 'servers = ["nats://a:4222"]',
    ownTable: false,
    spellings: [OUTBOUND_BUFFER_SPELLING],
  },
  {
    name: 'redis-streams',
    root: ConfigKeys.io.broker.redisStreams.root,
    create: () => new RedisStreamsActor() as unknown as Actor<never>,
    required: 'url = "redis://cache.local:6379"',
    ownTable: true,
    spellings: [
      {
        retired: 'blockMs',
        current: 'block',
        retiredHocon: 'blockMs = 2000',
        currentHocon: 'block = 2s',
        field: 'blockMs',
        resolved: 2_000,
      },
      {
        retired: 'consumerGroup',
        current: 'consumer-group',
        retiredHocon: 'consumerGroup { group = "orders", consumer = "worker-1" }',
        currentHocon: 'consumer-group { group = "orders", consumer = "worker-1" }',
        field: 'consumerGroup',
        resolved: { group: 'orders', consumer: 'worker-1' },
      },
      {
        // The old child under the new group: the `consumerGroup` entry cannot
        // see it, because the group is already spelled the new way.
        retired: 'consumer-group.createIfMissing',
        current: 'consumer-group.create-if-missing',
        retiredHocon: 'consumer-group { group = "orders", consumer = "worker-1", createIfMissing = false }',
        currentHocon: 'consumer-group { group = "orders", consumer = "worker-1", create-if-missing = false }',
        field: 'consumerGroup',
        resolved: { group: 'orders', consumer: 'worker-1', createIfMissing: false },
      },
    ],
  },
  {
    name: 'sse',
    root: ConfigKeys.io.broker.sse.root,
    create: (target) => new SseActor({ target }) as unknown as Actor<never>,
    required: 'url = "https://events.local/stream"',
    ownTable: true,
    spellings: [
      {
        retired: 'idleTimeoutMs',
        current: 'idle-timeout',
        retiredHocon: 'idleTimeoutMs = 60000',
        currentHocon: 'idle-timeout = 60s',
        field: 'idleTimeoutMs',
        resolved: 60_000,
      },
      {
        retired: 'connectTimeoutMs',
        current: 'connect-timeout',
        retiredHocon: 'connectTimeoutMs = 5000',
        currentHocon: 'connect-timeout = 5s',
        field: 'connectTimeoutMs',
        resolved: 5_000,
      },
    ],
  },
  {
    name: 'tcp',
    root: ConfigKeys.io.broker.tcp.root,
    create: (target) => new TcpSocketActor({ target }) as unknown as Actor<never>,
    required: 'host = "peer.local"\nport = 7000',
    ownTable: true,
    spellings: [
      {
        retired: 'idleTimeoutMs',
        current: 'idle-timeout',
        retiredHocon: 'idleTimeoutMs = 60000',
        currentHocon: 'idle-timeout = 60s',
        field: 'idleTimeoutMs',
        resolved: 60_000,
      },
      {
        retired: 'connectTimeoutMs',
        current: 'connect-timeout',
        retiredHocon: 'connectTimeoutMs = 5000',
        currentHocon: 'connect-timeout = 5s',
        field: 'connectTimeoutMs',
        resolved: 5_000,
      },
      {
        retired: 'keepAliveMs',
        current: 'keep-alive',
        retiredHocon: 'keepAliveMs = 30000',
        currentHocon: 'keep-alive = 30s',
        field: 'keepAliveMs',
        resolved: 30_000,
      },
    ],
  },
  {
    name: 'tcp-server',
    root: ConfigKeys.io.broker.tcpServer.root,
    create: (target) => new TcpServerActor({ target }) as unknown as Actor<never>,
    required: 'bind-port = 7001',
    ownTable: true,
    spellings: [
      {
        retired: 'bindHost',
        current: 'bind-host',
        retiredHocon: 'bindHost = "127.0.0.1"',
        currentHocon: 'bind-host = "127.0.0.1"',
        field: 'bindHost',
        resolved: '127.0.0.1',
      },
      {
        retired: 'bindPort',
        current: 'bind-port',
        retiredHocon: 'bindPort = 7002',
        currentHocon: 'bind-port = 7002',
        field: 'bindPort',
        resolved: 7002,
      },
      {
        // The admission cap: its old spelling, ignored, would restore the
        // unlimited default with nothing said.
        retired: 'maxConnections',
        current: 'max-connections',
        retiredHocon: 'maxConnections = 64',
        currentHocon: 'max-connections = 64',
        field: 'maxConnections',
        resolved: 64,
      },
    ],
  },
  {
    name: 'websocket',
    root: ConfigKeys.io.broker.websocket.root,
    create: () => new BareWebsocketClient() as unknown as Actor<never>,
    required: 'url = "ws://feed.local/stream"',
    ownTable: true,
    spellings: [
      {
        retired: 'pingIntervalMs',
        current: 'ping-interval',
        retiredHocon: 'pingIntervalMs = 30000',
        currentHocon: 'ping-interval = 30s',
        field: 'pingIntervalMs',
        resolved: 30_000,
      },
      {
        // The inbound frame cap.
        retired: 'maxFrameBytes',
        current: 'max-frame-bytes',
        retiredHocon: 'maxFrameBytes = 65536',
        currentHocon: 'max-frame-bytes = 64K',
        field: 'maxFrameBytes',
        resolved: 65_536,
      },
      {
        retired: 'idleTimeoutMs',
        current: 'idle-timeout',
        retiredHocon: 'idleTimeoutMs = 90000',
        currentHocon: 'idle-timeout = 90s',
        field: 'idleTimeoutMs',
        resolved: 90_000,
      },
      {
        retired: 'connectTimeoutMs',
        current: 'connect-timeout',
        retiredHocon: 'connectTimeoutMs = 10000',
        currentHocon: 'connect-timeout = 10s',
        field: 'connectTimeoutMs',
        resolved: 10_000,
      },
    ],
  },
  {
    name: 'udp',
    root: ConfigKeys.io.broker.udp.root,
    create: (target) => new UdpSocketActor({ target }) as unknown as Actor<never>,
    required: '',
    ownTable: true,
    spellings: [
      {
        retired: 'bindHost',
        current: 'bind-host',
        retiredHocon: 'bindHost = "127.0.0.1"',
        currentHocon: 'bind-host = "127.0.0.1"',
        field: 'bindHost',
        resolved: '127.0.0.1',
      },
      {
        retired: 'bindPort',
        current: 'bind-port',
        retiredHocon: 'bindPort = 5005',
        currentHocon: 'bind-port = 5005',
        field: 'bindPort',
        resolved: 5005,
      },
    ],
  },
];

/** Every (block, spelling) pair, flattened for `test.each`. */
const BLOCK_SPELLINGS = BLOCKS.flatMap((block) => block.spellings.map((spelling) => ({
  ...spelling, block, label: `${block.name}: ${spelling.retired}`,
})));

describe('each broker block refuses its retired spellings and reads their replacements', () => {
  test.each(BLOCKS.map((block) => [block.name, block] as const))('%s — configKey() is its ConfigKeys group\'s root', (_name, block) => {
    const actor = block.create(null as unknown as ActorRef<never>) as unknown as { configKey(): string };
    expect(actor.configKey()).toBe(block.root);
  });

  test.each(BLOCKS.filter((block) => block.ownTable).map((block) => [block.name, block] as const))(
    '%s — the retired table names exactly the spellings listed here',
    (_name, block) => {
      expect(retiredLeavesOf(block.create(null as unknown as ActorRef<never>))).toEqual(
        Object.fromEntries(block.spellings.map((spelling) => [spelling.retired, spelling.current])),
      );
    },
  );

  test.each(BLOCKS.filter((block) => !block.ownTable).map((block) => [block.name, block] as const))(
    '%s — has no retired leaf of its own',
    (_name, block) => {
      expect(retiredLeavesOf(block.create(null as unknown as ActorRef<never>))).toEqual({});
    },
  );

  test.each(BLOCK_SPELLINGS)('$label fails preStart, naming both full paths', async (spelling) => {
    const { root, required, create } = spelling.block;
    const started = await startBroker(`${root} {\n${required}\n${spelling.retiredHocon}\n}`, create);
    expect(started.failure).toBeInstanceOf(ConfigError);
    expect((started.failure as ConfigError).message)
      .toContain(`${root}.${spelling.retired} has been renamed to ${root}.${spelling.current}`);
  });

  test.each(BLOCK_SPELLINGS)('$label — its replacement starts the actor and reaches its options', async (spelling) => {
    const { root, required, create } = spelling.block;
    const started = await startBroker(`${root} {\n${required}\n${spelling.currentHocon}\n}`, create);
    expect(started.failure).toBeNull();
    expect(started.options?.[spelling.field]).toEqual(spelling.resolved);
  });
});

describe('readAmqpOptionsFromConfig', () => {
  test('a full kebab block reads into every field, and into nothing else', () => {
    const config = Config.parseString(`${ConfigKeys.io.broker.amqp.root} {
      url              = "amqp://user@mq.local:5672/orders"
      prefetch         = 16
      auto-acknowledge = false
    }`);
    expectExactOptions(readAmqpOptionsFromConfig(config), {
      url: 'amqp://user@mq.local:5672/orders',
      prefetch: 16,
      autoAcknowledge: false,
    });
  });

  test('an absent block reads as nothing at all', () => {
    expectExactOptions(readAmqpOptionsFromConfig(Config.parseString('actor-ts.io.broker.nats.name = "x"')), {});
  });
});

describe('readEmailBridgeOptionsFromConfig', () => {
  const root = ConfigKeys.io.broker.emailBridge.root;

  test('a full kebab block reads into every field of both halves, and into nothing else', () => {
    const config = Config.parseString(`${root} {
      imap {
        host                   = "imap.local"
        port                   = 1143
        secure                 = false
        user                   = "reader"
        password               = "pw"
        mailbox                = "Watched"
        on-processed           = "move"
        move-to-mailbox        = "Archive"
        disable-idle           = true
        max-idle-time          = 5m
        poll-interval          = 30s
        max-message-bytes      = 1M
        acknowledgment-timeout = 45s
      }
      smtp {
        host            = "smtp.local"
        port            = 2465
        secure          = true
        user            = "sender"
        password        = "pw2"
        from            = "noreply@example.test"
        max-connections = 7
        max-messages    = 8
      }
    }`);
    expectExactOptions(readEmailBridgeOptionsFromConfig(config), {
      imap: {
        host: 'imap.local',
        port: 1143,
        secure: false,
        user: 'reader',
        password: 'pw',
        mailbox: 'Watched',
        onProcessed: 'move',
        moveToMailbox: 'Archive',
        disableIdle: true,
        maxIdleTimeMs: 300_000,
        pollIntervalMs: 30_000,
        maxMessageBytes: 1_048_576,
        acknowledgmentTimeoutMs: 45_000,
      },
      smtp: {
        host: 'smtp.local',
        port: 2465,
        secure: true,
        user: 'sender',
        password: 'pw2',
        from: 'noreply@example.test',
        maxConnections: 7,
        maxMessages: 8,
      },
    });
  });

  test('max-message-bytes is a size: 25M reads as 26214400 bytes', () => {
    // `getInt` refused this outright, so the one cap the docs tell a
    // deployment to lower could not be written the way every other size is.
    const config = Config.parseString(`${root}.imap.max-message-bytes = 25M`);
    expectExactOptions(readEmailBridgeOptionsFromConfig(config), { imap: { maxMessageBytes: 26_214_400 } });
  });

  test('the retired on-processed value is refused by its full kebab path', () => {
    const config = Config.parseString(`${root}.imap.on-processed = "markSeen"`);
    expect(() => readEmailBridgeOptionsFromConfig(config))
      .toThrow(`${root}.imap.on-processed = "markSeen" has been renamed to "mark-seen"`);
  });
});

describe('readGrpcClientOptionsFromConfig', () => {
  test('a full kebab block reads into every field, and into nothing else', () => {
    // `2s` is no number, so a getter other than getDuration fails on `deadline`.
    const config = Config.parseString(`${ConfigKeys.io.broker.grpc.client.root} {
      proto-path   = ["./a.proto", "./b.proto"]
      package-name = "orders.v1"
      service-name = "Orders"
      endpoint     = "orders.local:50051"
      deadline     = 2s
    }`);
    expectExactOptions(readGrpcClientOptionsFromConfig(config), {
      protoPath: ['./a.proto', './b.proto'],
      packageName: 'orders.v1',
      serviceName: 'Orders',
      endpoint: 'orders.local:50051',
      deadlineMs: 2_000,
    });
  });

  test.each([
    ['a single path, the way the docs write it', '"./orders.proto"', './orders.proto'],
    ['a one-element list', '["./orders.proto"]', './orders.proto'],
    ['several paths', '["./a.proto", "./b.proto"]', ['./a.proto', './b.proto']],
  ])('proto-path takes %s', (_name, hocon, expected) => {
    const config = Config.parseString(`${ConfigKeys.io.broker.grpc.client.root}.proto-path = ${hocon}`);
    expectExactOptions(readGrpcClientOptionsFromConfig(config), { protoPath: expected });
  });
});

/** The members of the gRPC server this file reaches into: private, so through a cast. */
type StartableGrpcServer = {
  preStart(): Promise<void>;
  bindServer(): Promise<void>;
  readonly options?: Readonly<Record<string, unknown>>;
};

/**
 * Start a `GrpcServerActor` under `hocon` with nothing bound, and report how
 * `preStart` ended.  It is a plain actor, not a `BrokerActor`: it resolves its
 * own options, so it gets a harness of its own.
 */
async function startGrpcServer(hocon: string): Promise<BrokerStart> {
  const system = createTestActorSystem({ name: 'grpc-server-block', config: Config.parseString(hocon) });
  try {
    let server: StartableGrpcServer | null = null;
    let failure: unknown = null;
    let settled = false;
    system.spawnAnonymous(() => {
      const actor = new GrpcServerActor({ handlers: {} });
      const startable = actor as unknown as StartableGrpcServer;
      const preStart = startable.preStart.bind(actor);
      startable.preStart = async (): Promise<void> => {
        try { await preStart(); }
        catch (e) { failure = e; }
        finally { settled = true; }
      };
      startable.bindServer = async (): Promise<void> => {};
      server = startable;
      return actor;
    });
    await awaitCondition(() => settled, { timeoutMs: 4_000, label: "the gRPC server's preStart settled" });
    return { failure, options: (server as StartableGrpcServer | null)?.options ?? null };
  } finally {
    await system.terminate();
  }
}

/** What the gRPC server needs before it starts, written inside its block. */
const GRPC_SERVER_REQUIRED = [
  'proto-path = ["./service.proto"]',
  'package-name = "service.v1"',
  'service-name = "Service"',
  'bind = "127.0.0.1:0"',
].join('\n');

/** The server's retired spellings — it refuses them itself, so they have no hook to read. */
const GRPC_SERVER_SPELLINGS: ReadonlyArray<BlockSpelling> = [
  {
    retired: 'protoPath',
    current: 'proto-path',
    retiredHocon: 'protoPath = ["./orders.proto"]',
    currentHocon: 'proto-path = ["./orders.proto"]',
    field: 'protoPath',
    resolved: './orders.proto',
  },
  {
    retired: 'packageName',
    current: 'package-name',
    retiredHocon: 'packageName = "orders.v2"',
    currentHocon: 'package-name = "orders.v2"',
    field: 'packageName',
    resolved: 'orders.v2',
  },
  {
    retired: 'serviceName',
    current: 'service-name',
    retiredHocon: 'serviceName = "Ledger"',
    currentHocon: 'service-name = "Ledger"',
    field: 'serviceName',
    resolved: 'Ledger',
  },
];

describe('the gRPC server block', () => {
  const root = ConfigKeys.io.broker.grpc.server.root;

  test.each([...GRPC_SERVER_SPELLINGS])('$retired fails preStart in resolveOptions, naming both full paths', async (spelling) => {
    const started = await startGrpcServer(`${root} {\n${GRPC_SERVER_REQUIRED}\n${spelling.retiredHocon}\n}`);
    expect(started.failure).toBeInstanceOf(ConfigError);
    expect((started.failure as ConfigError).message)
      .toContain(`${root}.${spelling.retired} has been renamed to ${root}.${spelling.current}`);
  });

  test.each([...GRPC_SERVER_SPELLINGS])('$current starts the server and reaches its options', async (spelling) => {
    const started = await startGrpcServer(`${root} {\n${GRPC_SERVER_REQUIRED}\n${spelling.currentHocon}\n}`);
    expect(started.failure).toBeNull();
    expect(started.options?.[spelling.field]).toEqual(spelling.resolved);
  });

  test('readGrpcServerOptionsFromConfig reads a full kebab block into every field, and into nothing else', () => {
    const config = Config.parseString(`${root} {
      proto-path   = ["./a.proto", "./b.proto"]
      package-name = "orders.v1"
      service-name = "Orders"
      bind         = "0.0.0.0:50051"
    }`);
    expectExactOptions(readGrpcServerOptionsFromConfig(config), {
      protoPath: ['./a.proto', './b.proto'],
      packageName: 'orders.v1',
      serviceName: 'Orders',
      bind: '0.0.0.0:50051',
    });
  });

  test('proto-path takes a single path, the way the docs write it', () => {
    const config = Config.parseString(`${root}.proto-path = "./orders.proto"`);
    expectExactOptions(readGrpcServerOptionsFromConfig(config), { protoPath: './orders.proto' });
  });
});

describe('readJetStreamOptionsFromConfig', () => {
  const root = ConfigKeys.io.broker.jetstream.root;

  test('a full block reads into every field, and into nothing else', () => {
    const config = Config.parseString(`${root} {
      servers  = ["nats://a:4222"]
      token    = "t0k3n"
      user     = "bridge"
      password = "s3cret"
      name     = "orders-bridge"
      stream {
        name         = "ORDERS"
        subjects     = ["orders.>"]
        retention    = "workqueue"
        storage      = "file"
        max-messages = 1000
        max-bytes    = 1G
        max-age      = 86400000000000
        create       = false
      }
      consumer {
        durable                    = "order-processor"
        mode                       = "pull"
        deliver-policy             = "last"
        ack-policy                 = "explicit"
        ack-wait                   = 45s
        filter-subject             = "orders.new"
        max-acknowledgment-pending = 64
        create                     = false
      }
      acknowledgment-timeout = 2m
    }`);
    expectExactOptions(readJetStreamOptionsFromConfig(config), {
      servers: ['nats://a:4222'],
      token: 't0k3n',
      user: 'bridge',
      password: 's3cret',
      name: 'orders-bridge',
      stream: {
        name: 'ORDERS',
        subjects: ['orders.>'],
        retention: 'workqueue',
        storage: 'file',
        maxMessages: 1000,
        maxBytes: 1_073_741_824,
        maxAge: 86_400_000_000_000,
        create: false,
      },
      consumer: {
        durable: 'order-processor',
        mode: 'pull',
        deliverPolicy: 'last',
        ackPolicy: 'explicit',
        ackWaitMs: 45_000,
        filterSubject: 'orders.new',
        maxAcknowledgmentPending: 64,
        create: false,
      },
      acknowledgmentTimeout: 120_000,
    });
  });

  test('a stream or consumer block without its optional leaves omits them, rather than writing undefined', () => {
    const config = Config.parseString(`${root} {
      stream { name = "ORDERS", subjects = ["orders.>"] }
      consumer { durable = "order-processor" }
    }`);
    expectExactOptions(readJetStreamOptionsFromConfig(config), {
      stream: { name: 'ORDERS', subjects: ['orders.>'] },
      consumer: { durable: 'order-processor' },
    });
  });

  test('the deliver-policy object arm reads into its kind', () => {
    const config = Config.parseString(`${root}.consumer {
      durable = "order-processor"
      deliver-policy { kind = "by-start-sequence", start-seq = 4242 }
    }`);
    expectExactOptions(readJetStreamOptionsFromConfig(config), {
      consumer: { durable: 'order-processor', deliverPolicy: { kind: 'by-start-sequence', startSeq: 4242 } },
    });
  });

  test('a retired deliver-policy kind is refused by its full kebab path', () => {
    const config = Config.parseString(`${root}.consumer.deliver-policy { kind = "byStartSeq", start-seq = 1 }`);
    expect(() => readJetStreamOptionsFromConfig(config))
      .toThrow(`${root}.consumer.deliver-policy.kind = 'byStartSeq' has been renamed to 'by-start-sequence'`);
  });
});

describe('readJetStreamKeyValueOptionsFromConfig', () => {
  test('a full kebab block reads into every field, and into nothing else', () => {
    // `1h` and `64K` are no numbers: getDuration and getBytes are what read them.
    const config = Config.parseString(`${ConfigKeys.io.broker.jetstreamKeyValue.root} {
      servers         = ["nats://a:4222"]
      token           = "t0k3n"
      user            = "bridge"
      password        = "s3cret"
      name            = "sessions-bridge"
      bucket          = "sessions"
      history         = 5
      time-to-live    = 1h
      storage         = "memory"
      replicas        = 3
      max-value-bytes = 64K
      create          = false
    }`);
    expectExactOptions(readJetStreamKeyValueOptionsFromConfig(config), {
      servers: ['nats://a:4222'],
      token: 't0k3n',
      user: 'bridge',
      password: 's3cret',
      name: 'sessions-bridge',
      bucket: 'sessions',
      history: 5,
      timeToLive: 3_600_000,
      storage: 'memory',
      replicas: 3,
      maxValueBytes: 65_536,
      create: false,
    });
  });

  test('the actor labels its servers as configured, with no second nats:// in front', async () => {
    const root = ConfigKeys.io.broker.jetstreamKeyValue.root;
    const started = await startBroker(
      `${root} {\nservers = ["nats://a:4222", "nats://b:4222"]\nbucket = "sessions"\n}`,
      () => new JetStreamKeyValueActor() as unknown as Actor<never>,
    );
    expect(started.failure).toBeNull();
    expect(started.label).toBe('nats://a:4222,nats://b:4222/kv/sessions');
  });
});

describe('readJetStreamObjectStoreOptionsFromConfig', () => {
  test('a full kebab block reads into every field, and into nothing else', () => {
    const config = Config.parseString(`${ConfigKeys.io.broker.jetstreamObjectStore.root} {
      servers          = ["nats://a:4222"]
      token            = "t0k3n"
      user             = "bridge"
      password         = "s3cret"
      name             = "assets-bridge"
      bucket           = "assets"
      description      = "build artefacts"
      storage          = "file"
      replicas         = 3
      max-object-bytes = 4M
      create           = false
    }`);
    expectExactOptions(readJetStreamObjectStoreOptionsFromConfig(config), {
      servers: ['nats://a:4222'],
      token: 't0k3n',
      user: 'bridge',
      password: 's3cret',
      name: 'assets-bridge',
      bucket: 'assets',
      description: 'build artefacts',
      storage: 'file',
      replicas: 3,
      maxObjectBytes: 4_194_304,
      create: false,
    });
  });
});

describe('readKafkaOptionsFromConfig', () => {
  const root = ConfigKeys.io.broker.kafka.root;

  test('a full kebab block reads into every field, and into nothing else', () => {
    const config = Config.parseString(`${root} {
      brokers   = ["kafka-1:9092", "kafka-2:9092"]
      client-id = "orders-service"
      ssl       = true
      sasl { mechanism = "scram-sha-256", username = "svc", password = "pw" }
      producer { idempotent = true, allow-auto-topic-creation = true }
      consumer {
        group-id       = "orders"
        from-beginning = true
        commit-mode    = "manual"
        commit-timeout = 45s
      }
      topics = ["orders", "payments"]
    }`);
    expectExactOptions(readKafkaOptionsFromConfig(config), {
      brokers: ['kafka-1:9092', 'kafka-2:9092'],
      clientId: 'orders-service',
      ssl: true,
      sasl: { mechanism: 'scram-sha-256', username: 'svc', password: 'pw' },
      producer: { idempotent: true, allowAutoTopicCreation: true },
      consumer: { groupId: 'orders', fromBeginning: true, commitMode: 'manual', commitTimeoutMs: 45_000 },
      topics: ['orders', 'payments'],
    });
  });

  test('consumer.commit-timeout is a duration: 5s reads as 5000', () => {
    // `getNumber` refused `5s` outright, so the timeout could only be written
    // as a bare millisecond count.
    const config = Config.parseString(`${root}.consumer.commit-timeout = 5s`);
    expectExactOptions(readKafkaOptionsFromConfig(config), { consumer: { commitTimeoutMs: 5_000 } });
  });

  test('the reader reports a partial producer block as written; the actor layers the defaults under it', async () => {
    const config = Config.parseString(`${root}.producer.idempotent = true`);
    expectExactOptions(readKafkaOptionsFromConfig(config), { producer: { idempotent: true } });

    const started = await startBroker(
      `${root} {\nbrokers = ["kafka.local:9092"]\nproducer { idempotent = true }\n}`,
      () => new KafkaActor() as unknown as Actor<never>,
    );
    expect(started.failure).toBeNull();
    expect(started.options?.['producer']).toEqual({ idempotent: true, allowAutoTopicCreation: false });
  });

  test('sasl needs all three of its leaves', () => {
    const config = Config.parseString(`${root}.sasl { mechanism = "plain", username = "svc" }`);
    expect(() => readKafkaOptionsFromConfig(config)).toThrow(`${root}.sasl.password`);
  });
});

describe('readMqttOptionsFromConfig', () => {
  const root = ConfigKeys.io.broker.mqtt.root;

  test('a full kebab block reads into every field, and into nothing else', () => {
    const config = Config.parseString(`${root} {
      broker-url       = "mqtts://broker.local:8883"
      client-id        = "hub"
      credentials { username = "iot", password = "pw" }
      qos              = 1
      will { topic = "devices/42/status", payload = "offline", qos = 1, retain = true }
      clean-session    = false
      keep-alive       = 45s
      protocol-version = 5
    }`);
    expectExactOptions(readMqttOptionsFromConfig(config), {
      brokerUrl: 'mqtts://broker.local:8883',
      clientId: 'hub',
      credentials: { username: 'iot', password: 'pw' },
      qos: 1,
      will: { topic: 'devices/42/status', payload: 'offline', qos: 1, retain: true },
      cleanSession: false,
      keepAlive: 45,
      protocolVersion: 5,
    });
  });

  test('a credentials or will block without its optional leaves omits them', () => {
    const config = Config.parseString(`${root} {
      credentials { username = "iot" }
      will { topic = "devices/42/status" }
    }`);
    expectExactOptions(readMqttOptionsFromConfig(config), {
      credentials: { username: 'iot' },
      will: { topic: 'devices/42/status', payload: '' },
    });
  });

  test.each([
    ['30s', 30],
    ['2m', 120],
    ['0s', 0],
    ['0', 0],
  ])('keep-alive = %s reads as %d seconds', (value, seconds) => {
    const config = Config.parseString(`${root}.keep-alive = ${value}`);
    expectExactOptions(readMqttOptionsFromConfig(config), { keepAlive: seconds });
  });

  test.each([
    ['a sub-second duration', '1500ms'],
    ['a bare number, which HOCON reads as milliseconds', '30'],
  ])('keep-alive refuses %s, naming the key', (_name, value) => {
    const config = Config.parseString(`${root}.keep-alive = ${value}`);
    expect(() => readMqttOptionsFromConfig(config)).toThrow(ConfigError);
    expect(() => readMqttOptionsFromConfig(config)).toThrow(`${root}.keep-alive`);
  });
});

describe('readNatsOptionsFromConfig', () => {
  test('a full block reads into every field, and into nothing else', () => {
    const config = Config.parseString(`${ConfigKeys.io.broker.nats.root} {
      servers  = ["nats://a:4222", "nats://b:4222"]
      token    = "t0k3n"
      user     = "bridge"
      password = "s3cret"
      name     = "orders-bridge"
    }`);
    expectExactOptions(readNatsOptionsFromConfig(config), {
      servers: ['nats://a:4222', 'nats://b:4222'],
      token: 't0k3n',
      user: 'bridge',
      password: 's3cret',
      name: 'orders-bridge',
    });
  });
});

describe('readRedisStreamsOptionsFromConfig', () => {
  const root = ConfigKeys.io.broker.redisStreams.root;

  test('a full kebab block reads into every field, and into nothing else', () => {
    // `2s` is no number: a getter other than getDuration fails on `block`.
    const config = Config.parseString(`${root} {
      url     = "redis://cache.local:6379"
      streams = ["orders", "payments"]
      block   = 2s
      consumer-group {
        group             = "orders"
        consumer          = "worker-1"
        create-if-missing = false
      }
    }`);
    expectExactOptions(readRedisStreamsOptionsFromConfig(config), {
      url: 'redis://cache.local:6379',
      streams: ['orders', 'payments'],
      blockMs: 2_000,
      consumerGroup: { group: 'orders', consumer: 'worker-1', createIfMissing: false },
    });
  });

  test('an unset create-if-missing is omitted from the group, not written as undefined', () => {
    const config = Config.parseString(`${root}.consumer-group { group = "orders", consumer = "worker-1" }`);
    expectExactOptions(readRedisStreamsOptionsFromConfig(config), {
      consumerGroup: { group: 'orders', consumer: 'worker-1' },
    });
  });

  test('a consumer group needs both its group and its consumer', () => {
    const config = Config.parseString(`${root}.consumer-group { group = "orders" }`);
    expect(() => readRedisStreamsOptionsFromConfig(config)).toThrow(`${root}.consumer-group.consumer`);
  });
});

describe('readSseOptionsFromConfig', () => {
  test('a full kebab block reads into every field, and into nothing else', () => {
    // `90s` and `5s` are not numbers, so a getter other than getDuration fails.
    const config = Config.parseString(`${ConfigKeys.io.broker.sse.root} {
      url             = "https://events.local/stream"
      headers { authorization = "Bearer x", x-trace = "on" }
      idle-timeout    = 90s
      connect-timeout = 5s
    }`);
    expectExactOptions(readSseOptionsFromConfig(config), {
      url: 'https://events.local/stream',
      headers: { authorization: 'Bearer x', 'x-trace': 'on' },
      idleTimeoutMs: 90_000,
      connectTimeoutMs: 5_000,
    });
  });
});

describe('readTcpSocketOptionsFromConfig', () => {
  test('a full kebab block reads into every field, and into nothing else', () => {
    // The deadlines are durations: `30s` is no number, so getInt would fail.
    // The line cap is a size, which getInt refuses as well.
    const config = Config.parseString(`${ConfigKeys.io.broker.tcp.root} {
      host            = "peer.local"
      port            = 7000
      framing { kind = "lines", delimiter = "|", max-line-bytes = 64K }
      idle-timeout    = 90s
      connect-timeout = 5s
      keep-alive      = 30s
    }`);
    expectExactOptions(readTcpSocketOptionsFromConfig(config), {
      host: 'peer.local',
      port: 7000,
      framing: { kind: 'lines', delimiter: '|', maxLineBytes: 65_536 },
      idleTimeoutMs: 90_000,
      connectTimeoutMs: 5_000,
      keepAliveMs: 30_000,
    });
  });

  test('a framing block without its caps omits them, rather than writing undefined', () => {
    // An own `undefined` cap would shadow whatever a spread put beneath it;
    // `toEqual` cannot see one, the exact-object check can.
    const config = Config.parseString(`${ConfigKeys.io.broker.tcp.root}.framing.kind = "length-prefixed"`);
    expectExactOptions(readTcpSocketOptionsFromConfig(config), { framing: { kind: 'length-prefixed' } });
  });
});

describe('readTcpServerOptionsFromConfig', () => {
  test('a full kebab block reads into every field, and into nothing else', () => {
    // The frame cap is a size: `16M` is 16 MiB, and getInt refuses it.
    const config = Config.parseString(`${ConfigKeys.io.broker.tcpServer.root} {
      bind-host       = "127.0.0.1"
      bind-port       = 7001
      max-connections = 64
      framing { kind = "length-prefixed", max-frame-bytes = 16M }
    }`);
    expectExactOptions(readTcpServerOptionsFromConfig(config), {
      bindHost: '127.0.0.1',
      bindPort: 7001,
      maxConnections: 64,
      framing: { kind: 'length-prefixed', maxFrameBytes: 16_777_216 },
    });
  });

  test('a lines framing reads its delimiter and its cap', () => {
    const config = Config.parseString(
      `${ConfigKeys.io.broker.tcpServer.root}.framing { kind = "lines", delimiter = "\\r\\n", max-line-bytes = 8K }`,
    );
    expectExactOptions(readTcpServerOptionsFromConfig(config), {
      framing: { kind: 'lines', delimiter: '\r\n', maxLineBytes: 8_192 },
    });
  });
});

/* ------------------ the TCP framing caps, under both roots ------------------ */

/** The two TCP blocks, as the block table above starts them. */
const TCP_BLOCKS = BLOCKS.filter((block) => block.name === 'tcp' || block.name === 'tcp-server');

/**
 * The two caps of the `framing` block, each with the spelling it had before
 * #1443 — the leaf and the field were both named for a length then.  Spelled
 * out here rather than read from the table, for the reason the block table
 * gives.
 */
const FRAMING_CAPS = [
  { kind: 'lines', retired: 'maxLineLen', current: 'max-line-bytes', field: 'maxLineBytes' },
  { kind: 'length-prefixed', retired: 'maxFrameLen', current: 'max-frame-bytes', field: 'maxFrameBytes' },
] as const;

/** Every (TCP block, cap) pair, flattened for `test.each`. */
const FRAMING_CAP_CASES = TCP_BLOCKS.flatMap((block) => FRAMING_CAPS.map((cap) => ({
  ...cap, block, label: `${block.name}: framing.${cap.retired}`,
})));

/*
 * The framing block is the one both TCP actors carry, and its retired caps are
 * a table of their own rather than entries in either actor's: the rename moved
 * the TypeScript fields as well, and the refusal has to say so instead of the
 * default "no code change is needed".  So the block table above does not reach
 * them, and this does — through the actors, since a cap an operator wrote the
 * old way must stop the start, not merely fail a reader called by hand.
 */
describe('the TCP framing caps refuse their retired spellings and read their own, under both roots', () => {
  test('both TCP blocks are covered', () => {
    expect(TCP_BLOCKS.map((block) => block.name)).toEqual(['tcp', 'tcp-server']);
  });

  test.each(FRAMING_CAP_CASES)('$label fails preStart, naming both full paths and the renamed field', async (cap) => {
    const { root, required, create } = cap.block;
    const started = await startBroker(
      `${root} {\n${required}\nframing { kind = "${cap.kind}", ${cap.retired} = 4096 }\n}`,
      create,
    );
    expect(started.failure).toBeInstanceOf(ConfigError);
    const message = (started.failure as ConfigError).message;
    expect(message).toContain(`${root}.framing.${cap.retired} has been renamed to ${root}.framing.${cap.current}`);
    expect(message).toContain(cap.field);
  });

  test.each(FRAMING_CAP_CASES)('$label — its replacement, written 64K, starts the actor at 65536 bytes', async (cap) => {
    const { root, required, create } = cap.block;
    const started = await startBroker(
      `${root} {\n${required}\nframing { kind = "${cap.kind}", ${cap.current} = 64K }\n}`,
      create,
    );
    expect(started.failure).toBeNull();
    expectExactOptions<unknown>(started.options?.['framing'], { kind: cap.kind, [cap.field]: 65_536 });
  });
});

describe('readWebsocketClientOptionsFromConfig', () => {
  test('a full kebab block reads into every field, and into nothing else', () => {
    const config = Config.parseString(`${ConfigKeys.io.broker.websocket.root} {
      url                     = "wss://feed.local/stream"
      protocols               = ["feed-v1"]
      ping-interval           = 30s
      max-frame-bytes         = 1M
      on-invalid-message      = "drop"
      idle-timeout            = 90s
      connect-timeout         = 10s
      inbound-high-water-mark = 256
      inbound-low-water-mark  = 64
    }`);
    expectExactOptions(readWebsocketClientOptionsFromConfig(config), {
      url: 'wss://feed.local/stream',
      protocols: ['feed-v1'],
      pingIntervalMs: 30_000,
      maxFrameBytes: 1_048_576,
      onInvalidMessage: 'drop',
      idleTimeoutMs: 90_000,
      connectTimeoutMs: 10_000,
      inboundHighWaterMark: 256,
      inboundLowWaterMark: 64,
    });
  });
});

describe('readUdpSocketOptionsFromConfig', () => {
  test('a full kebab block reads into every field, and into nothing else', () => {
    const config = Config.parseString(`${ConfigKeys.io.broker.udp.root} {
      bind-host = "127.0.0.1"
      bind-port = 5005
      type      = "udp6"
    }`);
    expectExactOptions(readUdpSocketOptionsFromConfig(config), {
      bindHost: '127.0.0.1',
      bindPort: 5005,
      type: 'udp6',
    });
  });
});
