import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { brokerCommonKeysUnder } from '../../../../src/io/broker/BrokerOptions.js';

/**
 * **Every field of every broker options type is either read from HOCON or
 * says in its own JSDoc why it cannot be** (#871).
 *
 * The issue's acceptance criterion is an *audit*, and it named
 * `tests/unit/config/NoDeadConfigKeys.test.ts` as the guard for it.  That test
 * cannot be: it iterates the leaves of `REFERENCE_CONF`, and there is no `io`
 * block there at all — broker keys are documented on the per-protocol pages
 * instead, because they are required-or-unset (`brokerUrl`, `servers`,
 * `endpoint`) and reference.conf has no defensible value to publish for them.
 * So it evaluates zero broker keys.  Even if the block were published it still
 * could not catch a dead broker leaf: its `coveringAccessor` collapses any
 * leaf onto its block root, and `isReferencedInSource` then only proves the
 * *root* is mentioned somewhere — `actor-ts.io.broker.mqtt.will.topic` passes
 * on the strength of `MqttActor`'s `configKey()` alone.
 *
 * This runs the audit from the other end, over the thing that actually
 * decides it: the options type.  One row per (options type, field), each
 * classified `hocon` — with the leaf the reader looks for — or `code-only`
 * with a reason.  Four properties hold, and the last two are what make the
 * classification more than a comment:
 *
 *   1. every field declared on the type appears in the inventory, so adding a
 *      field without deciding how it is configured fails here;
 *   2. every inventory row names a field the type still declares, so a
 *      renamed or deleted field cannot leave a stale row behind;
 *   3. a `hocon` row's leaf is genuinely read — the reader contains
 *      `hasPath('<leaf>')`, or for a reader that addresses its leaves through
 *      a key composer, `hasPath(keys.<accessor>)` with the accessor resolving
 *      to that leaf — so a row cannot claim a wiring that is absent;
 *   4. a `code-only` row's field is *not* read, and its JSDoc mentions HOCON,
 *      so the reason an operator needs is in the file they are reading rather
 *      than only in this table.
 *
 * ## Why the fields are parsed out of the source
 *
 * A TypeScript interface is erased at runtime — there is no object to
 * enumerate, and every one of these fields is optional, so an instance proves
 * nothing either.  The declarations are therefore read out of the `.ts` file:
 * `readonly <name>?:` at brace depth 1 inside the named declaration, with
 * comment lines skipped so the braces inside a JSDoc block do not shift the
 * depth.
 *
 * ## Where the WebSocket client is
 *
 * `WebsocketClientOptionsType` lives under `src/http/websocket/`, not
 * `src/io/broker/`, even though its config block is
 * `actor-ts.io.broker.websocket` and it is a `BrokerActor`.  A sweep scoped to
 * the broker directory misses it; this table names the path explicitly for
 * exactly that reason.
 */

const SOURCE_ROOT = join(import.meta.dir, '..', '..', '..', '..', 'src');

/** A field the reader resolves from the actor's HOCON subtree. */
type HoconField = {
  readonly kind: 'hocon';
  /**
   * The leaf the reader looks up, relative to the actor's root — not always
   * the field name.  A literal row's reader passes it to `hasPath` as is; a
   * composer row's reader reaches it through the composed full path.
   */
  readonly leaf: string;
};
/** A field that has no HOCON spelling, and the reason it has none. */
type CodeOnlyField = { readonly kind: 'code-only'; readonly reason: string };
type FieldClassification = CodeOnlyField | HoconField;

/**
 * What a key composer returns: the full dotted path of every leaf of a block
 * under one root, nested the way the block nests (`brokerCommonKeysUnder`).
 */
type ComposedKeys = { readonly [accessor: string]: string | ComposedKeys };

type BrokerOptionsInventory = {
  /** The exported declaration whose fields are enumerated. */
  readonly optionsType: string;
  /** Where that declaration lives, relative to `src/`. */
  readonly optionsFile: string;
  /** Where its `readOptionsFromConfig` (or equivalent) lives, relative to `src/`. */
  readonly readerFile: string;
  /**
   * Set when the reader addresses its leaves through a key composer — full
   * paths, `config.hasPath(keys.<accessor>)` — instead of literal leaf names.
   * The composer itself is evaluated, so a row is checked against the paths it
   * actually composes rather than against an accessor's name.
   */
  readonly keysUnder?: (root: string) => ComposedKeys;
  readonly fields: Readonly<Record<string, FieldClassification>>;
};

const hocon = (leaf: string): HoconField => ({ kind: 'hocon', leaf });
const codeOnly = (reason: string): CodeOnlyField => ({ kind: 'code-only', reason });

/** An `ActorRef` names a live actor in this process; config has no word for it. */
const ACTOR_REF = codeOnly('carries an ActorRef, which a config file cannot denote');
/** Certificate material, never a path — the ruling recorded in `BrokerTls.ts`. */
const TLS_MATERIAL = codeOnly('certificate material, never a path — see BrokerTls.ts');
/** grpc-js channel arguments — see the `GrpcChannelOptions` JSDoc. */
const GRPC_CHANNEL = codeOnly("grpc-js's own keys, unvalidated here — see GrpcChannelOptions");

const INVENTORY: ReadonlyArray<BrokerOptionsInventory> = [
  {
    optionsType: 'BrokerCommonOptionsType',
    optionsFile: 'io/broker/BrokerOptions.ts',
    readerFile: 'io/broker/BrokerOptions.ts',
    // `readCommonOptions` reads the system config at full paths under each
    // broker's root, so its rows resolve through the composer it reads with.
    keysUnder: brokerCommonKeysUnder,
    fields: {
      reconnect: hocon('reconnect'),
      circuitBreaker: hocon('circuit-breaker'),
      outboundBuffer: hocon('outbound-buffer'),
    },
  },
  {
    optionsType: 'AmqpOptionsType',
    optionsFile: 'io/broker/AmqpOptions.ts',
    readerFile: 'io/broker/AmqpActor.ts',
    fields: {
      url: hocon('url'),
      prefetch: hocon('prefetch'),
      bindings: ACTOR_REF,
      autoAcknowledge: hocon('autoAcknowledge'),
      tls: TLS_MATERIAL,
    },
  },
  {
    optionsType: 'EmailBridgeOptionsType',
    optionsFile: 'io/broker/EmailBridgeOptions.ts',
    readerFile: 'io/broker/EmailBridgeActor.ts',
    fields: {
      imap: hocon('imap'),
      smtp: hocon('smtp'),
      target: ACTOR_REF,
    },
  },
  {
    optionsType: 'GrpcClientOptionsType',
    optionsFile: 'io/broker/GrpcClientOptions.ts',
    readerFile: 'io/broker/GrpcClientActor.ts',
    fields: {
      protoPath: hocon('protoPath'),
      packageName: hocon('packageName'),
      serviceName: hocon('serviceName'),
      endpoint: hocon('endpoint'),
      credentials: TLS_MATERIAL,
      deadlineMs: hocon('deadlineMs'),
      channelOptions: GRPC_CHANNEL,
    },
  },
  {
    optionsType: 'GrpcServerOptionsType',
    optionsFile: 'io/broker/GrpcServerOptions.ts',
    readerFile: 'io/broker/GrpcServerActor.ts',
    fields: {
      protoPath: hocon('protoPath'),
      packageName: hocon('packageName'),
      serviceName: hocon('serviceName'),
      bind: hocon('bind'),
      handlers: codeOnly('a map of functions'),
      credentials: TLS_MATERIAL,
      health: codeOnly('supplying a HealthCheckRegistry is itself the opt-in'),
      channelOptions: GRPC_CHANNEL,
    },
  },
  {
    optionsType: 'JetStreamOptionsType',
    optionsFile: 'io/broker/JetStreamOptions.ts',
    readerFile: 'io/broker/JetStreamActor.ts',
    fields: {
      servers: hocon('servers'),
      token: hocon('token'),
      user: hocon('user'),
      password: hocon('password'),
      name: hocon('name'),
      tls: TLS_MATERIAL,
      stream: hocon('stream'),
      consumer: hocon('consumer'),
      target: ACTOR_REF,
      acknowledgmentTimeout: hocon('acknowledgment-timeout'),
    },
  },
  {
    optionsType: 'JetStreamKeyValueOptionsType',
    optionsFile: 'io/broker/JetStreamKeyValueOptions.ts',
    readerFile: 'io/broker/JetStreamKeyValueActor.ts',
    fields: {
      servers: hocon('servers'),
      token: hocon('token'),
      user: hocon('user'),
      password: hocon('password'),
      name: hocon('name'),
      bucket: hocon('bucket'),
      history: hocon('history'),
      timeToLive: hocon('timeToLive'),
      storage: hocon('storage'),
      replicas: hocon('replicas'),
      maxValueBytes: hocon('maxValueBytes'),
      create: hocon('create'),
    },
  },
  {
    optionsType: 'JetStreamObjectStoreOptionsType',
    optionsFile: 'io/broker/JetStreamObjectStoreOptions.ts',
    readerFile: 'io/broker/JetStreamObjectStoreActor.ts',
    fields: {
      servers: hocon('servers'),
      token: hocon('token'),
      user: hocon('user'),
      password: hocon('password'),
      name: hocon('name'),
      bucket: hocon('bucket'),
      description: hocon('description'),
      storage: hocon('storage'),
      replicas: hocon('replicas'),
      maxObjectBytes: hocon('maxObjectBytes'),
      create: hocon('create'),
    },
  },
  {
    optionsType: 'KafkaOptionsType',
    optionsFile: 'io/broker/KafkaOptions.ts',
    readerFile: 'io/broker/KafkaActor.ts',
    fields: {
      brokers: hocon('brokers'),
      clientId: hocon('clientId'),
      sasl: hocon('sasl'),
      // The boolean arm only; the certificate-material arm is code-only, which
      // is why the field's own JSDoc says so as well.
      ssl: hocon('ssl'),
      producer: hocon('producer'),
      consumer: hocon('consumer'),
      target: ACTOR_REF,
      topics: hocon('topics'),
    },
  },
  {
    optionsType: 'MqttOptionsType',
    optionsFile: 'io/broker/MqttOptions.ts',
    readerFile: 'io/broker/MqttActor.ts',
    fields: {
      brokerUrl: hocon('brokerUrl'),
      clientId: hocon('clientId'),
      credentials: hocon('credentials'),
      qos: hocon('qos'),
      will: hocon('will'),
      cleanSession: hocon('cleanSession'),
      keepAlive: hocon('keepAlive'),
      protocolVersion: hocon('protocolVersion'),
      codec: codeOnly('a pair of functions'),
      tls: TLS_MATERIAL,
    },
  },
  {
    optionsType: 'NatsOptionsType',
    optionsFile: 'io/broker/NatsOptions.ts',
    readerFile: 'io/broker/NatsActor.ts',
    fields: {
      servers: hocon('servers'),
      token: hocon('token'),
      user: hocon('user'),
      password: hocon('password'),
      subscriptions: ACTOR_REF,
      name: hocon('name'),
      tls: TLS_MATERIAL,
    },
  },
  {
    optionsType: 'RedisStreamsOptionsType',
    optionsFile: 'io/broker/RedisStreamsOptions.ts',
    readerFile: 'io/broker/RedisStreamsActor.ts',
    fields: {
      url: hocon('url'),
      streams: hocon('streams'),
      consumerGroup: hocon('consumerGroup'),
      blockMs: hocon('blockMs'),
      target: ACTOR_REF,
      tls: TLS_MATERIAL,
    },
  },
  {
    optionsType: 'SseOptionsType',
    optionsFile: 'io/broker/SseOptions.ts',
    readerFile: 'io/broker/SseActor.ts',
    fields: {
      url: hocon('url'),
      headers: hocon('headers'),
      target: ACTOR_REF,
      idleTimeoutMs: hocon('idleTimeoutMs'),
      connectTimeoutMs: hocon('connectTimeoutMs'),
    },
  },
  {
    optionsType: 'TcpServerOptionsType',
    optionsFile: 'io/broker/TcpServerOptions.ts',
    readerFile: 'io/broker/TcpServerActor.ts',
    fields: {
      bindHost: hocon('bindHost'),
      bindPort: hocon('bindPort'),
      framing: hocon('framing'),
      target: ACTOR_REF,
      tls: TLS_MATERIAL,
      maxConnections: hocon('maxConnections'),
    },
  },
  {
    optionsType: 'TcpSocketOptionsType',
    optionsFile: 'io/broker/TcpSocketOptions.ts',
    readerFile: 'io/broker/TcpSocketActor.ts',
    fields: {
      host: hocon('host'),
      port: hocon('port'),
      framing: hocon('framing'),
      target: ACTOR_REF,
      idleTimeoutMs: hocon('idleTimeoutMs'),
      connectTimeoutMs: hocon('connectTimeoutMs'),
      keepAliveMs: hocon('keepAliveMs'),
    },
  },
  {
    optionsType: 'UdpSocketOptionsType',
    optionsFile: 'io/broker/UdpSocketOptions.ts',
    readerFile: 'io/broker/UdpSocketActor.ts',
    fields: {
      bindHost: hocon('bindHost'),
      bindPort: hocon('bindPort'),
      type: hocon('type'),
      target: ACTOR_REF,
    },
  },
  {
    optionsType: 'WebsocketClientOptionsType',
    optionsFile: 'http/websocket/WebsocketClientOptions.ts',
    readerFile: 'http/websocket/WebsocketClientActor.ts',
    fields: {
      url: hocon('url'),
      protocols: hocon('protocols'),
      codec: codeOnly('a pair of functions'),
      maxFrameBytes: hocon('maxFrameBytes'),
      onInvalidMessage: hocon('on-invalid-message'),
      pingIntervalMs: hocon('pingIntervalMs'),
      idleTimeoutMs: hocon('idleTimeoutMs'),
      connectTimeoutMs: hocon('connectTimeoutMs'),
      inboundHighWaterMark: hocon('inbound-high-water-mark'),
      inboundLowWaterMark: hocon('inbound-low-water-mark'),
    },
  },
];

/** One `readonly name?: …` declaration, with the comment block above it. */
type DeclaredField = {
  readonly name: string;
  /** The contiguous run of comment lines immediately above the declaration. */
  readonly documentation: string;
};

/** A field declaration at the top level of an interface / object type. */
const FIELD_DECLARATION = /^[ \t]*readonly[ \t]+([A-Za-z_][A-Za-z0-9_]*)\??[ \t]*:/;
/** A line that is entirely comment — JSDoc body included. */
const COMMENT_LINE = /^[ \t]*(\*|\/\*|\/\/)/;

/**
 * The fields `typeName` declares in `text`, in declaration order.
 *
 * Comment lines are skipped before the braces are counted: a JSDoc block that
 * mentions `{@link X}` or a shape literal would otherwise move the depth and
 * either hide the fields after it or end the scan early.
 */
function declaredFields(text: string, typeName: string): ReadonlyArray<DeclaredField> {
  const lines = text.split(/\r?\n/);
  const opening = new RegExp(`^export (?:interface|type) ${typeName}\\b`);
  let index = lines.findIndex((line) => opening.test(line));
  if (index < 0) return [];

  const out: DeclaredField[] = [];
  let documentation: string[] = [];
  let depth = 0;
  let entered = false;
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (COMMENT_LINE.test(line)) {
      documentation.push(line);
      continue;
    }
    if (entered && depth === 1) {
      const match = FIELD_DECLARATION.exec(line);
      if (match) out.push({ name: match[1]!, documentation: documentation.join('\n') });
    }
    documentation = [];
    for (const character of line) {
      if (character === '{') { depth++; entered = true; }
      else if (character === '}') depth--;
    }
    if (entered && depth === 0) break;
  }
  return out;
}

const sourceOf = (file: string): string => readFileSync(join(SOURCE_ROOT, file), 'utf8');

const rows = INVENTORY.map((entry) => ({
  ...entry,
  declared: declaredFields(sourceOf(entry.optionsFile), entry.optionsType),
  readerText: sourceOf(entry.readerFile),
}));

/**
 * Does `readerText` look up `leaf` on the actor's own config subtree?
 *
 * The *receiver* is half the question, not decoration.  Every reader here
 * resolves its top-level leaves off a `Config` bound to the actor's own block
 * and named `config`; a nested group (`stream { … }`, `will { … }`,
 * `producer { … }`) is read through its own descended handle — `streamConfig`,
 * `willConfig`, `producerConfig`.  A search for the bare call text cannot tell
 * the two apart, so a nested leaf spelled like a top-level one satisfies the
 * top-level row on the strength of the nested read.  Two pairs are spelled
 * that way today — `mqtt.qos` beside `mqtt.will.qos`, `jetstream.name` beside
 * `jetstream.stream.name` — and both were created by #871, whose header faults
 * `NoDeadConfigKeys` for exactly this substring collapse.
 *
 * Anchored on a non-identifier character so a future `parentConfig` cannot
 * creep back in through the suffix.
 *
 * **Two spellings of the lookup, one per kind of row.**  A literal row's
 * reader names the leaf: `config.hasPath('<leaf>')`.  A composer row's reader
 * names a constant, `config.hasPath(keys.<accessor>)`, and reads the system
 * config at the full path the constant holds.  For that kind the composer is
 * *evaluated* under {@link COMPOSER_ROOT}, and a read counts only where the
 * accessor composes `<root>.<leaf>` — so a constant spelled differently from
 * the row does not read the row's leaf whatever its accessor is called, and a
 * nested accessor (`keys.reconnect.initialDelay`) cannot stand in for a
 * top-level leaf, which is the receiver rule above in the other spelling.  A
 * row is held to its own kind: a literal read does not satisfy a composer row,
 * whose reader is handed the system config and would look for a relative leaf
 * at the wrong level.
 *
 * A code-only field is looked up by its own name, so on a composer row only a
 * composed path ending in that exact name counts as a read; the kebab spelling
 * of a camelCase name would not.  No composer row has a code-only field yet.
 */
function readsLeaf(readerText: string, leaf: string, keysUnder?: (root: string) => ComposedKeys): boolean {
  if (keysUnder === undefined) {
    return new RegExp(`(^|[^\\w$.])config\\.hasPath\\('${escapeRegExp(leaf)}'\\)`, 'm').test(readerText);
  }
  for (const [accessor, path] of composedPaths(keysUnder(COMPOSER_ROOT))) {
    if (path !== `${COMPOSER_ROOT}.${leaf}`) continue;
    const constantRead = new RegExp(`(^|[^\\w$.])config\\.hasPath\\(keys\\.${escapeRegExp(accessor)}\\)`, 'm');
    if (constantRead.test(readerText)) return true;
  }
  return false;
}

/** `text`, escaped to match itself inside a `RegExp`. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * The root a composer is evaluated under.  No broker is configured there, so a
 * path carrying it can only have come out of the composer.
 */
const COMPOSER_ROOT = 'composer-probe';

/** Every accessor path of `keys` (`reconnect.root`), mapped to the full path it composes. */
function composedPaths(keys: ComposedKeys, prefix = ''): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [accessor, value] of Object.entries(keys)) {
    const path = prefix === '' ? accessor : `${prefix}.${accessor}`;
    if (typeof value === 'string') out.set(path, value);
    else for (const [nested, full] of composedPaths(value, path)) out.set(nested, full);
  }
  return out;
}

describe('every broker options field is configured or documented code-only', () => {
  test('the field scan actually finds fields', () => {
    // Guards the guard: a regex that matched nothing would make every
    // assertion below vacuously pass, which is how this class of test rots.
    const mqtt = declaredFields(sourceOf('io/broker/MqttOptions.ts'), 'MqttOptionsType');
    expect(mqtt.map((f) => f.name)).toContain('brokerUrl');
    expect(mqtt.map((f) => f.name)).toContain('will');
    // Nested fields belong to the group above them, not to the type.
    expect(mqtt.map((f) => f.name)).not.toContain('username');

    const probe = declaredFields(
      [
        'export interface ProbeOptionsType {',
        '  /** A doc block with a { brace } and a {@link Thing}. */',
        '  readonly kept?: string;',
        '  readonly nested?: {',
        '    readonly hidden?: number;',
        '  };',
        '}',
        'export interface AfterTheEnd { readonly missed?: string }',
      ].join('\n'),
      'ProbeOptionsType',
    );
    expect(probe.map((f) => f.name)).toEqual(['kept', 'nested']);
    expect(probe[0]!.documentation).toContain('@link');
  });

  test('the read check discriminates', () => {
    // Both directions on one file, so a `readsLeaf` that always answered the
    // same way could not pass.
    const mqttActor = sourceOf('io/broker/MqttActor.ts');
    expect(readsLeaf(mqttActor, 'will')).toBe(true);
    expect(readsLeaf(mqttActor, 'codec')).toBe(false);

    // The constant form, both directions, on the reader that uses it: a leaf
    // the composer spells and the reader looks up through it…
    const brokerOptions = sourceOf('io/broker/BrokerOptions.ts');
    expect(readsLeaf(brokerOptions, 'outbound-buffer', brokerCommonKeysUnder)).toBe(true);
    expect(readsLeaf(brokerOptions, 'reconnect.initial-delay', brokerCommonKeysUnder)).toBe(true);
    // …the retired spelling of that leaf, which no accessor composes…
    expect(readsLeaf(brokerOptions, 'outboundBuffer', brokerCommonKeysUnder)).toBe(false);
    // …and a nested leaf asked for at the top level, which an accessor does
    // compose, but only under its group.
    expect(readsLeaf(brokerOptions, 'initial-delay', brokerCommonKeysUnder)).toBe(false);
  });

  test('a constant read counts for the path its composer composes, not for its name', () => {
    const reader = 'if (config.hasPath(keys.outboundBuffer)) out.outboundBuffer = config.getInt(keys.outboundBuffer);';
    // The same accessor under two composers: the one that spells the leaf the
    // row names satisfies it, the one that spells it the retired way does not.
    const kebab = (root: string): ComposedKeys => ({ outboundBuffer: `${root}.outbound-buffer` });
    const camel = (root: string): ComposedKeys => ({ outboundBuffer: `${root}.outboundBuffer` });
    expect(readsLeaf(reader, 'outbound-buffer', kebab)).toBe(true);
    expect(readsLeaf(reader, 'outbound-buffer', camel)).toBe(false);
    // A composer row is held to the constant form: the literal call, which on
    // the system config would look for the leaf at the top of the tree, is no
    // read of it.
    expect(readsLeaf("if (config.hasPath('outbound-buffer')) { /* … */ }", 'outbound-buffer', kebab)).toBe(false);
  });

  /*
   * A nested group read must not satisfy a top-level row.
   *
   * Two leaves are spelled the same at both levels — `mqtt.qos` beside
   * `mqtt.will.qos`, `jetstream.name` beside `jetstream.stream.name` — and a
   * check that searches the reader file for the bare call text cannot tell
   * them apart.  The top-level read could then be deleted with the guard
   * still green, on the strength of the nested one: exactly the substring
   * collapse this file's header faults `NoDeadConfigKeys` for.
   *
   * The deletion is simulated on the real source rather than asserted against
   * a hand-written fixture, so the two rows are checked as they are actually
   * written today.
   */
  test.each([
    { readerFile: 'io/broker/MqttActor.ts', leaf: 'qos', topLevelRead: "if (config.hasPath('qos')) out.qos = config.getInt('qos') as MqttQos;" },
    { readerFile: 'io/broker/JetStreamActor.ts', leaf: 'name', topLevelRead: "if (config.hasPath('name')) out.name = config.getString('name');" },
  ])('$readerFile — a nested $leaf read does not stand in for the top-level one', (probe) => {
    const source = sourceOf(probe.readerFile);
    expect(source, 'the probe no longer quotes the reader verbatim').toContain(probe.topLevelRead);
    expect(readsLeaf(source, probe.leaf)).toBe(true);

    const withoutTopLevel = source.replace(probe.topLevelRead, '');
    // The nested read is still in there — that is the whole point.
    expect(withoutTopLevel).toContain(`Config.hasPath('${probe.leaf}')`);
    expect(
      readsLeaf(withoutTopLevel, probe.leaf),
      `deleting the top-level read of '${probe.leaf}' left the guard green, so `
      + 'that leaf could go dead without any gate noticing.',
    ).toBe(false);
  });

  test.each(rows)('$optionsType classifies every field it declares', (row) => {
    const unclassified = row.declared
      .map((field) => field.name)
      .filter((name) => !(name in row.fields));

    expect(
      unclassified,
      `${row.optionsType} declares a field this inventory does not classify. `
      + 'Add it as hocon("<leaf>") once its reader looks the leaf up, or as '
      + 'codeOnly("<reason>") with the same reason in the field\'s JSDoc.',
    ).toEqual([]);
  });

  test.each(rows)('$optionsType still declares every field this inventory names', (row) => {
    const declared = new Set(row.declared.map((field) => field.name));
    const stale = Object.keys(row.fields).filter((name) => !declared.has(name));

    expect(
      stale,
      `${row.optionsType} no longer declares these fields, but the inventory `
      + 'still lists them — drop the rows in the same change, so a row cannot '
      + 'outlive the field it describes.',
    ).toEqual([]);
  });

  test.each(rows)('$optionsType — every hocon row names a leaf the reader reads', (row) => {
    const unread = Object.entries(row.fields)
      .filter(([, classification]) => classification.kind === 'hocon')
      .filter(([, classification]) => !readsLeaf(row.readerText, (classification as HoconField).leaf, row.keysUnder))
      .map(([name, classification]) => `${name} -> ${(classification as HoconField).leaf}`);

    expect(
      unread,
      `${row.readerFile} does not look these leaves up. A row claiming a `
      + 'wiring that is not there is the defect this table exists to catch — '
      + 'either add the read, or reclassify the field as code-only.',
    ).toEqual([]);
  });

  test.each(rows)('$optionsType — every code-only field is unread and says why', (row) => {
    const documentation = new Map(row.declared.map((f) => [f.name, f.documentation]));
    const problems: string[] = [];
    for (const [name, classification] of Object.entries(row.fields)) {
      if (classification.kind !== 'code-only') continue;
      if (readsLeaf(row.readerText, name, row.keysUnder)) {
        problems.push(`${name} is classified code-only but ${row.readerFile} reads it`);
      }
      if (!/hocon/i.test(documentation.get(name) ?? '')) {
        problems.push(`${name} has no JSDoc saying why it has no HOCON leaf`);
      }
    }

    expect(
      problems,
      `${row.optionsType}: "documented code-only" means the reason is in the `
      + 'file someone reads while writing an application.conf, not only in '
      + 'this table.',
    ).toEqual([]);
  });
});
