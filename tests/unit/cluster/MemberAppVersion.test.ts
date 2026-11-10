import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { bootstrapCluster } from '../../../src/cluster/ClusterBootstrap.js';
import { ClusterBootstrapOptions } from '../../../src/cluster/ClusterBootstrapOptions.js';
import { ClusterOptions, ClusterOptionsValidator } from '../../../src/cluster/ClusterOptions.js';
import type { ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { MAX_APP_VERSION_LENGTH } from '../../../src/cluster/Protocol.js';
import type { GossipMessage, MemberData, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { wireFrameProblem } from '../../../src/cluster/WireValidation.js';
import { Config } from '../../../src/config/Config.js';
import { NoopLogger } from '../../../src/Logger.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * #843 — the application version a member states, for an operator to read
 * while a rolling update has old and new code in one cluster.
 *
 * Advisory and nothing else: nothing places, routes or downs on it.  What it
 * has to be is *true* and *harmless*, which is why most of what is pinned
 * here is about where a label comes from and what one may contain — it is
 * printed by `Member.toString`, by every log line that prints a member and by
 * `/cluster/members`, and a peer's label arrives off the wire.
 */

describe('the validator holds the label to what every peer admits', () => {
  const validate = (appVersion: unknown): void => {
    new ClusterOptionsValidator().validate({ appVersion } as Partial<ClusterOptionsType>);
  };

  test('the shapes version schemes actually use pass', () => {
    const labels = [
      '1.2.3',
      'v2.4.0-rc.1+build.5',
      '2026.10.15',
      'a1b2c3d',
      'release/1.2',
      'registry.example.com/orders:1.2.3',
      '1.2.3_hotfix',
      'x'.repeat(MAX_APP_VERSION_LENGTH),
    ];
    for (const label of labels) expect(() => validate(label), label).not.toThrow();
    expect(() => validate(undefined)).not.toThrow();
  });

  test('an empty label is refused rather than stated as nothing', () => {
    // What `${?APP_VERSION}` lands over a variable that is set to nothing.
    // Stating no version already has a spelling — an absent key — so an empty
    // one is a deployment that meant to set it and did not.
    expect(() => validate('')).toThrow(OptionsError);
  });

  test('a label over the cap is refused here, not dropped by every peer', () => {
    expect(() => validate('x'.repeat(MAX_APP_VERSION_LENGTH + 1))).toThrow(OptionsError);
  });

  test('a label that could forge or disguise a log line is refused', () => {
    // Control characters end a log line early or rewrite it; whitespace makes
    // two labels that print alike compare unequal; a bidi override reorders
    // what a terminal shows.  Visible ASCII has none of the three.
    const labels = [
      '1.2.3\nERROR forged line',
      '1.2.3\r',
      '1.2.3\t',
      '1.2.3 ',
      ' 1.2.3',
      '1.2.3 (build 42)',
      '1.2.3\u0000',
      '1.2.3\u007f',
      '1.2.3‮',
      'versión-1',
    ];
    for (const label of labels) expect(() => validate(label), JSON.stringify(label)).toThrow(OptionsError);
  });

  test('a value that is not a string is refused', () => {
    expect(() => validate(42)).toThrow(OptionsError);
  });

  test('the refusal names the field and says what a legal label looks like', () => {
    expect(() => validate('1.2.3\n')).toThrow(/appVersion/);
    expect(() => validate('1.2.3\n')).toThrow(new RegExp(`${MAX_APP_VERSION_LENGTH}`));
  });

  test('the builder sets the field the reader and the validator use', () => {
    const clusterOptions = ClusterOptions.create().withAppVersion('2.4.0');

    expect((clusterOptions as Partial<ClusterOptionsType>).appVersion).toBe('2.4.0');
  });
});

const ADDRESS = new NodeAddress('app-version-record', 'h', 4_713, 'test-run');

/** A record a hostile or broken peer could send, typed as the wire type. */
function gossipedWith(appVersion: unknown): MemberData {
  return {
    address: ADDRESS.toJSON(),
    status: 'up',
    version: 3,
    roles: ['backend'],
    appVersion,
  } as unknown as MemberData;
}

describe('the app version on the member record', () => {
  test('round-trips through the gossiped form, omitted when absent', () => {
    const bare = new Member(ADDRESS, 'up', 3);
    expect('appVersion' in bare.toData()).toBe(false);

    const stating = new Member(ADDRESS, 'up', 3, [], undefined, undefined, undefined, '2.4.0');
    const data = stating.toData();
    expect(data.appVersion).toBe('2.4.0');
    expect(Member.fromData(data).appVersion).toBe('2.4.0');
  });

  test('travels beside both overlays, none of the three erasing another', () => {
    // `toData` assembles the record by spreading one optional field at a time,
    // and a spread that dropped an earlier one would stay invisible until a
    // cluster ran all three at once.
    const member = new Member(
      ADDRESS, 'up', 3, [], undefined,
      { journal: 'database-a' },
      { 'actor-ts.remote.max-frame-bytes': '16777216' },
      '2.4.0',
    );

    expect(member.toData()).toEqual({
      address: ADDRESS.toJSON(),
      status: 'up',
      version: 3,
      roles: [],
      storageIdentities: { journal: 'database-a' },
      configurationFacts: { 'actor-ts.remote.max-frame-bytes': '16777216' },
      appVersion: '2.4.0',
    });
  });

  test('every constructor path carries it — a promotion or an overlay write must not wipe it', () => {
    // A leader's promotion is merged wholesale on every peer, so a status
    // transition that dropped the label would take it off the cluster's view
    // at the exact moment a rolling update makes it worth reading.
    const stating = new Member(ADDRESS, 'joining', 3, ['backend'], undefined, undefined, undefined, '2.4.0');

    expect(stating.withStatus('up').appVersion).toBe('2.4.0');
    expect(stating.withRemoved(1_000).appVersion).toBe('2.4.0');
    expect(stating.withStorageIdentities({ journal: 'database-a' }).appVersion).toBe('2.4.0');
    expect(stating.withConfigurationFacts({ 'actor-ts.remote.max-frame-bytes': '1' }).appVersion).toBe('2.4.0');
  });

  test('withAppVersion keeps the merge clock still and every other field', () => {
    // The label rides the overlay lane beside the two claims, for their
    // reason: a version bump would race the leader's `joining → up` promotion
    // to the same `version + 1`, which `mergeMember` has no tie-break for.
    const member = new Member(
      ADDRESS, 'up', 3, ['backend'], undefined,
      { journal: 'database-a' },
      { 'actor-ts.remote.max-frame-bytes': '1' },
    );

    const next = member.withAppVersion('2.4.0');

    expect(next.version).toBe(3);
    expect(next.status).toBe('up');
    expect([...next.roles]).toEqual(['backend']);
    expect(next.storageIdentities).toEqual({ journal: 'database-a' });
    expect(next.configurationFacts).toEqual({ 'actor-ts.remote.max-frame-bytes': '1' });
    expect(next.appVersion).toBe('2.4.0');
    expect(member.appVersion).toBeUndefined();
  });

  test('a bad label off the wire drops, never the record', () => {
    // The label is advisory and the member is not: refusing the record would
    // let one malformed label suppress a peer's whole membership.
    const labels: unknown[] = [
      42,
      '',
      'x'.repeat(MAX_APP_VERSION_LENGTH + 1),
      '1.2.3\nERROR forged line',
      '1.2.3 ',
      '1.2.3‮',
      ['2.4.0'],
      { major: 2 },
      null,
    ];
    for (const label of labels) {
      const member = Member.fromData(gossipedWith(label));

      expect(member.status, JSON.stringify(label)).toBe('up');
      expect([...member.roles], JSON.stringify(label)).toEqual(['backend']);
      expect(member.appVersion, JSON.stringify(label)).toBeUndefined();
    }
  });

  test('the cap admits a label of exactly the cap', () => {
    const longest = 'x'.repeat(MAX_APP_VERSION_LENGTH);

    expect(Member.fromData(gossipedWith(longest)).appVersion).toBe(longest);
  });

  test('a frame is not refused for the label it carries', () => {
    // The frame guard checks what the merge cannot do without, and a label is
    // not that; turning a bad one into a refused frame would drop every record
    // beside it.  `Member.fromData` is where it is dropped instead.
    const frame = {
      kind: 'gossip',
      from: ADDRESS.toJSON(),
      sequence: 1,
      members: [gossipedWith(42), gossipedWith('1.2.3\nERROR forged line')],
    };

    expect(wireFrameProblem(frame)).toBeNull();
  });

  test('toString prints the label, and nothing for a member that states none', () => {
    expect(new Member(ADDRESS, 'up', 3, ['backend'], undefined, undefined, undefined, '2.4.0').toString())
      .toBe('Member(app-version-record@h:4713, up, v3 roles=[backend] app-version=2.4.0)');
    expect(new Member(ADDRESS, 'up', 3, ['backend']).toString())
      .toBe('Member(app-version-record@h:4713, up, v3 roles=[backend])');
  });
});

/* -------------------------------------------------------------------------- */
/* Real nodes                                                                   */
/* -------------------------------------------------------------------------- */

const SYSTEM = 'app-version';
const HOST = 'h';

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  /** Kept so a case can take the node down without a word, the way a crash does. */
  readonly transport: InMemoryTransport;
};

type NodeSpec = {
  readonly port: number;
  readonly seeds?: ReadonlyArray<string>;
  readonly appVersion?: string;
  readonly hocon?: string;
  /** `failure-detector.auto-down` in code; unset leaves the shipped `on`. */
  readonly autoDown?: boolean;
};

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  for (const cluster of clusters.splice(0)) {
    try { await cluster.leave(); } catch { /* teardown is best-effort */ }
  }
  for (const system of systems.splice(0)) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

function addressOf(port: number): string {
  return `${SYSTEM}@${HOST}:${port}`;
}

/**
 * A real node on `InMemoryTransport`.  The system is registered for teardown
 * before the join, so a join the validator refuses still leaves nothing
 * running behind it.
 */
async function startNode(spec: NodeSpec): Promise<Node> {
  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger());
  if (spec.hocon !== undefined) systemOptions.withConfig(Config.parseString(spec.hocon));
  const system = ActorSystem.create(SYSTEM, systemOptions);
  systems.push(system);
  const transport = new InMemoryTransport(new NodeAddress(SYSTEM, HOST, spec.port, 'test-run'));
  const clusterOptions = ClusterOptions.create()
    .withHost(HOST)
    .withPort(spec.port)
    .withTransport(transport)
    .withSeeds([...(spec.seeds ?? [])])
    .withGossipIntervalMs(30)
    .withSeedRetryIntervalMs(30);
  if (spec.appVersion !== undefined) clusterOptions.withAppVersion(spec.appVersion);
  if (spec.autoDown !== undefined) clusterOptions.withFailureDetectorAutoDown(spec.autoDown);
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return { system, cluster, transport };
}

/** What `node` holds about `address` — the label every reader of `getMembers()` sees. */
function labelHeldBy(node: Node, address: NodeAddress): string | undefined {
  return node.cluster.getMembers().find((member) => member.address.equals(address))?.appVersion;
}

describe('Cluster.join states the configured label on the self member (#843)', () => {
  test('a configured app version lands on the self member and in what it prints', async () => {
    const node = await startNode({ port: 59_401, hocon: 'actor-ts.cluster.app-version = "2.4.0"' });

    expect(node.cluster.selfMember()?.appVersion).toBe('2.4.0');
    expect(node.cluster.selfMember()?.toString()).toContain(' app-version=2.4.0)');
  });

  test('an explicit app version wins over the file', async () => {
    const node = await startNode({
      port: 59_402,
      hocon: 'actor-ts.cluster.app-version = "from-file"',
      appVersion: 'from-code',
    });

    expect(node.cluster.selfMember()?.appVersion).toBe('from-code');
  });

  test('a node nobody configured states none, and its record carries none', async () => {
    const node = await startNode({ port: 59_403 });
    const self = node.cluster.selfMember();

    expect(self?.appVersion).toBeUndefined();
    expect('appVersion' in (self?.toData() ?? {})).toBe(false);
  });

  test('a configured label no peer would admit fails the join', async () => {
    // Refused in `Cluster.join`, before the constructor and before any socket,
    // and naming the field — the alternative is a node that starts, gossips a
    // label, and has it dropped by every peer without a word.
    await expect(startNode({ port: 59_404, hocon: 'actor-ts.cluster.app-version = "2.4.0 beta"' }))
      .rejects.toThrow(OptionsError);
  });

  test('two nodes on different releases each read the other\'s label off gossip', async () => {
    // The rolling-update window itself: old and new code in one cluster, and
    // the label is what tells an operator which node runs which.
    const older = await startNode({ port: 59_411, appVersion: '2.4.0' });
    const newer = await startNode({ port: 59_412, seeds: [addressOf(59_411)], appVersion: '2.5.0' });

    await awaitCondition(
      () => labelHeldBy(older, newer.cluster.selfAddress) === '2.5.0'
        && labelHeldBy(newer, older.cluster.selfAddress) === '2.4.0'
        && older.cluster.upMembers().length === 2
        && newer.cluster.upMembers().length === 2,
      { timeoutMs: 4_000, intervalMs: 20, label: 'both up, each holding the other\'s label' },
    );
  });

  test('a node that states none is carried as none, not as an empty label', async () => {
    const stating = await startNode({ port: 59_421, appVersion: '2.4.0' });
    const silent = await startNode({ port: 59_422, seeds: [addressOf(59_421)] });

    await awaitCondition(
      () => stating.cluster.upMembers().length === 2 && silent.cluster.upMembers().length === 2,
      { timeoutMs: 4_000, intervalMs: 20, label: 'both up' },
    );
    const held = stating.cluster.getMembers().find((member) => member.address.equals(silent.cluster.selfAddress));
    expect('appVersion' in (held?.toData() ?? { appVersion: 'missing member' })).toBe(false);
    expect(labelHeldBy(silent, stating.cluster.selfAddress)).toBe('2.4.0');
  });
});

describe('Cluster.bootstrap states the label from the file or the builder (#843, #860)', () => {
  // Two routes on the headline path: `actor-ts.cluster.app-version`, read by
  // the join itself, and `withAppVersion`, which `bootstrapCluster` forwards.
  // The bootstrap assembles the options it hands `Cluster.join` field by field,
  // which is how an explicit value once came to shadow the file there (#836) —
  // so the label is forwarded only when set, and both directions are pinned:
  // a change to that assembly can neither cut the builder off nor let an unset
  // field override the file.
  //
  // The bootstrap's discovery variables are cleared per test: the default
  // ladder reads them, and a developer's `CLUSTER_SEEDS` would answer here.
  const DISCOVERY_VARIABLES = ['CLUSTER_SEEDS', 'CLUSTER_SERVICE_NAME', 'CLUSTER_NAMESPACE', 'KUBERNETES_SERVICE_HOST'] as const;
  const savedVariables = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of DISCOVERY_VARIABLES) {
      savedVariables.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of savedVariables) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    savedVariables.clear();
  });

  test('a configured app version lands on the self member of a bootstrapped node', async () => {
    const name = 'app-version-bootstrap';
    const bootstrapOptions = ClusterBootstrapOptions.create(name)
      .withHost('127.0.0.1')
      .withPort(59_511)
      .withTransport(new InMemoryTransport(new NodeAddress(name, '127.0.0.1', 59_511, 'test-run')))
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withAwaitReady(false)
      .withLogger(new NoopLogger())
      .withConfig(Config.parseString('actor-ts.cluster.app-version = "2.4.0"'));

    const { system, cluster } = await bootstrapCluster(bootstrapOptions);
    systems.push(system);
    clusters.push(cluster);

    expect(cluster.selfMember()?.appVersion).toBe('2.4.0');
  });

  test('a label set on the builder lands on the self member of a bootstrapped node', async () => {
    const name = 'app-version-bootstrap-builder';
    const bootstrapOptions = ClusterBootstrapOptions.create(name)
      .withHost('127.0.0.1')
      .withPort(59_512)
      .withTransport(new InMemoryTransport(new NodeAddress(name, '127.0.0.1', 59_512, 'test-run')))
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withAwaitReady(false)
      .withLogger(new NoopLogger())
      .withAppVersion('2.5.0');

    const { system, cluster } = await bootstrapCluster(bootstrapOptions);
    systems.push(system);
    clusters.push(cluster);

    expect(cluster.selfMember()?.appVersion).toBe('2.5.0');
  });

  test('a label set on the builder outranks the file', async () => {
    const name = 'app-version-bootstrap-over-file';
    const bootstrapOptions = ClusterBootstrapOptions.create(name)
      .withHost('127.0.0.1')
      .withPort(59_513)
      .withTransport(new InMemoryTransport(new NodeAddress(name, '127.0.0.1', 59_513, 'test-run')))
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withAwaitReady(false)
      .withLogger(new NoopLogger())
      .withConfig(Config.parseString('actor-ts.cluster.app-version = "from-file"'))
      .withAppVersion('from-code');

    const { system, cluster } = await bootstrapCluster(bootstrapOptions);
    systems.push(system);
    clusters.push(cluster);

    expect(cluster.selfMember()?.appVersion).toBe('from-code');
  });
});

/* -------------------------------------------------------------------------- */
/* The overlay lane, frame by frame                                             */
/* -------------------------------------------------------------------------- */

/** The merge internals the overlay cases drive, so a round is a call and not a wait. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: GossipMessage): void;
  memberDataForGossip(member: Member): MemberData;
}

/**
 * One gossip frame, spelled out down to which connection it arrives on —
 * authority is keyed on the connection (`Cluster.maySpeakFor`), replay
 * rejection on the sequence, and the merge branch on the version, so a helper
 * that folded them together could express neither a relayed record nor a
 * second frame at an unchanged member version.
 */
type ClaimSpec = {
  readonly node: Node;
  /** The connection the frame arrives on. */
  readonly sender: NodeAddress;
  /** The member the record describes; equal to `sender` for a self-announcement. */
  readonly subject: NodeAddress;
  readonly version: number;
  readonly sequence: number;
  readonly status?: MemberStatus;
  /** Omitted for a record that carries none — what a node that predates the field sends. */
  readonly appVersion?: string;
  /** A tombstone's age stamp; only meaningful with `status: 'removed'`. */
  readonly removedAt?: number;
};

function gossipClaim(spec: ClaimSpec): void {
  const record: MemberData = {
    address: spec.subject.toJSON(),
    status: spec.status ?? 'up',
    version: spec.version,
    roles: [],
    ...(spec.removedAt === undefined ? {} : { removedAt: spec.removedAt }),
    ...(spec.appVersion === undefined ? {} : { appVersion: spec.appVersion }),
  };
  (spec.node.cluster as unknown as ClusterInternals).handleWire(spec.sender, {
    kind: 'gossip', from: spec.sender.toJSON(), sequence: spec.sequence, members: [record],
  });
}

describe('a peer\'s label survives the release that introduces the field (#843)', () => {
  /**
   * A node of the previous release drops the label from every record it
   * relays and every record it re-versions, and `mergeMember` stores a first
   * sighting as received and replaces wholesale on a higher version.  So the
   * label rides the overlay lane beside the two claims: the subject's own
   * frame restates it at an unchanged version, and that frame is what fills a
   * slot a relay left empty.
   */
  test('a record first learned from a node that predates the field fills on the subject\'s own frame', async () => {
    const node = await startNode({ port: 59_431 });
    const subject = new NodeAddress(SYSTEM, HOST, 59_432, 'test-run');
    const relay = new NodeAddress(SYSTEM, HOST, 59_433, 'test-run');
    const version = Date.now();

    // The relay needs standing before it may speak about a third node.
    gossipClaim({ node, sender: relay, subject: relay, version, sequence: version });
    gossipClaim({ node, sender: relay, subject, version, sequence: version + 1 });
    expect(labelHeldBy(node, subject)).toBeUndefined();

    gossipClaim({ node, sender: subject, subject, version, sequence: version, appVersion: '2.4.0' });

    expect(labelHeldBy(node, subject)).toBe('2.4.0');
  });

  test('a re-version by a node that predates the field strips the label, and the subject\'s next frame restores it', async () => {
    const node = await startNode({ port: 59_441 });
    const subject = new NodeAddress(SYSTEM, HOST, 59_442, 'test-run');
    const relay = new NodeAddress(SYSTEM, HOST, 59_443, 'test-run');
    const version = Date.now();

    gossipClaim({ node, sender: relay, subject: relay, version, sequence: version });
    gossipClaim({ node, sender: subject, subject, version, sequence: version, appVersion: '2.4.0' });
    expect(labelHeldBy(node, subject)).toBe('2.4.0');

    // The relay's detector marks the subject unreachable — a third-party
    // observation every node has to converge on, so it merges wholesale at the
    // higher version, and the relay's release knows no label to carry.
    gossipClaim({
      node, sender: relay, subject, version: version + 1, sequence: version + 1, status: 'unreachable',
    });
    expect(labelHeldBy(node, subject)).toBeUndefined();

    // The subject's own frame still carries its own view of itself: `up`, at
    // the version it holds, which is now the older one.
    gossipClaim({ node, sender: subject, subject, version, sequence: version + 1, appVersion: '2.4.0' });

    const held = node.cluster.getMembers().find((member) => member.address.equals(subject));
    expect({ status: held?.status, version: held?.version, appVersion: held?.appVersion })
      .toEqual({ status: 'unreachable', version: version + 1, appVersion: '2.4.0' });
  });

  test('a third party cannot overwrite the label the subject stated', async () => {
    // Gossip is epidemic: a relay's copy of a record can be arbitrarily old,
    // or invented.  Letting it overwrite the subject's own statement would
    // flap the label against whichever copy arrived last.
    const node = await startNode({ port: 59_451 });
    const subject = new NodeAddress(SYSTEM, HOST, 59_452, 'test-run');
    const relay = new NodeAddress(SYSTEM, HOST, 59_453, 'test-run');
    const version = Date.now();

    gossipClaim({ node, sender: relay, subject: relay, version, sequence: version });
    gossipClaim({ node, sender: subject, subject, version, sequence: version, appVersion: '2.4.0' });
    gossipClaim({ node, sender: relay, subject, version, sequence: version + 1, appVersion: '6.6.6' });

    expect(labelHeldBy(node, subject)).toBe('2.4.0');
  });

  test('a third party naming the subject\'s own run cannot overwrite its label either', async () => {
    // The relay above names no run, so it is refused by the run rule before
    // the restate rule is ever asked.  Here every record names the subject's
    // run, and the only thing between a relay's copy and the held label is
    // the rule itself: a relay may fill an empty slot, never restate a held
    // one — at the same version or from an older copy alike.
    const node = await startNode({ port: 59_591 });
    const subject = new NodeAddress(SYSTEM, HOST, 59_592, 'subject-run');
    const relay = new NodeAddress(SYSTEM, HOST, 59_593, 'relay-run');
    const version = Date.now();

    gossipClaim({ node, sender: relay, subject: relay, version, sequence: version });
    gossipClaim({ node, sender: subject, subject, version, sequence: version, appVersion: '2.4.0' });

    gossipClaim({ node, sender: relay, subject, version, sequence: version + 1, appVersion: '6.6.6' });
    expect(labelHeldBy(node, subject)).toBe('2.4.0');

    gossipClaim({ node, sender: relay, subject, version: version - 1, sequence: version + 2, appVersion: '6.6.5' });
    expect(labelHeldBy(node, subject)).toBe('2.4.0');
    expect(heldRunOf(node, subject)).toBe('subject-run');
  });

  test('a label a third party put in an empty slot is corrected by the subject\'s own frame', async () => {
    // What separates "only the subject may restate" from fill-only: the label
    // never changes within one incarnation, but the first copy to fill a slot
    // need not be the subject's.  Fill-only would keep a relay's invention
    // for the rest of the incarnation.
    const node = await startNode({ port: 59_461 });
    const subject = new NodeAddress(SYSTEM, HOST, 59_462, 'test-run');
    const relay = new NodeAddress(SYSTEM, HOST, 59_463, 'test-run');
    const version = Date.now();

    gossipClaim({ node, sender: relay, subject: relay, version, sequence: version });
    gossipClaim({ node, sender: relay, subject, version, sequence: version + 1, appVersion: 'invented' });
    expect(labelHeldBy(node, subject)).toBe('invented');

    gossipClaim({ node, sender: subject, subject, version, sequence: version, appVersion: '2.4.0' });

    expect(labelHeldBy(node, subject)).toBe('2.4.0');
  });

  test('a subject restating the label it already stated is not a write', async () => {
    // Every round carries the whole member map, so the steady state is the
    // same label arriving over and over.
    const node = await startNode({ port: 59_471 });
    const subject = new NodeAddress(SYSTEM, HOST, 59_472, 'test-run');
    const version = Date.now();

    gossipClaim({ node, sender: subject, subject, version, sequence: version, appVersion: '2.4.0' });
    const first = node.cluster.getMembers().find((member) => member.address.equals(subject));
    for (let round = 1; round <= 5; round++) {
      gossipClaim({ node, sender: subject, subject, version, sequence: version + round, appVersion: '2.4.0' });
    }
    const last = node.cluster.getMembers().find((member) => member.address.equals(subject));

    expect(last).toBe(first!);
  });
});

describe('this node\'s own label survives a promotion merged from a peer\'s view (#843)', () => {
  // A promotion out of `joining` is merged wholesale, so without the
  // substitution in `withLocalSelfIdentity` the self record — what
  // `selfMember()`, `getMembers()` and every membership event report — would
  // say whatever the promoting leader's release knew to say.  The seed is a
  // node that is not running, which keeps this node `joining`: the only state
  // in which `maySpeakFor` admits a promotion from outside.

  test('a leader that predates the field does not wipe the label', async () => {
    const node = await startNode({ port: 59_481, seeds: [addressOf(59_489)], appVersion: '2.4.0' });
    expect(node.cluster.selfMember()?.status).toBe('joining');
    const leader = new NodeAddress(SYSTEM, HOST, 59_482, 'test-run');
    const version = Date.now();

    gossipClaim({ node, sender: leader, subject: leader, version, sequence: version });
    gossipClaim({
      node, sender: leader, subject: node.cluster.selfAddress, version: version + 1, sequence: version + 1,
    });

    const self = node.cluster.selfMember();
    expect({ status: self?.status, appVersion: self?.appVersion }).toEqual({ status: 'up', appVersion: '2.4.0' });
  });

  test('a promotion cannot hand a node that states none a label', async () => {
    // The label is fixed for the life of the incarnation and known before the
    // first frame, so a peer's record about it is an echo or wrong — the
    // substitution takes this node's own value outright, unset included.
    const node = await startNode({ port: 59_491, seeds: [addressOf(59_499)] });
    const leader = new NodeAddress(SYSTEM, HOST, 59_492, 'test-run');
    const version = Date.now();

    gossipClaim({ node, sender: leader, subject: leader, version, sequence: version });
    gossipClaim({
      node,
      sender: leader,
      subject: node.cluster.selfAddress,
      version: version + 1,
      sequence: version + 1,
      appVersion: 'invented',
    });

    const self = node.cluster.selfMember();
    expect({ status: self?.status, appVersion: self?.appVersion }).toEqual({ status: 'up', appVersion: undefined });
  });

  test('a self record leaves stamped with what this node states, whatever the stored copy says', async () => {
    // Defence in depth, pinned as such: today the stored self record carries
    // the label on every path — seeded at start, carried by every transition,
    // substituted on every merge — so only a future write path that forgets
    // it could make the two differ, and the frame must not depend on that.
    // A peer's record leaves exactly as it is held.
    const node = await startNode({ port: 59_501, appVersion: '2.4.0' });
    const internals = node.cluster as unknown as ClusterInternals;
    const bareSelf = new Member(node.cluster.selfAddress, 'up', 7);
    const peer = new Member(new NodeAddress(SYSTEM, HOST, 59_502, 'test-run'), 'up', 7);

    expect(internals.memberDataForGossip(bareSelf).appVersion).toBe('2.4.0');
    expect('appVersion' in internals.memberDataForGossip(peer)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* A label belongs to the run that stated it                                    */
/* -------------------------------------------------------------------------- */

/** Which run — which incarnation — of `address` the node holds a record of. */
function heldRunOf(node: Node, address: NodeAddress): string | undefined {
  return node.cluster.getMembers().find((member) => member.address.equals(address))?.address.incarnation;
}

/** The record `node` would gossip about `address` — what it passes on, not just what it shows. */
function gossipedRecordOf(node: Node, address: NodeAddress): MemberData | undefined {
  const held = node.cluster.getMembers().find((member) => member.address.equals(address));
  return held === undefined
    ? undefined
    : (node.cluster as unknown as ClusterInternals).memberDataForGossip(held);
}

describe('a label belongs to the run that stated it (#843)', () => {
  /**
   * A restart is a new run at the same `host:port`, so the two runs' records
   * share a map key and `NodeAddress.equals` cannot tell them apart — only the
   * incarnation can.  A relay that has not yet heard of the restart still
   * holds the previous run's record, live or as the tombstone its leave left,
   * and gossips it at the previous run's lower version, which lands on the
   * overlay lane of the new run's entry.  A rollback onto a release that
   * states no label, or a deployment that stopped setting `APP_VERSION`, would
   * otherwise be shown cluster-wide with the label it no longer runs.
   */
  test("a previous run's tombstone does not label the run that replaced it", async () => {
    const node = await startNode({ port: 59_531 });
    const previousRun = new NodeAddress(SYSTEM, HOST, 59_532, 'previous-run');
    const nextRun = new NodeAddress(SYSTEM, HOST, 59_532, 'next-run');
    const relay = new NodeAddress(SYSTEM, HOST, 59_533, 'relay-run');
    const version = Date.now();

    gossipClaim({ node, sender: relay, subject: relay, version, sequence: version });
    gossipClaim({ node, sender: previousRun, subject: previousRun, version, sequence: version, appVersion: '2.5.0' });
    expect(labelHeldBy(node, previousRun)).toBe('2.5.0');

    // The address restarts stating none: another incarnation, a higher version.
    gossipClaim({ node, sender: nextRun, subject: nextRun, version: version + 10, sequence: version + 10 });
    expect(heldRunOf(node, nextRun)).toBe('next-run');
    expect(labelHeldBy(node, nextRun)).toBeUndefined();

    gossipClaim({
      node, sender: relay, subject: previousRun, version: version + 1, sequence: version + 1,
      status: 'removed', removedAt: Date.now(), appVersion: '2.5.0',
    });

    expect(labelHeldBy(node, nextRun)).toBeUndefined();
  });

  test("a previous run's live record does not label the run that replaced it", async () => {
    // The crash shape: no leave, so the relay still holds the previous run as
    // a member, at the version it last saw.
    const node = await startNode({ port: 59_541 });
    const previousRun = new NodeAddress(SYSTEM, HOST, 59_542, 'previous-run');
    const nextRun = new NodeAddress(SYSTEM, HOST, 59_542, 'next-run');
    const relay = new NodeAddress(SYSTEM, HOST, 59_543, 'relay-run');
    const version = Date.now();

    gossipClaim({ node, sender: relay, subject: relay, version, sequence: version });
    gossipClaim({ node, sender: previousRun, subject: previousRun, version, sequence: version, appVersion: '2.5.0' });
    gossipClaim({ node, sender: nextRun, subject: nextRun, version: version + 10, sequence: version + 10 });

    gossipClaim({ node, sender: relay, subject: previousRun, version, sequence: version + 1, appVersion: '2.5.0' });

    expect(heldRunOf(node, nextRun)).toBe('next-run');
    expect(labelHeldBy(node, nextRun)).toBeUndefined();
  });

  test("a frame on the subject's own connection that names another run says nothing about this one", async () => {
    // A late frame of the previous run, numbered past the replay mark the new
    // run's frames left — the sequence guard is not what keeps the label off.
    const node = await startNode({ port: 59_551 });
    const previousRun = new NodeAddress(SYSTEM, HOST, 59_552, 'previous-run');
    const nextRun = new NodeAddress(SYSTEM, HOST, 59_552, 'next-run');
    const version = Date.now();

    gossipClaim({ node, sender: previousRun, subject: previousRun, version, sequence: version, appVersion: '2.5.0' });
    gossipClaim({ node, sender: nextRun, subject: nextRun, version: version + 10, sequence: version + 10 });

    gossipClaim({ node, sender: previousRun, subject: previousRun, version, sequence: version + 11, appVersion: '2.5.0' });

    expect(labelHeldBy(node, nextRun)).toBeUndefined();
  });

  test('the subject stating none takes back a label a relay put in its slot', async () => {
    // Within one run a relay may fill an empty slot, and the first copy to
    // fill it need not be the subject's.  The subject's own frame is its
    // statement — and stating none is a statement too.
    const node = await startNode({ port: 59_561 });
    const subject = new NodeAddress(SYSTEM, HOST, 59_562, 'subject-run');
    const relay = new NodeAddress(SYSTEM, HOST, 59_563, 'relay-run');
    const version = Date.now();

    gossipClaim({ node, sender: relay, subject: relay, version, sequence: version });
    gossipClaim({ node, sender: subject, subject, version, sequence: version });
    gossipClaim({ node, sender: relay, subject, version, sequence: version + 1, appVersion: 'invented' });
    expect(labelHeldBy(node, subject)).toBe('invented');

    gossipClaim({ node, sender: subject, subject, version, sequence: version + 1 });

    expect(labelHeldBy(node, subject)).toBeUndefined();
    expect(gossipedRecordOf(node, subject)).not.toHaveProperty('appVersion');
  });

  test('a relayed record without a label clears nothing the subject stated', async () => {
    // Only the subject's own silence is a statement.  A relay that predates
    // the field sends every record without one, at an unchanged version too.
    const node = await startNode({ port: 59_571 });
    const subject = new NodeAddress(SYSTEM, HOST, 59_572, 'subject-run');
    const relay = new NodeAddress(SYSTEM, HOST, 59_573, 'relay-run');
    const version = Date.now();

    gossipClaim({ node, sender: relay, subject: relay, version, sequence: version });
    gossipClaim({ node, sender: subject, subject, version, sequence: version, appVersion: '2.4.0' });

    gossipClaim({ node, sender: relay, subject, version, sequence: version + 1 });

    expect(labelHeldBy(node, subject)).toBe('2.4.0');
  });

  test('a relayed label fills a slot only when both records name the same run', async () => {
    // A record relayed through a node that predates the incarnation field
    // (#940) names no run, and then nothing says whose label it carries —
    // whichever side is missing it.  The subject's own frame still fills.
    const node = await startNode({ port: 59_581 });
    const subject = new NodeAddress(SYSTEM, HOST, 59_582, 'subject-run');
    const subjectNamingNoRun = new NodeAddress(SYSTEM, HOST, 59_582, 'test-run');
    const relay = new NodeAddress(SYSTEM, HOST, 59_583, 'relay-run');
    const version = Date.now();

    gossipClaim({ node, sender: relay, subject: relay, version, sequence: version });
    gossipClaim({ node, sender: subject, subject, version, sequence: version });
    gossipClaim({ node, sender: relay, subject: subjectNamingNoRun, version, sequence: version + 1, appVersion: '2.5.0' });
    expect(labelHeldBy(node, subject)).toBeUndefined();

    // The other side: the held record names no run, the relayed one does.
    const otherSubject = new NodeAddress(SYSTEM, HOST, 59_584, 'test-run');
    const otherSubjectRun = new NodeAddress(SYSTEM, HOST, 59_584, 'other-run');
    gossipClaim({ node, sender: otherSubject, subject: otherSubject, version, sequence: version });
    gossipClaim({ node, sender: relay, subject: otherSubjectRun, version, sequence: version + 2, appVersion: '2.5.0' });
    expect(labelHeldBy(node, otherSubject)).toBeUndefined();

    // And the positive half: the same run on both sides fills.
    gossipClaim({ node, sender: relay, subject, version, sequence: version + 3, appVersion: '2.4.0' });
    expect(labelHeldBy(node, subject)).toBe('2.4.0');
  });
});

describe('a member restarted without a label is shown without one, cluster-wide (#843)', () => {
  /**
   * End to end, the shape the frame cases above take apart: three real nodes,
   * the labelled one goes away and comes back at the same address stating
   * none.  Whether the peer that has not yet heard of the restart gossips the
   * previous run's record to the one that has, in the window before both
   * have, is a race — which is why the leave case runs three times.  Once both
   * peers hold the new run, no record of the previous one is left anywhere to
   * relay, so that is when the check is made, and again after the restarted
   * node's own frames have reached both.
   */
  type RestartMode = 'leave' | 'crash';

  type Restarted = {
    readonly peers: ReadonlyArray<Node>;
    readonly restarted: Node;
    readonly nextRun: NodeAddress;
  };

  /** Drop a node the case has already ended from the teardown lists. */
  function forget(node: Node): void {
    const clusterIndex = clusters.indexOf(node.cluster);
    if (clusterIndex >= 0) clusters.splice(clusterIndex, 1);
    const systemIndex = systems.indexOf(node.system);
    if (systemIndex >= 0) systems.splice(systemIndex, 1);
  }

  async function restartWithLabel(basePort: number, mode: RestartMode, label: string | undefined): Promise<Restarted> {
    // `auto-down = off`: the crashed run stays a member until its successor
    // replaces it, which is the path under test, rather than being removed
    // by a timer racing the restart.
    const seeds = [addressOf(basePort)];
    const peers = [
      await startNode({ port: basePort, autoDown: false }),
      await startNode({ port: basePort + 1, seeds, autoDown: false }),
    ];
    const subject = await startNode({ port: basePort + 2, seeds, appVersion: '2.5.0', autoDown: false });
    const firstRun = subject.cluster.selfAddress;
    // The subject's own view too: its leave goes to the peers *it* knows, and
    // the peers can converge on it before it has heard of both of them.
    await awaitCondition(
      () => [...peers, subject].every((node) => node.cluster.upMembers().length === 3)
        && peers.every((peer) => labelHeldBy(peer, firstRun) === '2.5.0'),
      { timeoutMs: 3_000, intervalMs: 10, label: 'three members up everywhere, both peers showing the first run\'s label' },
    );

    if (mode === 'leave') {
      await subject.cluster.leave();
      await awaitCondition(
        () => peers.every((peer) => heldRunOf(peer, firstRun) === undefined),
        { timeoutMs: 3_000, intervalMs: 10, label: 'both peers holding the first run as left' },
      );
    } else {
      // A crash: the transport goes first, so not even a leave frame gets out.
      await subject.transport.shutdown();
    }
    await subject.system.terminate();
    forget(subject);

    const restarted = await startNode({ port: basePort + 2, seeds, appVersion: label, autoDown: false });
    const nextRun = restarted.cluster.selfAddress;
    expect(nextRun.incarnation).not.toBe(firstRun.incarnation);
    await awaitCondition(
      () => [...peers, restarted].every((node) => node.cluster.upMembers().length === 3)
        && peers.every((peer) => heldRunOf(peer, nextRun) === nextRun.incarnation),
      { timeoutMs: 3_000, intervalMs: 10, label: 'the restarted run up on every node' },
    );
    return { peers, restarted, nextRun };
  }

  /** Until each peer has accepted a gossip frame the restarted node sent after this call. */
  async function awaitOwnFrameOnEveryPeer({ peers, restarted }: Restarted): Promise<void> {
    const sentSoFar = (restarted.cluster as unknown as { readonly gossipSequence: number }).gossipSequence;
    const key = restarted.cluster.selfAddress.toString();
    await awaitCondition(
      () => peers.every((peer) => {
        const accepted = (peer.cluster as unknown as {
          readonly acceptedGossipSequences: ReadonlyMap<string, number>;
        }).acceptedGossipSequences.get(key);
        return accepted !== undefined && accepted > sentSoFar;
      }),
      { timeoutMs: 3_000, intervalMs: 10, label: 'a fresh frame from the restarted node on both peers' },
    );
  }

  function expectNoLabelAnywhere({ peers, restarted, nextRun }: Restarted): void {
    expect(restarted.cluster.selfMember()?.appVersion).toBeUndefined();
    for (const peer of peers) {
      expect(labelHeldBy(peer, nextRun)).toBeUndefined();
      expect(gossipedRecordOf(peer, nextRun)).not.toHaveProperty('appVersion');
    }
  }

  for (const run of [1, 2, 3]) {
    test(`after a leave, stating none (run ${run} of 3)`, async () => {
      const restart = await restartWithLabel(59_600 + run * 10, 'leave', undefined);

      expectNoLabelAnywhere(restart);
      await awaitOwnFrameOnEveryPeer(restart);
      expectNoLabelAnywhere(restart);
    }, 15_000);
  }

  test('after a crash, stating none', async () => {
    const restart = await restartWithLabel(59_640, 'crash', undefined);

    expectNoLabelAnywhere(restart);
    await awaitOwnFrameOnEveryPeer(restart);
    expectNoLabelAnywhere(restart);
  }, 15_000);

  test('after a leave, stating another label: both peers show the new one', async () => {
    const restart = await restartWithLabel(59_650, 'leave', '2.6.0');
    await awaitOwnFrameOnEveryPeer(restart);

    expect(restart.restarted.cluster.selfMember()?.appVersion).toBe('2.6.0');
    for (const peer of restart.peers) expect(labelHeldBy(peer, restart.nextRun)).toBe('2.6.0');
  }, 15_000);
});
