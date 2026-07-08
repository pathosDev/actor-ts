import { describe, expect, test } from 'bun:test';
import { decodeRefs } from '../../../src/cluster/RefCodec.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { Nobody } from '../../../src/ActorRef.js';
import { RemoteActorRef } from '../../../src/cluster/RemoteActorRef.js';
import { none } from '../../../src/util/Option.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';

const known = new NodeAddress('sys', '10.0.0.2', 2552);

// Minimal duck-typed Cluster: decodeSingleRef only touches selfAddress,
// system._resolvePath, and _isKnownMemberAddress.
const cluster = {
  selfAddress: new NodeAddress('sys', '10.0.0.1', 2552),
  system: { _resolvePath: () => none },
  _isKnownMemberAddress: (addr: NodeAddress) => addr.equals(known),
} as unknown as Cluster;

const wireRef = (host: string, port: number) => ({
  $ref: 'actor' as const, path: 'actor-ts://sys/user/x', host, port, system: 'sys',
});

// SECURITY_AUDIT.md #2 — a decoded reply-to ref may only point at a known
// cluster member.  Otherwise a hostile envelope embeds an arbitrary host:port
// and the node dials it (SSRF) the moment an actor replies.
describe('decodeRefs — SSRF guard (#2)', () => {
  test('a ref to a KNOWN member decodes to a RemoteActorRef', () => {
    const out = decodeRefs({ replyTo: wireRef('10.0.0.2', 2552) }, cluster) as { replyTo: unknown };
    expect(out.replyTo).toBeInstanceOf(RemoteActorRef);
  });

  test('a ref to an UNKNOWN host is dropped to Nobody (no dial)', () => {
    const out = decodeRefs({ replyTo: wireRef('169.254.169.254', 80) }, cluster) as { replyTo: unknown };
    expect(out.replyTo).toBe(Nobody);
  });

  test('a ref to a known host but a different port is dropped', () => {
    const out = decodeRefs({ replyTo: wireRef('10.0.0.2', 9999) }, cluster) as { replyTo: unknown };
    expect(out.replyTo).toBe(Nobody);
  });

  test('a ref back to the SENDING peer is allowed even when not a member (reply-to-sender)', () => {
    const sender = new NodeAddress('sys', '10.9.9.9', 2552);   // not the known member
    const out = decodeRefs({ replyTo: wireRef('10.9.9.9', 2552) }, cluster, sender) as { replyTo: unknown };
    expect(out.replyTo).toBeInstanceOf(RemoteActorRef);
  });
});
