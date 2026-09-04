import { NodeAddress } from './NodeAddress.js';
import {
  CONFIGURATION_FACT_NAME_PATTERN,
  isMemberStatus,
  MAX_CONFIGURATION_FACT_NAME_LENGTH,
  MAX_CONFIGURATION_FACT_VALUE_LENGTH,
  MAX_CONFIGURATION_FACTS,
  MAX_STORAGE_IDENTITY_LENGTH,
  MEMBER_STATUSES,
} from './Protocol.js';
import type {
  ConfigurationFactsData,
  MemberData,
  MemberStatus,
  StorageIdentitiesData,
} from './Protocol.js';

/**
 * Immutable description of a cluster member at a point in time.  Member
 * instances are replaced (not mutated) as their status evolves.  The
 * `version` counter is incremented on every status change and acts as a
 * logical clock for gossip merges.
 *
 * `removedAt` is set only on tombstone members (status === 'removed'),
 * via {@link withRemoved}.  It carries the wall-clock instant at which
 * the tombstone was created and gossips to peers so every node prunes
 * the tombstone at roughly the same wall-clock time — see
 * `Cluster.tombstonePruneTick` (#75).
 */
export class Member {
  readonly roles: ReadonlySet<string>;

  constructor(
    public readonly address: NodeAddress,
    public readonly status: MemberStatus,
    public readonly version: number,
    roles: Iterable<string> = [],
    public readonly removedAt?: number,
    /** Store identities this member claims for itself — see {@link StorageIdentitiesData} (#1358). */
    public readonly storageIdentities?: StorageIdentitiesData,
    /** Effective settings this member claims for itself — see {@link ConfigurationFactsData} (#844). */
    public readonly configurationFacts?: ConfigurationFactsData,
  ) {
    this.roles = new Set(roles);
  }

  hasRole(role: string): boolean { return this.roles.has(role); }

  isReachable(): boolean {
    return this.status === 'up'
      || this.status === 'weakly-up'
      || this.status === 'joining'
      || this.status === 'leaving';
  }

  toData(): MemberData {
    const data: MemberData = {
      address: this.address.toJSON(),
      status: this.status,
      version: this.version,
      roles: Array.from(this.roles),
    };
    // `removedAt` only ever set on tombstones — omit otherwise to
    // keep gossip bytes proportional to status, not member count.
    // `storageIdentities` and `configurationFacts` follow the same
    // omit-when-absent rule.
    const withTombstoneAge = this.removedAt !== undefined
      ? { ...data, removedAt: this.removedAt }
      : data;
    const withIdentities = this.storageIdentities !== undefined
      ? { ...withTombstoneAge, storageIdentities: this.storageIdentities }
      : withTombstoneAge;
    return this.configurationFacts !== undefined
      ? { ...withIdentities, configurationFacts: this.configurationFacts }
      : withIdentities;
  }

  /**
   * Rebuild a member from its gossiped form.
   *
   * `status` used to be copied through verbatim, which is how an arbitrary
   * string off the wire reached `Cluster.emitStatusTransition`'s
   * `match(...).exhaustive()` — thrown from a socket callback, and thrown
   * *after* the member had been written to the map, so the poisoned entry was
   * re-gossiped to every peer from the node that had just crashed on it
   * (#563).  The transport rejects such a frame before it gets here now; this
   * check is what makes the guarantee local to the type it protects.
   */
  static fromData(data: MemberData): Member {
    if (!isMemberStatus(data.status)) {
      throw new Error(
        `Invalid member status "${String(data.status)}" for ${JSON.stringify(data.address)} `
        + `— expected one of ${MEMBER_STATUSES.join(', ')}`,
      );
    }
    return new Member(
      NodeAddress.fromJSON(data.address),
      data.status,
      data.version,
      data.roles ?? [],
      data.removedAt,
      sanitizeStorageIdentities(data.storageIdentities),
      sanitizeConfigurationFacts(data.configurationFacts),
    );
  }

  withStatus(status: MemberStatus): Member {
    return new Member(
      this.address, status, this.version + 1, this.roles, this.removedAt,
      this.storageIdentities, this.configurationFacts,
    );
  }

  /**
   * The same member carrying identity claims — same `version` on purpose
   * (#1358).  The claims ride an overlay lane outside the merge clock: a
   * bump here would race the leader's status transitions to the same
   * `version + 1`, which has no tie-break (`Cluster.publishStorageIdentity`
   * tells that story).  Used by the receive side to fill claims into a
   * record it otherwise ignores.
   */
  withStorageIdentities(storageIdentities: StorageIdentitiesData): Member {
    return new Member(
      this.address, this.status, this.version, this.roles, this.removedAt, storageIdentities,
      this.configurationFacts,
    );
  }

  /**
   * The same member carrying configuration claims — same `version`, for the
   * reason {@link withStorageIdentities} spells out (#844).  Both fields ride
   * the one overlay lane, so this is the second reader of that rationale and
   * not a second policy: a version bump for either would race the leader's
   * `joining → up` promotion to the same `version + 1`, which `mergeMember`
   * has no tie-break for.
   */
  withConfigurationFacts(configurationFacts: ConfigurationFactsData): Member {
    return new Member(
      this.address, this.status, this.version, this.roles, this.removedAt,
      this.storageIdentities, configurationFacts,
    );
  }

  /**
   * Transition into the `removed` tombstone state with a fresh
   * `removedAt` timestamp.  Cluster paths that definitively remove a
   * peer (graceful leave, downing-provider force-down) call this
   * instead of `withStatus('removed')` so the tombstone carries an
   * age — required for `Cluster.tombstonePruneTick` to drop expired
   * tombstones cluster-wide (#75).
   */
  withRemoved(removedAt: number): Member {
    return new Member(
      this.address, 'removed', this.version + 1, this.roles, removedAt,
      this.storageIdentities, this.configurationFacts,
    );
  }

  toString(): string {
    const rolesSuffix = this.roles.size > 0 ? ` roles=[${Array.from(this.roles).join(',')}]` : '';
    return `Member(${this.address}, ${this.status}, v${this.version}${rolesSuffix})`;
  }
}

/**
 * Cap and type-check the member-supplied identity strings before they enter
 * the member map — the same wire posture `fromData`'s status check carries
 * (#563): a value off the wire is a claim, not a fact.  A bad field is
 * dropped rather than failing the record, because the field is advisory and
 * the member is not — refusing the record would let one malformed claim
 * suppress a peer's whole membership.
 */
function sanitizeStorageIdentities(data: unknown): StorageIdentitiesData | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const sanitized: { journal?: string; snapshotStore?: string; durableStateStore?: string } = {};
  for (const field of ['journal', 'snapshotStore', 'durableStateStore'] as const) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0 && value.length <= MAX_STORAGE_IDENTITY_LENGTH) {
      sanitized[field] = value;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

/**
 * The same posture one field over, with one difference that matters: the
 * *keys* are member-supplied too (#844).
 *
 * `sanitizeStorageIdentities` iterates three field names this file wrote down,
 * so nothing a peer sends can decide what gets assigned.  Here the peer names
 * the properties, which puts `__proto__` and every member of
 * `Object.prototype` in reach of the write and of the read.
 *
 * **The operative guard is the name pattern.**
 * {@link CONFIGURATION_FACT_NAME_PATTERN} has no underscore in its character
 * set, so `__proto__` is dropped before anything is written — which is what
 * the test binds, and what would have to be removed for this to break.
 *
 * `Object.defineProperty` rather than `sanitized[name] = value` is
 * belt-and-braces, and worth stating precisely rather than overclaiming: with
 * values constrained to strings the assignment is *already* safe, because the
 * `__proto__` setter ignores a non-object value.  The write form is what keeps
 * that true if the value type is ever widened — a facts record holding numbers
 * or nested objects would make plain assignment a live prototype-pollution
 * bug, and the widening is exactly the kind of change nobody would think to
 * re-derive this from.
 *
 * Reads go through `Object.hasOwn`, and that one is not belt-and-braces:
 * `claims['constructor']` on a plain object answers with a function rather
 * than `undefined`, and `constructor` is perfectly spellable under the
 * pattern — so an unguarded read reports a permanent false divergence against
 * every peer that does not publish that name.
 *
 * A bad entry is dropped rather than failing the record, and the count cap
 * keeps the *first* {@link MAX_CONFIGURATION_FACTS} rather than refusing the
 * whole claim: the field is advisory and the member is not, so one malformed
 * or oversized claim must not suppress a peer's membership.
 */
function sanitizeConfigurationFacts(data: unknown): ConfigurationFactsData | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const sanitized: Record<string, string> = {};
  let kept = 0;
  for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
    if (kept >= MAX_CONFIGURATION_FACTS) break;
    if (name.length > MAX_CONFIGURATION_FACT_NAME_LENGTH) continue;
    if (!CONFIGURATION_FACT_NAME_PATTERN.test(name)) continue;
    if (typeof value !== 'string') continue;
    if (value.length === 0 || value.length > MAX_CONFIGURATION_FACT_VALUE_LENGTH) continue;
    Object.defineProperty(sanitized, name, {
      value, enumerable: true, writable: true, configurable: true,
    });
    kept++;
  }
  return kept > 0 ? sanitized : undefined;
}
