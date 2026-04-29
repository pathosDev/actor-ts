import type { EventAdapter, OutboundFrame, SnapshotAdapter, StoredFrame } from './Adapter.js';
import type { Codec } from './Codec.js';
import { MigrationError } from './Envelope.js';

/**
 * In-process schema registry (#6).  Stores `(manifest, version) →
 * { codec, upcast? }` triples plus an optional compatibility check
 * that fires at register time.  Builds an `EventAdapter` /
 * `SnapshotAdapter` on demand that:
 *
 *   - **Writes** at the latest registered version using that
 *     version's codec — so encode-time validation catches bad
 *     domain values before they hit the journal.
 *   - **Reads** by looking up the stored version, decoding with
 *     that version's codec, then chaining the registered upcasters
 *     forward to the latest version.
 *
 * Confluent-style HTTP schema registries (subject-versioned with
 * remote compat checks) are out-of-scope for v1.  The interface
 * below is wide enough that a user can swap in their own
 * implementation and the rest of the migration machinery continues
 * to work.
 *
 *   const registry = new InMemorySchemaRegistry();
 *
 *   registry.register('BankAccount.Deposited', 1, {
 *     codec: zodCodec(DepositedV1),
 *   });
 *
 *   registry.register('BankAccount.Deposited', 2, {
 *     codec: zodCodec(DepositedV2),
 *     upcastFromPrev: (v1: DepositedV1): DepositedV2 => ({ ...v1, currency: 'USD' }),
 *     compatibility: 'backward',
 *   });
 *
 *   class Account extends PersistentActor<...> {
 *     eventAdapter() {
 *       return registry.eventAdapter<DepositedV2>('BankAccount.Deposited');
 *     }
 *   }
 *
 * **Compatibility modes.**
 *
 *   - `'none'` (default) — no check.  Use when you've already
 *     verified compat externally or for v1 of a manifest where
 *     there's no previous version yet.
 *   - `'backward'` — at register time, verify the registry holds an
 *     `upcastFromPrev` from the version you just registered's
 *     immediate predecessor.  This is the structural minimum that
 *     guarantees the read path still works for old data.
 *   - `'sample'` — same as `'backward'` plus a round-trip on a
 *     user-supplied sample value: the sample is decoded by the
 *     previous codec, upcast, and re-encoded by the new codec; if
 *     the round-trip throws, the registration is rejected.  Catches
 *     latent upcaster bugs at register time rather than at
 *     deployment time.
 */

/** What a single registered version contributes to the registry. */
export interface SchemaRegistration<Wire = unknown, Upcasted = unknown> {
  /** Codec used to validate / shape payloads at this version. */
  readonly codec: Codec<Wire>;
  /**
   * Pure function `prevVersionDomain → thisVersionDomain` used on
   * the read path to bring data forward.  Required for any version
   * > 1 if reads from older data are expected to succeed.
   */
  readonly upcastFromPrev?: (prev: unknown) => Upcasted;
  /** Compatibility-check mode applied at register time.  Default `'none'`. */
  readonly compatibility?: 'none' | 'backward' | 'sample';
  /**
   * Optional sample value used by `'sample'` compat checks — passed
   * through the previous version's encode → decode → upcast → this
   * version's encode round-trip.  Throws if any step fails.
   */
  readonly sample?: unknown;
}

export interface SchemaDescriptor extends SchemaRegistration {
  readonly manifest: string;
  readonly version: number;
}

/** Public API of any schema registry impl. */
export interface SchemaRegistry {
  /**
   * Add or replace the registration for `(manifest, version)`.
   * Runs the configured compat check; throws on incompatibility.
   * Re-registering the same `(manifest, version)` overwrites — the
   * registry doesn't enforce immutability, that's an operator
   * concern.
   */
  register<Wire = unknown, Upcasted = unknown>(
    manifest: string, version: number,
    registration: SchemaRegistration<Wire, Upcasted>,
  ): void;

  /** Look up the registration for `(manifest, version)`, if any. */
  get(manifest: string, version: number): SchemaDescriptor | undefined;

  /** Highest registered version for `manifest`, or `undefined` if unknown. */
  latestVersion(manifest: string): number | undefined;

  /** Snapshot of every registration — primarily for debugging / introspection. */
  list(): ReadonlyArray<SchemaDescriptor>;

  /**
   * Build an `EventAdapter` that writes at the latest registered
   * version of `manifest` and reads any registered version by
   * chaining upcasters forward.
   */
  eventAdapter<E>(manifest: string): EventAdapter<E, unknown>;

  /** Same as `eventAdapter` but typed for snapshot/state actors. */
  snapshotAdapter<S>(manifest: string): SnapshotAdapter<S, unknown>;
}

/* ============================== impl ================================== */

/** In-memory `SchemaRegistry` impl.  All state lives in one process. */
export class InMemorySchemaRegistry implements SchemaRegistry {
  private readonly entries = new Map<string, Map<number, SchemaDescriptor>>();

  register<Wire = unknown, Upcasted = unknown>(
    manifest: string, version: number,
    registration: SchemaRegistration<Wire, Upcasted>,
  ): void {
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`SchemaRegistry.register: version must be a positive integer, got ${version}`);
    }
    const compat = registration.compatibility ?? 'none';
    if (compat !== 'none') {
      const prev = this.get(manifest, version - 1);
      if (!prev) {
        throw new Error(
          `SchemaRegistry.register: compatibility '${compat}' requested for ${manifest}@v${version}, `
          + `but v${version - 1} is not registered`,
        );
      }
      if (!registration.upcastFromPrev) {
        throw new Error(
          `SchemaRegistry.register: ${manifest}@v${version} compatibility=${compat} requires upcastFromPrev`,
        );
      }
      if (compat === 'sample') {
        if (registration.sample === undefined) {
          throw new Error(
            `SchemaRegistry.register: ${manifest}@v${version} compatibility='sample' requires a sample value`,
          );
        }
        try {
          const wirePrev = prev.codec.encode(registration.sample);
          const decodedPrev = prev.codec.decode(wirePrev);
          const upcasted = registration.upcastFromPrev(decodedPrev);
          // Re-encode through the new codec — if the upcasted value
          // doesn't match the new schema, the register fails loud.
          registration.codec.encode(upcasted as unknown as Wire);
        } catch (err) {
          throw new Error(
            `SchemaRegistry.register: ${manifest}@v${version} sample-compat check failed: `
            + (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    }

    const descriptor: SchemaDescriptor = {
      manifest, version,
      codec: registration.codec as Codec<unknown>,
      upcastFromPrev: registration.upcastFromPrev as ((prev: unknown) => unknown) | undefined,
      compatibility: compat,
      sample: registration.sample,
    };
    let bucket = this.entries.get(manifest);
    if (!bucket) { bucket = new Map(); this.entries.set(manifest, bucket); }
    bucket.set(version, descriptor);
  }

  get(manifest: string, version: number): SchemaDescriptor | undefined {
    return this.entries.get(manifest)?.get(version);
  }

  latestVersion(manifest: string): number | undefined {
    const bucket = this.entries.get(manifest);
    if (!bucket || bucket.size === 0) return undefined;
    let latest = -Infinity;
    for (const v of bucket.keys()) if (v > latest) latest = v;
    return latest === -Infinity ? undefined : latest;
  }

  list(): ReadonlyArray<SchemaDescriptor> {
    const out: SchemaDescriptor[] = [];
    for (const bucket of this.entries.values()) {
      for (const d of bucket.values()) out.push(d);
    }
    return out;
  }

  eventAdapter<E>(manifest: string): EventAdapter<E, unknown> {
    const adapter: EventAdapter<E, unknown> = {
      manifest: () => manifest,
      toJournal: (event: E): OutboundFrame<unknown> => {
        const latest = this.latestVersion(manifest);
        if (latest === undefined) {
          throw new MigrationError(
            `SchemaRegistry: no schema registered for '${manifest}' on the write path`,
            manifest,
          );
        }
        const desc = this.get(manifest, latest)!;
        const validated = desc.codec.encode(event as unknown);
        return { manifest, version: latest, payload: validated };
      },
      fromJournal: (stored: StoredFrame): E => {
        const startDesc = this.get(stored.manifest, stored.version);
        if (!startDesc) {
          throw new MigrationError(
            `SchemaRegistry: no schema registered for '${stored.manifest}'@v${stored.version} on the read path`,
            stored.manifest, stored.version,
          );
        }
        let value: unknown = startDesc.codec.decode(stored.payload);
        const latest = this.latestVersion(stored.manifest)!;
        for (let v = stored.version + 1; v <= latest; v++) {
          const desc = this.get(stored.manifest, v);
          if (!desc) {
            throw new MigrationError(
              `SchemaRegistry: gap on the upcast path for '${stored.manifest}': v${v} not registered`,
              stored.manifest, stored.version,
            );
          }
          if (!desc.upcastFromPrev) {
            throw new MigrationError(
              `SchemaRegistry: ${stored.manifest}@v${v} has no upcastFromPrev — cannot bring v${stored.version} forward`,
              stored.manifest, stored.version,
            );
          }
          value = desc.upcastFromPrev(value);
        }
        return value as E;
      },
    };
    return adapter;
  }

  snapshotAdapter<S>(manifest: string): SnapshotAdapter<S, unknown> {
    // Same shape as eventAdapter — keep one implementation, two types.
    return this.eventAdapter<S>(manifest) as unknown as SnapshotAdapter<S, unknown>;
  }
}
