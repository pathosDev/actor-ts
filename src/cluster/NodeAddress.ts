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

  static fromJSON(data: NodeAddressData): NodeAddress {
    return new NodeAddress(data.systemName, data.host, data.port);
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

export interface NodeAddressData {
  readonly systemName: string;
  readonly host: string;
  readonly port: number;
}
