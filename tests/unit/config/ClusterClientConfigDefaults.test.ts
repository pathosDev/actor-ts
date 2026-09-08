import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { ClusterClient } from '../../../src/cluster/ClusterClient.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import {
  ClusterClientReceptionistId,
  type ClusterClientEnvelopeMessage,
  type ClusterClientReplyMessage,
} from '../../../src/cluster/ClusterClientReceptionist.js';
import { EnvelopeTrust } from '../../../src/cluster/EnvelopeTrust.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import {
  encodeFrame,
  FrameDecoder,
  type HelloAcknowledgmentMessage,
  type WireMessage,
} from '../../../src/cluster/Protocol.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import {
  ClusterClientOptions,
  DEFAULT_CLUSTER_CLIENT_CONNECT_TIMEOUT_MS,
  DEFAULT_CLUSTER_CLIENT_SYSTEM_NAME,
  readClusterClientOptionsFromConfig,
  withClusterClientConfigDefaults,
} from '../../../src/cluster/ClusterClientOptions.js';
import {
  readClusterClientReceptionistOptionsFromConfig,
  withClusterClientReceptionistConfigDefaults,
} from '../../../src/cluster/ClusterClientReceptionistOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../../../src/util/Constants.js';
import {
  getTcpBackend,
  type TcpListener,
  type TcpSocketLike,
} from '../../../src/runtime/tcp/index.js';

/**
 * #858 — `actor-ts.cluster.client` is the block for the one config consumer in
 * the framework that has no `ActorSystem` above it.  Three things have to be
 * right and only the third is checked anywhere else:
 *
 *   1. the mapping — kebab HOCON leaf to camelCase option field, with the unit
 *      suffix dropped (`ask-timeout` → `askTimeoutMs`) — and the "absent means
 *      absent" rule, since the reader's result is spread over the caller's
 *      options and a key present with `undefined` would shadow the built-in
 *      default underneath it;
 *   2. that the block actually reaches `ClusterClient`, which is the half
 *      `NoDeadConfigKeys` cannot see: its `coveringAccessor` resolves a leaf
 *      through any config root above it, and `isReferencedInSource` is
 *      satisfied by a substring, so a `ConfigKeys` entry plus any mention is
 *      enough to make an inert leaf look read;
 *   3. that the published defaults equal the constants — which
 *      `DocumentedDefaults.test.ts` pins from the other side.
 *
 * `contact-points` needs (2) most of all.  It ships comment-only, so it is
 * invisible to every leaf-driven guard: nothing but this file would notice if
 * the reader stopped consulting it.
 */

const listeners: TcpListener[] = [];
const clients: ClusterClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const listener of listeners.splice(0)) await listener.close();
});

/**
 * A socket that accepts and then says nothing.  The client's `hello` goes out
 * and no `hello-ack` ever comes back, so the only thing that can end the dial
 * is the connect timeout — which is what makes the timeout observable at all.
 */
async function silentContactPoint(): Promise<TcpListener> {
  const backend = await getTcpBackend();
  const listener = await backend.listen({
    host: '127.0.0.1',
    // Port 0, never a fixed one: a Windows host reserves whole ranges
    // (netsh excludedportrange) and a bind into one fails with EACCES.
    port: 0,
    handlers: { onOpen: () => {}, onData: () => {}, onClose: () => {}, onError: () => {} },
  });
  listeners.push(listener);
  return listener;
}

/**
 * A contact point that completes the handshake and then stops answering.
 *
 * {@link silentContactPoint} is enough for the *connect* deadline, which bounds
 * the dial itself.  An *ask* deadline is unreachable behind it: `ask()` awaits
 * `ensureConnected()` first, and the only thing that ever resolves that is a
 * `hello-ack`.  So this listener answers the handshake and then ignores the
 * `cluster-client-envelope` that follows, which leaves the ask timer as the one
 * thing that can settle the promise — and the deadline it was armed with as the
 * only number the failure can carry.
 */
async function handshakingContactPoint(): Promise<TcpListener> {
  const backend = await getTcpBackend();
  // One decoder per connection: `FrameDecoder` holds the partial-frame buffer,
  // so a shared one would interleave two sockets' bytes into a single stream.
  const decoders = new WeakMap<TcpSocketLike, FrameDecoder>();
  let boundPort = 0;
  const listener = await backend.listen({
    host: '127.0.0.1',
    // Port 0, for the reason silentContactPoint gives.
    port: 0,
    handlers: {
      onOpen: () => {},
      onData: (sock, chunk) => {
        // Created here rather than in `onOpen` so the fixture does not rest on
        // the two callbacks' ordering, which is a per-backend detail.
        let decoder = decoders.get(sock);
        if (decoder === undefined) {
          decoder = new FrameDecoder();
          decoders.set(sock, decoder);
        }
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== 'hello') continue;
          const acknowledgment: HelloAcknowledgmentMessage = {
            kind: 'hello-ack',
            self: new NodeAddress('contact-point', '127.0.0.1', boundPort).toJSON(),
          };
          sock.write(encodeFrame(acknowledgment));
        }
      },
      onClose: () => {},
      onError: () => {},
    },
  });
  boundPort = listener.port;
  listeners.push(listener);
  return listener;
}

/**
 * Run `body` with `ACTOR_TS_CONFIG` pointing at a temporary `application.conf`.
 *
 * The one way to reach {@link ClusterClient}'s self-load branch — the client
 * holds no `ActorSystem`, so a constructor called with no `Config` loads the
 * standard chain itself.  Through the environment variable rather than
 * `./application.conf`, because the CWD fallback would make the result depend
 * on the directory the suite was started from.  Same shape as
 * `tests/unit/coordination/LeaseConfigDefaults.test.ts`, for the same reason.
 */
function withApplicationConf<T>(source: string, body: () => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'actor-ts-cluster-client-conf-'));
  const path = join(directory, 'application.conf');
  writeFileSync(path, source, 'utf8');
  const previous = process.env.ACTOR_TS_CONFIG;
  process.env.ACTOR_TS_CONFIG = path;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.ACTOR_TS_CONFIG;
    else process.env.ACTOR_TS_CONFIG = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The reference layer with `overlay` written on top, as an application.conf would be. */
function referenceWith(overlay: string): Config {
  return Config.parseString(REFERENCE_CONF).merge(Config.parseString(overlay));
}

/** An actor that receives and never answers, so an ask against it can only time out. */
class SilentActor extends Actor<unknown> {
  override onReceive(): void { /* deliberately no reply */ }
}

/**
 * The four things `ClusterClientReceptionist.start` touches on a `Cluster`,
 * and nothing else — its own address, the wire-handler registry,
 * `transport.send`, and the node's inbound-path trust policy.  The policy is a
 * real {@link EnvelopeTrust} in its shipped posture rather than a stub that
 * admits everything, or the delivery below would prove nothing about the path.
 */
class FakeCluster {
  readonly sent: ClusterClientReplyMessage[] = [];
  readonly _envelopeTrust: EnvelopeTrust;
  private handler: ((message: WireMessage, from: NodeAddress) => void) | null = null;

  readonly transport = {
    send: (_to: NodeAddress, message: WireMessage): void => {
      this.sent.push(message as unknown as ClusterClientReplyMessage);
    },
  };

  constructor(readonly selfAddress: NodeAddress, system: ActorSystem) {
    this._envelopeTrust = new EnvelopeTrust(system, system.log, false, []);
  }

  _onWire(_kind: string, handler: (message: WireMessage, from: NodeAddress) => void): () => void {
    this.handler = handler;
    return (): void => { this.handler = null; };
  }

  deliver(envelope: ClusterClientEnvelopeMessage, from: NodeAddress): void {
    if (!this.handler) throw new Error('no wire handler registered');
    this.handler(envelope as unknown as WireMessage, from);
  }
}

describe('readClusterClientOptionsFromConfig', () => {
  test('reads every leaf of the client block, kebab mapped to camelCase', () => {
    // Config.parseString, never Config.fromObject with dotted string keys —
    // that keeps the dotted string as a literal top-level key, so hasPath
    // resolves the nested reference value and the assertion says nothing.
    const config = Config.parseString(`
      actor-ts.cluster.client {
        contact-points  = ["orders@10.0.0.1:2552", "orders@10.0.0.2:2552"]
        system-name     = "checkout-client"
        ask-timeout     = 250ms
        connect-timeout = 750ms
      }
    `);

    expect(readClusterClientOptionsFromConfig(config)).toEqual({
      contactPoints: ['orders@10.0.0.1:2552', 'orders@10.0.0.2:2552'],
      systemName: 'checkout-client',
      askTimeoutMs: 250,
      connectTimeoutMs: 750,
    });
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    const read = readClusterClientOptionsFromConfig(Config.parseString('actor-ts.system.name = x'));
    expect(read).toEqual({});
    // toEqual ignores a key whose value is undefined, so the shape that would
    // shadow a built-in default has to be checked by key.
    expect(Object.keys(read)).toEqual([]);
  });

  test('a partly-set block returns only what was set', () => {
    const read = readClusterClientOptionsFromConfig(
      Config.parseString('actor-ts.cluster.client.ask-timeout = 1s'),
    );
    expect(read).toEqual({ askTimeoutMs: 1_000 });
    expect(Object.keys(read)).toEqual(['askTimeoutMs']);
  });

  test('the shipped reference.conf resolves to the documented defaults', () => {
    // Locks the published values to the reader: a rename on either side turns
    // into a failure here rather than into a key that quietly stops applying.
    // contactPoints is absent on purpose — the leaf is comment-only, and its
    // absence is what lets an explicit withContactPoints(...) through.
    expect(readClusterClientOptionsFromConfig(Config.parseString(REFERENCE_CONF))).toEqual({
      systemName: DEFAULT_CLUSTER_CLIENT_SYSTEM_NAME,
      askTimeoutMs: DEFAULT_ASK_TIMEOUT_MS,
      connectTimeoutMs: DEFAULT_CLUSTER_CLIENT_CONNECT_TIMEOUT_MS,
    });
  });

  test('the comment-only contact-points key is still read when an operator sets it', () => {
    // The whole point of the comment-only shape: invisible to the leaf-driven
    // guards, and therefore checked by nothing but this.
    expect(referenceWith('actor-ts.cluster.client.contact-points = ["a@1.2.3.4:2552"]'))
      .toBeDefined();
    expect(
      readClusterClientOptionsFromConfig(
        referenceWith('actor-ts.cluster.client.contact-points = ["a@1.2.3.4:2552"]'),
      ).contactPoints,
    ).toEqual(['a@1.2.3.4:2552']);
  });

  test('it reads the client leaves and not the receptionist one beneath them', () => {
    // The two ask deadlines share a final path segment, which is exactly the
    // shape NoDeadConfigKeys' isReferencedInSource cannot tell apart.
    const config = Config.parseString(`
      actor-ts.cluster.client {
        ask-timeout = 111ms
        receptionist.ask-timeout = 222ms
      }
    `);
    expect(readClusterClientOptionsFromConfig(config)).toEqual({ askTimeoutMs: 111 });
  });
});

describe('readClusterClientReceptionistOptionsFromConfig', () => {
  test('reads its own leaf, and not the client deadline above it', () => {
    const config = Config.parseString(`
      actor-ts.cluster.client {
        ask-timeout = 111ms
        receptionist.ask-timeout = 222ms
      }
    `);
    expect(readClusterClientReceptionistOptionsFromConfig(config)).toEqual({ askTimeoutMs: 222 });
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    const read = readClusterClientReceptionistOptionsFromConfig(
      Config.parseString('actor-ts.system.name = x'),
    );
    expect(read).toEqual({});
    expect(Object.keys(read)).toEqual([]);
  });

  test('the shipped reference.conf resolves to the documented default', () => {
    expect(readClusterClientReceptionistOptionsFromConfig(Config.parseString(REFERENCE_CONF)))
      .toEqual({ askTimeoutMs: DEFAULT_ASK_TIMEOUT_MS });
  });
});

describe('the precedence chain', () => {
  test('explicit options beat HOCON, and HOCON beats the built-in default', () => {
    const config = referenceWith('actor-ts.cluster.client.ask-timeout = 900ms');

    expect(withClusterClientConfigDefaults({}, config).askTimeoutMs).toBe(900);
    expect(withClusterClientConfigDefaults({ askTimeoutMs: 30 }, config).askTimeoutMs).toBe(30);
    // And with no file layer at all the field stays unset, so the read site's
    // `?? DEFAULT_ASK_TIMEOUT_MS` is what answers.
    expect(withClusterClientConfigDefaults({}, Config.empty()).askTimeoutMs).toBeUndefined();
  });

  test('an undefined field in the explicit options does not shadow the file', () => {
    const config = referenceWith('actor-ts.cluster.client.system-name = "from-file"');
    const merged = withClusterClientConfigDefaults({ systemName: undefined }, config);
    expect(merged.systemName).toBe('from-file');
  });

  test('the receptionist half layers the same way', () => {
    const config = referenceWith('actor-ts.cluster.client.receptionist.ask-timeout = 800ms');
    expect(withClusterClientReceptionistConfigDefaults({}, config).askTimeoutMs).toBe(800);
    expect(withClusterClientReceptionistConfigDefaults({ askTimeoutMs: 40 }, config).askTimeoutMs)
      .toBe(40);
  });
});

describe('the block reaches the code that reads it', () => {
  test('a client built with no options at all takes its contact points from config', () => {
    const config = referenceWith(`
      actor-ts.cluster.client {
        contact-points = ["orders@10.0.0.1:2552"]
        system-name    = "checkout-client"
      }
    `);

    const client = new ClusterClient({}, config);
    clients.push(client);
    // The synthetic hello address is built from the configured system name, so
    // this is the block arriving at the constructor rather than at the reader.
    expect(client.clientAddress.systemName).toBe('checkout-client');
  });

  test('explicit contact points still win over the configured ones', () => {
    const config = referenceWith('actor-ts.cluster.client.contact-points = ["from@file:2552"]');
    const clusterClientOptions = ClusterClientOptions.create()
      .withContactPoints(['from@code:2552'])
      .withSystemName('from-code');

    const client = new ClusterClient(clusterClientOptions, config);
    clients.push(client);
    expect(client.clientAddress.systemName).toBe('from-code');
  });

  test('a client with no contact points in code or config is still refused', () => {
    // The reference layer alone must not make an unconfigured client look
    // valid — which is the other half of shipping contact-points comment-only.
    expect(() => new ClusterClient({}, Config.parseString(REFERENCE_CONF)))
      .toThrow(OptionsError);
  });

  test('a bad duration in the file is refused exactly like a bad one in code', () => {
    const config = referenceWith(`
      actor-ts.cluster.client {
        contact-points  = ["a@127.0.0.1:2552"]
        connect-timeout = 0ms
      }
    `);
    expect(() => new ClusterClient({}, config)).toThrow(OptionsError);
    expect(() => new ClusterClient({}, config)).toThrow(/connectTimeoutMs/);
  });

  test('the receptionist half takes its deadline from the system it runs in', async () => {
    // The other end of the same block, and the arm that would otherwise be
    // missing: `readClusterClientReceptionistOptionsFromConfig` returning the
    // right number proves nothing if `start()` never applies it.  A 40 ms
    // budget against a ceiling fifty times larger is what separates the two
    // outcomes — with the built-in 5 s still in force the reply arrives long
    // after both `awaitCondition`'s own wait and the bound restated below,
    // which is restated so a change to that default cannot loosen this test.
    const systemOptions = ActorSystemOptions.create()
      .withConfig(Config.parseString('actor-ts.cluster.client.receptionist.ask-timeout = 40ms'));
    const system = ActorSystem.create('receptionist-ask-timeout', systemOptions);
    const cluster = new FakeCluster(
      new NodeAddress('receptionist-ask-timeout', '10.0.0.5', 2_552),
      system,
    );
    system.spawn(SilentActor, 'silent');
    system.extension(ClusterClientReceptionistId).start(cluster as unknown as Cluster);

    const startedAt = Date.now();
    cluster.deliver(
      { kind: 'cluster-client-envelope', to: 'silent', askId: 'ask-1', body: { kind: 'ping' } },
      new NodeAddress('cluster-client', '203.0.113.9', 51_000),
    );
    await awaitCondition(() => cluster.sent.length > 0, {
      label: 'the receptionist gave up on the silent actor',
    });

    expect(cluster.sent[0]!.ok).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await system.terminate();
  });

  test('the configured connect-timeout is what bounds the wait for hello-ack', async () => {
    // A listener that accepts and never answers: the dial can only end on the
    // timeout, so the number in the failure is the number that was configured.
    // Nothing else in the suite proves connect-timeout left the config object.
    const listener = await silentContactPoint();
    const config = referenceWith(`
      actor-ts.cluster.client {
        contact-points  = ["silent@127.0.0.1:${listener.port}"]
        connect-timeout = 60ms
      }
    `);

    const client = new ClusterClient({}, config);
    clients.push(client);
    await expect(client.ask('/user/nobody', { kind: 'ping' }))
      .rejects.toThrow(/timed out after 60ms/);
  });

  test('the configured ask-timeout is what bounds the wait for a reply', async () => {
    // The sibling of the arm above, and the one the commit's own argument asks
    // for without having written it: `ClusterClient` reads `askTimeoutMs` into
    // a field and nothing downstream of that field was ever observed, so
    // replacing the read with the bare `DEFAULT_ASK_TIMEOUT_MS` left the whole
    // suite green.
    //
    // A contact point that answers `hello` and then goes quiet: the handshake
    // resolves, the envelope is written, and no reply ever comes — so the ask
    // can only end on its own deadline.
    const listener = await handshakingContactPoint();
    const config = referenceWith(`
      actor-ts.cluster.client {
        contact-points = ["silent@127.0.0.1:${listener.port}"]
        ask-timeout    = 120ms
      }
    `);

    const client = new ClusterClient({}, config);
    clients.push(client);

    const startedAt = Date.now();
    // `ask` is called with no explicit timeout, so the number interpolated into
    // the failure is the number the timer was armed with — which is the field,
    // and therefore the config leaf behind it.
    await expect(client.ask('/user/nobody', { kind: 'ping' }))
      .rejects.toThrow(/timed out after 120ms/);
    // And the clock, so a build that *reports* the configured value while
    // arming the timer with the built-in one is caught as well.  The window is
    // twenty times the configured deadline and half the 5 s default, and it
    // contains the handshake too: neither a slow machine nor a busy one can
    // confuse the two outcomes.
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    // Restated so a later change to the default cannot quietly bring the two
    // numbers together and leave this arm asserting nothing.
    expect(DEFAULT_ASK_TIMEOUT_MS).toBe(5_000);
    // Raised above bun's implicit 5 000 ms because the *failing* run is the one
    // that has to be legible: with the deadline discarded the ask settles at
    // exactly the default, and under the implicit cap the report would be the
    // runner's "timed out after 5000ms" instead of the assertion above.
  }, 15_000);

  test('a client handed no Config loads the standard chain itself', () => {
    // The acceptance criterion's own shape — `new ClusterClient({})`, one
    // argument — and the branch every other arm in this file steps around by
    // passing a Config.  A client holds no `ActorSystem`, so this constructor
    // is the single place in the framework that calls `Config.load()` on its
    // own behalf; until now nothing exercised it, and the block could have
    // been reachable only by a caller who already held a `Config`.
    withApplicationConf(
      `
        actor-ts.cluster.client {
          contact-points = ["orders@10.0.0.7:2552"]
          system-name    = "loaded-from-file"
        }
      `,
      () => {
        const client = new ClusterClient({});
        clients.push(client);
        // Constructing at all is half the assertion: the validator refuses a
        // client with no contact points, so reaching this line means the file
        // supplied them.  The system name is the other half — it is built into
        // the synthetic handshake address, so it proves the loaded config
        // reached the constructor and not merely the reader.
        expect(client.clientAddress.systemName).toBe('loaded-from-file');
      },
    );
  });
});
