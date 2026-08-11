import type { NodeAddress } from './NodeAddress.js';
import type { PeerCertificate } from '../runtime/tcp/index.js';

/**
 * Whether a TLS peer certificate vouches for the node identity a `hello`
 * frame claims (#912).
 *
 * mTLS answers "may this peer be in the cluster"; it has never answered
 * "is this peer the node it says it is".  The `hello` frame carries a
 * `NodeAddress` and no credential, so on a fully mTLS-configured cluster a
 * single CA-signed node could still announce itself under another member's
 * address — and every gossip-authority rule added in #562/#564/#572 keys off
 * the connection's peer, so they are only as strong as the identity
 * underneath them.
 *
 * The rule is host-based, and that is a deliberate ceiling rather than an
 * oversight.  A certificate attests to names — a CN and its SANs — and a
 * cluster address is `systemName@host:port`, of which only the host is a
 * name a CA would ever certify.  So a claim is accepted when the certificate
 * covers **either**:
 *
 * - the address's `host` — the ordinary deployment, where each node's cert
 *   carries its own hostname or IP; this is what stops one node claiming
 *   another node's address across hosts, and
 * - the full `systemName@host` — for deployments that mint a per-node
 *   identity and want the stronger binding.
 *
 * **What this cannot do:** two nodes sharing one host certificate are
 * indistinguishable to it, and no certificate-based rule could separate them
 * without per-node certificates.  Operators who need that must issue
 * per-node certs naming `systemName@host`.  Wildcards are matched only in
 * the leftmost label, as TLS itself does.
 */
export function certificateVouchesFor(
  certificate: PeerCertificate,
  claimed: NodeAddress,
): boolean {
  const names = certificate.commonName === undefined
    ? certificate.subjectAlternativeNames
    : [certificate.commonName, ...certificate.subjectAlternativeNames];

  const host = claimed.host.trim().toLowerCase();
  const perNodeIdentity = `${claimed.systemName}@${claimed.host}`.trim().toLowerCase();

  return names.some((name: string) => {
    const certified = name.trim().toLowerCase();
    if (certified.length === 0) return false;
    // The host is a DNS name, so wildcards apply to it.
    if (hostMatches(certified, host)) return true;
    // `systemName@host` is not a DNS name — it is an identity string this
    // project composes.  Exact match only: allowing a wildcard here would
    // let `*.internal` vouch for `node-b@node-a.internal`, because
    // `node-b@node-a` reads as a single dotless "label" while being nothing
    // of the kind.  That would reinstate exactly the impersonation this
    // function exists to stop.
    return certified === perNodeIdentity;
  });
}

/**
 * Case-insensitive host comparison with leftmost-label wildcards, the rule
 * TLS hostname verification itself uses.  `*.internal` matches
 * `node-a.internal` but not `node-a.eu.internal` and not a bare `internal` —
 * a wildcard that spanned dots would let one certificate speak for an entire
 * tree.
 */
function hostMatches(certifiedName: string, host: string): boolean {
  if (host.length === 0) return false;
  if (certifiedName === host) return true;

  if (!certifiedName.startsWith('*.')) return false;
  const suffix = certifiedName.slice(1); // keeps the leading dot
  if (!host.endsWith(suffix)) return false;
  // Exactly one non-empty, dotless label may stand in for the wildcard.
  const label = host.slice(0, host.length - suffix.length);
  return label.length > 0 && !label.includes('.');
}
