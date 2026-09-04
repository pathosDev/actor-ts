import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

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
 *      `hasPath('<leaf>')` — so a row cannot claim a wiring that is absent;
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
  /** The leaf the reader passes to `hasPath` — not always the field name. */
  readonly leaf: string;
};
/** A field that has no HOCON spelling, and the reason it has none. */
type CodeOnlyField = { readonly kind: 'code-only'; readonly reason: string };
type FieldClassification = CodeOnlyField | HoconField;

type BrokerOptionsInventory = {
  /** The exported declaration whose fields are enumerated. */
  readonly optionsType: string;
  /** Where that declaration lives, relative to `src/`. */
  readonly optionsFile: string;
  /** Where its `readOptionsFromConfig` (or equivalent) lives, relative to `src/`. */
  readonly readerFile: string;
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
    fields: {
      reconnect: hocon('reconnect'),
      circuitBreaker: hocon('circuitBreaker'),
      outboundBuffer: hocon('outboundBuffer'),
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

/** Does `readerText` look up `leaf` on the actor's own config subtree? */
function readsLeaf(readerText: string, leaf: string): boolean {
  return readerText.includes(`hasPath('${leaf}')`);
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
      .filter(([, classification]) => !readsLeaf(row.readerText, (classification as HoconField).leaf))
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
      if (readsLeaf(row.readerText, name)) {
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
