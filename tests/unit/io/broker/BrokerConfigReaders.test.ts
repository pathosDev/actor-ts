import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { Config, ConfigError } from '../../../../src/config/Config.js';
import { rejectRetiredLeaves, type RetiredLeaves } from '../../../../src/config/RetiredKeys.js';
import {
  BrokerActor,
  readBrokerCommonOptionsFromConfig,
  type OutboundEnvelope,
} from '../../../../src/io/broker/BrokerActor.js';
import {
  brokerCommonKeysUnder,
  RETIRED_BROKER_COMMON_LEAVES,
  type BrokerCommonOptionsType,
} from '../../../../src/io/broker/BrokerOptions.js';
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
