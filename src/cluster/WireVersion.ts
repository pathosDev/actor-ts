import type { NodeAddressData } from './NodeAddress.js';

/**
 * The cluster wire's protocol version, announced in every `hello` and
 * `hello-ack` (#823).
 *
 * Version 1 is every release before the field existed: a `hello` with no
 * version is a version-1 peer.  Version 2 is the one that requires every node
 * address on a cluster frame to name its incarnation, which is what lets a
 * restart at the same `host:port` be told apart from the run it replaced and a
 * downed run be refused by identity rather than by address (#940).
 *
 * A protocol declaration, so it stays beside the negotiation that reads it
 * rather than in a `Constants.ts`.
 */
export const CLUSTER_WIRE_VERSION = 2;

/**
 * The oldest cluster wire version this build talks to.  Equal to
 * {@link CLUSTER_WIRE_VERSION}: the move to version 2 is a hard cut, because a
 * version-2 node relaying records it learned from a version-1 peer would carry
 * addresses with no incarnation into frames every other version-2 node refuses
 * whole.  Nodes of the two versions refuse each other at the handshake, with a
 * line on both sides that says so, instead of half-working.
 */
export const MIN_CLUSTER_WIRE_VERSION = 2;

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
 * agree on the higher of the versions both speak — or on none.  On version 2
 * the peer's own address must carry its incarnation as well; a `hello` without
 * one is refused here rather than as a malformed frame, so the peer is told
 * why.
 */
export function wireVersionRefusal(announced: AnnouncedWireVersion, self: NodeAddressData): string | null {
  const peerMax = isWireVersion(announced.wireVersion) ? announced.wireVersion : 1;
  const peerMin = isWireVersion(announced.minWireVersion) ? announced.minWireVersion : peerMax;
  const agreed = Math.min(CLUSTER_WIRE_VERSION, peerMax);
  if (agreed < Math.max(MIN_CLUSTER_WIRE_VERSION, peerMin)) {
    return `it speaks cluster wire v${peerMin}..v${peerMax} and this node v${MIN_CLUSTER_WIRE_VERSION}..v`
      + `${CLUSTER_WIRE_VERSION}, so the two share no version. Nodes on either side of the v2 cut cannot `
      + 'form one cluster: upgrade every node, or roll this one back';
  }
  if (agreed >= 2 && self.incarnation === undefined) {
    return 'it announced no incarnation, which cluster wire v2 requires of every node address';
  }
  return null;
}

function isWireVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
