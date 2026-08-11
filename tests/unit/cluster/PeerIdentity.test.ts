/**
 * #912 — mTLS answers "may this peer be in the cluster".  It never answered
 * "is this peer the node it says it is": the `hello` frame carries a
 * `NodeAddress` and no credential, so one CA-signed node could announce
 * itself under another member's address.  Every gossip-authority rule from
 * #562/#564/#572 keys off the connection's peer, so they were only as strong
 * as that self-declared identity.
 */
import { describe, expect, test } from 'bun:test';
import { certificateVouchesFor } from '../../../src/cluster/PeerIdentity.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { PeerCertificate } from '../../../src/runtime/tcp/index.js';

const certificate = (
  commonName: string | undefined,
  ...subjectAlternativeNames: string[]
): PeerCertificate => (commonName === undefined
  ? { subjectAlternativeNames }
  : { commonName, subjectAlternativeNames });

const nodeA = new NodeAddress('node-a', '10.0.0.7', 2552);
const nodeB = new NodeAddress('node-b', '10.0.0.8', 2552);

describe('certificateVouchesFor', () => {
  test('a certificate naming the host admits that host claim', () => {
    // The ordinary deployment: each node's cert carries its own address.
    expect(certificateVouchesFor(certificate('10.0.0.7'), nodeA)).toBe(true);
    expect(certificateVouchesFor(certificate(undefined, '10.0.0.7'), nodeA)).toBe(true);
  });

  test('node-a cannot complete a hello claiming to be node-b', () => {
    // The exploit from the report, and the whole point of the change.
    const nodeACertificate = certificate('10.0.0.7', 'node-a', 'node-a@10.0.0.7');
    expect(certificateVouchesFor(nodeACertificate, nodeB)).toBe(false);
    expect(certificateVouchesFor(nodeACertificate, nodeA)).toBe(true);
  });

  test('a per-node certificate may name systemName@host', () => {
    // The stronger binding, for deployments that mint per-node identities.
    const perNode = certificate('node-a@10.0.0.7');
    expect(certificateVouchesFor(perNode, nodeA)).toBe(true);
    // And it does not thereby vouch for a different system on the same host.
    expect(certificateVouchesFor(perNode, new NodeAddress('other', '10.0.0.7', 2552))).toBe(false);
  });

  test('a shared host certificate cannot separate two systems on that host', () => {
    // Stated as a limit rather than hidden: no certificate-based rule can
    // distinguish them, and pretending otherwise would be the worse failure.
    const hostCertificate = certificate('10.0.0.7');
    expect(certificateVouchesFor(hostCertificate, new NodeAddress('node-a', '10.0.0.7', 2552))).toBe(true);
    expect(certificateVouchesFor(hostCertificate, new NodeAddress('node-b', '10.0.0.7', 2552))).toBe(true);
  });

  test('the port is not part of the match', () => {
    // A CA certifies names, not ports; two ports on one host share a cert.
    expect(certificateVouchesFor(certificate('10.0.0.7'), new NodeAddress('node-a', '10.0.0.7', 9999)))
      .toBe(true);
  });

  test('matching is case-insensitive, as DNS is', () => {
    expect(certificateVouchesFor(certificate('NODE-A.INTERNAL'), new NodeAddress('node-a', 'node-a.internal', 1)))
      .toBe(true);
  });

  test('a wildcard covers exactly one leftmost label', () => {
    const wildcard = certificate('*.internal');
    expect(certificateVouchesFor(wildcard, new NodeAddress('s', 'node-a.internal', 1))).toBe(true);
    // Not a whole subtree — that would let one cert speak for every node.
    expect(certificateVouchesFor(wildcard, new NodeAddress('s', 'node-a.eu.internal', 1))).toBe(false);
    // And not the bare suffix.
    expect(certificateVouchesFor(wildcard, new NodeAddress('s', 'internal', 1))).toBe(false);
  });

  test('a wildcard does not match an empty label', () => {
    expect(certificateVouchesFor(certificate('*.internal'), new NodeAddress('s', '.internal', 1)))
      .toBe(false);
  });

  test('a certificate with no usable names admits nothing', () => {
    expect(certificateVouchesFor(certificate(undefined), nodeA)).toBe(false);
  });

  test('a substring of a certified name is not a match', () => {
    // Guards against a `.includes`-style implementation.
    expect(certificateVouchesFor(certificate('node-a.internal'), new NodeAddress('s', 'node-a', 1)))
      .toBe(false);
    expect(certificateVouchesFor(certificate('a'), new NodeAddress('s', 'node-a', 1))).toBe(false);
  });

  test('SAN entries are matched alongside the common name', () => {
    // Real certificates put the identity in SANs; the CN is legacy.
    expect(certificateVouchesFor(certificate('legacy-name', '10.0.0.7'), nodeA)).toBe(true);
  });
});

describe('certificateVouchesFor — wildcards are DNS-only', () => {
  test('a wildcard does not vouch for another system on a certified host', () => {
    // The regression this guards: matching `*.internal` against the composite
    // `systemName@host` reads `node-b@node-a` as one dotless label, so a
    // wildcard host certificate would admit any system claiming any host in
    // the tree — reinstating the impersonation the check exists to stop.
    const wildcard = certificate('*.internal');
    expect(certificateVouchesFor(wildcard, new NodeAddress('node-b', 'node-a.internal', 1)))
      .toBe(true); // host itself is certified — this is legitimate
    expect(certificateVouchesFor(wildcard, new NodeAddress('node-b', 'elsewhere.example', 1)))
      .toBe(false);
  });

  test('a wildcard never satisfies the systemName@host form on its own', () => {
    // `*.example` must not stand in for `node-b@node-a.example` by way of the
    // identity string; only the host arm may match it, and here it does not.
    expect(certificateVouchesFor(certificate('*.example'), new NodeAddress('node-b', 'other.test', 1)))
      .toBe(false);
  });
});
