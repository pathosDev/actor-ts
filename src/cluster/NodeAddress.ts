/**
 * A node in the cluster is identified by host + port + system name.
 * Stringified as `system@host:port`.
 */
export class NodeAddress {
  constructor(
    public readonly systemName: string,
    public readonly host: string,
    public readonly port: number,
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

  toJSON(): NodeAddressData {
    return { systemName: this.systemName, host: this.host, port: this.port };
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
   */
  static fromJSON(data: NodeAddressData): NodeAddress {
    const { systemName, host, port } = data ?? {};
    if (typeof systemName !== 'string' || systemName.length === 0
      || typeof host !== 'string' || host.length === 0
      || typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
      throw new Error(
        `Invalid node address: expected { systemName: string, host: string, port: positive integer }, `
        + `got ${JSON.stringify(data)}`,
      );
    }
    return new NodeAddress(systemName, host, port);
  }

  /** Parse a string of the form `system@host:port`. */
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
};
