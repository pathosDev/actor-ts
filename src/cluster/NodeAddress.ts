import { randomUuid } from '../util/RandomString.js';
import { MAX_NODE_INCARNATION_LENGTH } from './Constants.js';

/**
 * A node in the cluster is identified by host + port + system name.
 * Stringified as `system@host:port`.
 *
 * An address may additionally carry an **incarnation** — which *process* at
 * that `system@host:port` this address names.  See {@link NodeAddress.incarnation}
 * for what it is for and, more importantly, for what it deliberately is not
 * wired into yet.
 */
export class NodeAddress {
  /**
   * Which incarnation — which process — this address names (#940).
   *
   * `system@host:port` identifies a *slot*, not a process: a pod that restarts
   * onto the same address is a different process wearing the same name, and
   * every rule the cluster has about members is written against the slot.  A
   * per-process identifier is what lets "the node that used to be here" and
   * "the node that is here now" be different subjects.
   *
   * **It is carried, not yet acted on.**  Nothing in the merge path compares
   * two incarnations to decide whether a claim is believable, and that is a
   * decision rather than an omission.  The field is *optional* on the wire
   * (see {@link NodeAddressData}), because a required one breaks every one of
   * the eight address-bearing frame fields at once and this wire has no version
   * handshake to break them behind (#823).  An optional field, though, is
   * bypassed by *stripping* it — so a refusal keyed on a mismatch would be a
   * refusal an attacker opts out of, while still being a refusal a legitimate
   * peer of the previous version runs into.  The identifier has to be required
   * before it can carry a rule; carrying it first is what makes that step a
   * wire break and nothing else.
   *
   * What it may be used for meanwhile is strictly local: this node knows its
   * own incarnation, so a record a peer sends *about this node* can be held to
   * it (`Cluster.withLocalSelfIdentity`).  That direction only ever discards a
   * peer's claim in favour of local truth, which is the one comparison that
   * needs no agreement.
   *
   * Deliberately **outside** {@link toString}, {@link equals} and
   * {@link compareTo}: every map in the cluster is keyed on the string form,
   * the leader is elected by lexicographic order on it, `RefCodec` decides
   * local-vs-remote with `equals`, and a `SeedProvider` yields a `host:port`
   * that cannot know an incarnation.  Folding it into identity would make two
   * views of the same node two nodes.
   */
  constructor(
    public readonly systemName: string,
    public readonly host: string,
    public readonly port: number,
    public readonly incarnation?: string,
  ) {}

  toString(): string { return `${this.systemName}@${this.host}:${this.port}`; }

  equals(other: NodeAddress): boolean {
    return this.systemName === other.systemName
      && this.host === other.host
      && this.port === other.port;
  }

  /** Ordering used by the leader election: lexicographic on the string form. */
  compareTo(other: NodeAddress): number {
    return this.toString().localeCompare(other.toString());
  }

  /**
   * A fresh identifier for one process's run at this address (#940).
   *
   * A UUID rather than a counter or a timestamp for the reason `randomUuid`
   * states: this has to stay distinct from an identifier minted by *another*
   * process, with nothing coordinating the two — and the process it most has to
   * differ from is the one that just died at the same `host:port`, whose clock
   * and whose counter it would otherwise inherit.  It is not an ordering, so
   * nothing may compare two of them for age; the member `version` remains the
   * cluster's logical clock.
   */
  static mintIncarnation(): string { return randomUuid(); }

  /**
   * Whether `value` is an incarnation this node will accept off the wire.
   *
   * A non-empty string within {@link MAX_NODE_INCARNATION_LENGTH}, and no
   * format beyond that — see that constant for why the rule is a length rather
   * than a UUID shape.  Lives here rather than in `WireValidation` so the
   * decode guard and {@link fromJSON} cannot drift apart on what a valid
   * incarnation is.
   */
  static isIncarnation(value: unknown): value is string {
    return typeof value === 'string'
      && value.length > 0
      && value.length <= MAX_NODE_INCARNATION_LENGTH;
  }

  toJSON(): NodeAddressData {
    const data: NodeAddressData = { systemName: this.systemName, host: this.host, port: this.port };
    // Omitted when unset rather than written as `null`, for the reason
    // `Member.toData` omits `removedAt`: an address is on the wire once per
    // member per frame, so an always-present field is a per-member tax whether
    // it carries anything or not.  It also keeps a frame this node composes
    // byte-identical to the previous version's whenever the address has no
    // incarnation, which is what makes the addition invisible to a peer that
    // does not know the field.
    return this.incarnation === undefined ? data : { ...data, incarnation: this.incarnation };
  }

  /**
   * Rebuild an address from its wire form.
   *
   * The declared parameter type is a promise the wire cannot keep: every caller
   * on the receive path hands this whatever `JSON.parse` produced.  A port that
   * arrives as the *string* `"2552"` is the sharp case — `toString()` renders
   * it identically to the number, so it keys every map the same way, but
   * `equals()` compares `===` and never matches.  A node that reads its own
   * address back in that shape stops recognising itself, permanently (#571).
   *
   * Throwing rather than coercing is deliberate: a well-behaved peer never
   * sends this, so there is no shape worth repairing, and the transport's
   * frame guard rejects malformed addresses before they get here. This is the
   * backstop for the paths that reach it another way.
   *
   * `port` is checked as a **positive integer, not a TCP port** — the same rule
   * `ClusterOptionsValidator` states and for the same reason: under
   * `InMemoryTransport` the port is a synthetic node discriminator (tests use
   * five-digit values), and an address is transport-agnostic.  Whether a port
   * is dialable is `TcpTransport`'s business.
   *
   * `incarnation` is optional and validated only when present: a peer running a
   * version that predates the field sends none, and refusing its addresses
   * would turn an added field into a mixed-version partition (#940).
   */
  static fromJSON(data: NodeAddressData): NodeAddress {
    const { systemName, host, port, incarnation } = data ?? {};
    if (typeof systemName !== 'string' || systemName.length === 0
      || typeof host !== 'string' || host.length === 0
      || typeof port !== 'number' || !Number.isInteger(port) || port <= 0
      || (incarnation !== undefined && !NodeAddress.isIncarnation(incarnation))) {
      throw new Error(
        `Invalid node address: expected { systemName: string, host: string, port: positive integer, `
        + `incarnation?: string of 1..${MAX_NODE_INCARNATION_LENGTH} chars }, `
        + `got ${JSON.stringify(data)}`,
      );
    }
    return new NodeAddress(systemName, host, port, incarnation);
  }

  /**
   * Parse a string of the form `system@host:port`.
   *
   * Yields no incarnation, and cannot: the string form is what a seed list, a
   * `SeedProvider` and an operator's config carry, and none of them knows which
   * process is currently answering at that address.
   */
  static parse(s: string): NodeAddress {
    const at = s.indexOf('@');
    const colon = s.lastIndexOf(':');
    if (at < 0 || colon <= at) throw new Error(`Invalid node address: ${s}`);
    const systemName = s.slice(0, at);
    const host = s.slice(at + 1, colon);
    const port = parseInt(s.slice(colon + 1), 10);
    if (!Number.isFinite(port)) throw new Error(`Invalid port in node address: ${s}`);
    return new NodeAddress(systemName, host, port);
  }
}

export type NodeAddressData = {
  readonly systemName: string;
  readonly host: string;
  readonly port: number;
  /**
   * Which process at this address, when the sender knows (#940).
   *
   * Optional so that a peer predating the field is still understood and a peer
   * predating it still understands us — see {@link NodeAddress.incarnation} for
   * why that same optionality is exactly what stops a merge rule from being
   * keyed on it yet.
   */
  readonly incarnation?: string;
};
