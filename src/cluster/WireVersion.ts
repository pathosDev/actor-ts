import type { NodeAddressData } from './NodeAddress.js';

/**
 * The cluster wire's protocol version, announced in every `hello` and
 * `hello-ack` (#823).
 *
 * Version 1 is every release before the field existed: a `hello` with no
 * version is a version-1 peer.  Version 2 is the one that requires every node
 * address on a cluster frame to name its incarnation, which is what lets a
 * restart at the same `host:port` be told apart from the run it replaced and a
 * downed run be refused by identity rather than by address (#940).  Version 3
 * (v0.19.0) is the one whose receiver decodes a frame through a tag allow-list
 * (#1303): a version-2 node writes `RegExp`, `URL`, `Error` and value-position
 * `undefined` tags unasked, and a version-3 node on the default list refuses
 * every frame carrying one.  The frames themselves did not change shape, which
 * is exactly why the version had to: without it the two would form a cluster
 * and lose those messages one at a time, with nothing at the handshake to say
 * why.  Version 3 keeps version 2's incarnation requirement.
 *
 * A protocol declaration, so it stays beside the negotiation that reads it
 * rather than in a `Constants.ts`.
 */
export const CLUSTER_WIRE_VERSION = 3;

/**
 * The oldest cluster wire version this build talks to.  Equal to
 * {@link CLUSTER_WIRE_VERSION}: both moves so far are hard cuts.  Version 2,
 * because a version-2 node relaying records it learned from a version-1 peer
 * would carry addresses with no incarnation into frames every other version-2
 * node refuses whole; version 3, because a version-2 peer's frames carrying the
 * four tags outside the default allow-list would be refused one by one (#1303).
 * Nodes on either side of a cut refuse each other at the handshake, with a line
 * on both sides that says so, instead of half-working.
 */
export const MIN_CLUSTER_WIRE_VERSION = 3;

/** What a peer announced about its wire version — absent fields are a version-1 peer. */
export type AnnouncedWireVersion = {
  readonly wireVersion?: unknown;
  readonly minWireVersion?: unknown;
};

/**
 * Why this node will not talk to a peer that announced `announced` about
 * itself as `self`, or `null` when it will (#823).
 *
 * The rule is the usual overlap of two ranges: the peer speaks
 * `minWireVersion..wireVersion` (a missing field meaning version 1), this node
 * {@link MIN_CLUSTER_WIRE_VERSION}..{@link CLUSTER_WIRE_VERSION}, and the two
 * agree on the higher of the versions both speak — or on none.  From version 2
 * on, the peer's own address must carry its incarnation as well; a `hello` without
 * one is refused here rather than as a malformed frame, so the peer is told
 * why.
 */
export function wireVersionRefusal(announced: AnnouncedWireVersion, self: NodeAddressData): string | null {
  const peerMax = isWireVersion(announced.wireVersion) ? announced.wireVersion : 1;
  const peerMin = isWireVersion(announced.minWireVersion) ? announced.minWireVersion : peerMax;
  const agreed = Math.min(CLUSTER_WIRE_VERSION, peerMax);
  if (agreed < Math.max(MIN_CLUSTER_WIRE_VERSION, peerMin)) {
    return `it speaks cluster wire v${peerMin}..v${peerMax} and this node v${MIN_CLUSTER_WIRE_VERSION}..v`
      + `${CLUSTER_WIRE_VERSION}, so the two share no version. Nodes on either side of the `
      + `v${MIN_CLUSTER_WIRE_VERSION} cut cannot form one cluster: upgrade every node, or roll this one back`;
  }
  if (agreed >= 2 && self.incarnation === undefined) {
    return `it announced no incarnation, which cluster wire v${agreed} requires of every node address`;
  }
  return null;
}

function isWireVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
