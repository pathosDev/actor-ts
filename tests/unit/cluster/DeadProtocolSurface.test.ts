/**
 * Three pieces of protocol surface that were declared and never used (#681).
 *
 * `ShardMapMessage` (wire kind `shard-map`), `BeginHandOff` (sharding kind
 * `sharding.BeginHandOff`) and `ShardRegion.registered` — a private field
 * assigned in three places and read in none.  No release ever emitted either
 * frame, so nothing about node-to-node interoperability changes; what they cost
 * was reader time and one *false* comment, since `Cluster.onUnhandledWire`
 * claimed `'shard-map'` was handled by the wire-handler registry and nothing
 * ever registered it.
 *
 * Pinning a deletion needs care, because the ordinary evidence — a test that
 * exercises the thing — is exactly what dead surface does not have.  Each piece
 * gets the strongest binding its own shape allows:
 *
 *  - **`shard-map`**: a *runtime* one.  `wireFrameProblem` switches on
 *    `{ kind: string }`, not on the narrowed union, so its arm would have
 *    survived the type deletion as valid unreachable code that no gate flags.
 *    Whether a kind has an arm is observable: a core kind rejects an empty
 *    payload, an extension kind is passed through untouched.
 *  - **`sharding.BeginHandOff`**: a *compile-time* one, because the type never
 *    had a runtime footprint at all.  It fails under `bun run typecheck:dev`,
 *    which is the gate that compiles the library from a caller's side; `bun test`
 *    transpiles without checking and cannot see it.
 *  - **`ShardRegion.registered`**: a *structural* one.  A class field with an
 *    initialiser is an own property of every instance, so its presence is
 *    observable on a bare `new ShardRegion(...)` — no actor system, no cluster.
 */
import { describe, expect, test } from 'bun:test';
import { wireFrameProblem } from '../../../src/cluster/WireValidation.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { ShardRegion, type ShardRegionConfig } from '../../../src/cluster/sharding/ShardRegion.js';
import type { ShardingMessage } from '../../../src/cluster/sharding/ShardingProtocol.js';

/**
 * Satisfied only by `never`, so instantiating it with a non-empty type is a
 * compile error that names the member which came back.
 */
type AssertNever<T extends never> = T;

/**
 * Every `kind` `wireFrameProblem` has an arm for, and — via the two assertions
 * below — every `kind` in `WireMessage`.
 *
 * The list is the point: keeping it in lockstep with the union in both
 * directions is what makes a re-added `shard-map` a compile error rather than a
 * silent extra member, and what makes a *new* core kind arriving without a
 * validator arm one too.
 */
const CORE_WIRE_KINDS = [
  'hello',
  'hello-ack',
  'heartbeat',
  'heartbeat-ack',
  'gossip',
  'envelope',
  'leave',
] as const;

type ListedWireKind = (typeof CORE_WIRE_KINDS)[number];

/** A `WireMessage` member the list above does not carry — `shard-map` was one. */
type _NoUnlistedWireKind = AssertNever<Exclude<WireMessage['kind'], ListedWireKind>>;
/** A listed kind that is no longer a `WireMessage` member. */
type _NoStaleWireKind = AssertNever<Exclude<ListedWireKind, WireMessage['kind']>>;
/** The sharding request leg that was declared and never sent. */
type _NoBeginHandOffKind = AssertNever<Extract<ShardingMessage['kind'], 'sharding.BeginHandOff'>>;

describe("the wire union's kinds are exactly the ones with a validator arm (#681)", () => {
  test('every core kind refuses a payload-less frame', () => {
    // The positive control, and the thing that makes the case below mean
    // something: an arm exists iff the kind is checked, and every arm rejects a
    // frame with none of its fields present.
    for (const kind of CORE_WIRE_KINDS) {
      expect(wireFrameProblem({ kind })).not.toBeNull();
    }
  });

  test('shard-map is passed through like any other extension kind', () => {
    // Not "a malformed shard-map is accepted" — `shard-map` is not a kind of
    // this protocol any more, so it reaches `wireFrameProblem`'s default arm
    // exactly as `ddata-gossip` or `pubsub-gossip` do, and would be dropped by
    // `Cluster.onUnhandledWire` for having no registered handler. Nothing in
    // the tree sends one; sharding fans its allocation map out as a
    // `sharding.ShardMapUpdate` inside an envelope instead.
    expect(wireFrameProblem({ kind: 'shard-map' })).toBeNull();
    // Bound to a local rather than passed as a literal: `wireFrameProblem` takes
    // the floor shape `{ kind: string }`, so a fresh literal carrying the old
    // frame's fields trips the excess-property check — which is itself a small
    // proof that those fields are no longer part of any wire type.
    const shardMapShaped = { kind: 'shard-map', type: '', shards: null, version: 'not a number' };
    expect(wireFrameProblem(shardMapShaped)).toBeNull();
    // And the default arm is genuinely the one being hit, not a lucky pass.
    expect(wireFrameProblem({ kind: 'ddata-gossip' })).toBeNull();
  });
});

describe('ShardRegion carries no write-only registration flag (#681)', () => {
  test('`registered` is gone and its live sibling `registerRefused` is not', () => {
    // Constructed, never started: the constructor only stores `config`, and a
    // field initialiser is what puts the property on the instance. So this needs
    // no actor system, no cluster and no transport — the config is never read.
    const region = new ShardRegion({} as unknown as ShardRegionConfig<unknown>);

    expect(Object.hasOwn(region, 'registered')).toBe(false);
    // The discriminator. `registerRefused` looks like the same kind of flag and
    // is read — in `ensureRegistered`, to stop a refused region hammering the
    // register loop — so a sweep that took both would break #633 and pass an
    // assertion about `registered` alone.
    expect(Object.hasOwn(region, 'registerRefused')).toBe(true);
    expect(Object.hasOwn(region, 'coordinatorNode')).toBe(true);
  });
});
