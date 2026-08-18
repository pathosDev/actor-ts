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
 *   - **Reads** its own manifest only — a stored frame tagged with
 *     any other manifest is refused with a `MigrationError` rather
 *     than decoded into the wrong type — then looks up the stored
 *     version, decodes with that version's codec and chains the
 *     registered upcasters forward to the latest version.
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

/**
 * What a single registered version contributes to the registry.
 *
 * `Previous` is the previous version's domain type, inferred from the
 * `upcastFromPrev` you pass.  It exists because the parameter used to be
 * hard-typed `unknown`, which made the form this file documents —
 * `(v1: DepositedV1): DepositedV2 => …` — fail to compile: a function
 * taking `DepositedV1` is not assignable to one taking `unknown`.  The
 * registry does not verify the claim (it hands over whatever the previous
 * codec decoded, and stores the upcaster erased to `unknown`), exactly as
 * `Codec<Wire>` does not verify `Wire`.  Writing `(prev: unknown) => …`
 * still works and leaves `Previous` at its default.
 */
export type SchemaRegistration<Wire = unknown, Upcasted = unknown, Previous = unknown> = {
  /** Codec used to validate / shape payloads at this version. */
  readonly codec: Codec<Wire>;
  /**
   * Pure function `prevVersionDomain → thisVersionDomain` used on
   * the read path to bring data forward.  Required for any version
   * > 1 if reads from older data are expected to succeed.
   */
  readonly upcastFromPrev?: (prev: Previous) => Upcasted;
  /** Compatibility-check mode applied at register time.  Default `'none'`. */
  readonly compatibility?: 'none' | 'backward' | 'sample';
  /**
   * Optional sample value used by `'sample'` compat checks — passed
   * through the previous version's encode → decode → upcast → this
   * version's encode round-trip.  Throws if any step fails.
   */
  readonly sample?: unknown;
};

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
  register<Wire = unknown, Upcasted = unknown, Previous = unknown>(
    manifest: string, version: number,
    registration: SchemaRegistration<Wire, Upcasted, Previous>,
  ): void;

  /** Look up the registration for `(manifest, version)`, if any. */
  get(manifest: string, version: number): SchemaDescriptor | undefined;

  /** Highest registered version for `manifest`, or `undefined` if unknown. */
  latestVersion(manifest: string): number | undefined;

  /** Snapshot of every registration — primarily for debugging / introspection. */
  list(): ReadonlyArray<SchemaDescriptor>;

  /**
   * Build an `EventAdapter` that writes at the latest registered
   * version of `manifest` and reads any registered version of *that
   * same* manifest by chaining upcasters forward.  A stored frame
   * carrying a different manifest raises a `MigrationError`: the
   * adapter is bound to one manifest on both paths, so an actor whose
   * event union spans manifests needs a hand-written `fromJournal`
   * that switches on `stored.manifest` (#737).
   *
   * `JournalShape` follows `EventAdapter`'s own convention and defaults
   * to the domain type — pass it only when the latest codec encodes to
   * something else.  It used to be hard-typed `unknown`, which meant the
   * result could not be returned from `PersistentActor.eventAdapter()`
   * (declared `EventAdapter<Event>`): the form this file's header, the
   * `examples/persistence/schema-registry.ts` sample and both schema
   * registry documentation pages all show did not compile (#540).
   */
  eventAdapter<E, JournalShape = E>(manifest: string): EventAdapter<E, JournalShape>;

  /** Same as `eventAdapter` but typed for snapshot/state actors. */
  snapshotAdapter<S, StoredShape = S>(manifest: string): SnapshotAdapter<S, StoredShape>;
}

/* ============================== impl ================================== */

/** In-memory `SchemaRegistry` impl.  All state lives in one process. */
export class InMemorySchemaRegistry implements SchemaRegistry {
  private readonly entries = new Map<string, Map<number, SchemaDescriptor>>();

  register<Wire = unknown, Upcasted = unknown, Previous = unknown>(
    manifest: string, version: number,
    registration: SchemaRegistration<Wire, Upcasted, Previous>,
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
          // The one place the `Previous` claim is taken on trust: what the
          // previous codec decoded is `unknown` here, and the sample check
          // exists precisely to find out at register time whether feeding
          // it to this upcaster works.
          const upcast = registration.upcastFromPrev as (prev: unknown) => Upcasted;
          const upcasted = upcast(decodedPrev);
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
    for (const version of bucket.keys()) if (version > latest) latest = version;
    return latest === -Infinity ? undefined : latest;
  }

  list(): ReadonlyArray<SchemaDescriptor> {
    const out: SchemaDescriptor[] = [];
    for (const bucket of this.entries.values()) {
      for (const descriptor of bucket.values()) out.push(descriptor);
    }
    return out;
  }

  eventAdapter<E, JournalShape = E>(manifest: string): EventAdapter<E, JournalShape> {
    const adapter: EventAdapter<E, JournalShape> = {
      manifest: () => manifest,
      toJournal: (event: E): OutboundFrame<JournalShape> => {
        const latest = this.latestVersion(manifest);
        if (latest === undefined) {
          throw new MigrationError(
            `SchemaRegistry: no schema registered for '${manifest}' on the write path`,
            manifest,
          );
        }
        const desc = this.get(manifest, latest)!;
        // The descriptor map is heterogeneous — keyed by manifest and
        // version, not by type — so the latest codec's wire type is not
        // recoverable here.  `JournalShape` is the caller's claim about
        // it, in the same way `Codec<Wire>` is a claim about the codec.
        const validated = desc.codec.encode(event as unknown) as JournalShape;
        return { manifest, version: latest, payload: validated };
      },
      fromJournal: (stored: StoredFrame): E => {
        // Bound to one manifest on the read path too, not just on the write
        // path: everything below resolves from `stored.manifest`, so without
        // this compare a row tagged with another manifest registered in the
        // same registry decodes cleanly and returns as `E` — type confusion
        // the caller cannot detect, since the payload is valid and the static
        // type claims it got what it asked for.  Throwing (rather than
        // dead-lettering) is what `MigrationChain.upcast` and `defaultsAdapter`
        // already do, and is the only option on the recovery path anyway:
        // `Replay` has no per-event error channel, so this surfaces through
        // `onRecoveryFailure` like a `JournalIntegrityError` — the entity's
        // state is not reconstructible from what is on disk.  The message
        // avoids naming `eventAdapter` because `snapshotAdapter` delegates
        // here (#737).
        if (stored.manifest !== manifest) {
          throw new MigrationError(
            `manifest mismatch: schema-registry adapter is for '${manifest}', got '${stored.manifest}'`,
            stored.manifest, stored.version,
          );
        }
        const startDesc = this.get(stored.manifest, stored.version);
        if (!startDesc) {
          throw new MigrationError(
            `SchemaRegistry: no schema registered for '${stored.manifest}'@v${stored.version} on the read path`,
            stored.manifest, stored.version,
          );
        }
        let value: unknown = startDesc.codec.decode(stored.payload);
        const latest = this.latestVersion(stored.manifest)!;
        for (let version = stored.version + 1; version <= latest; version++) {
          const desc = this.get(stored.manifest, version);
          if (!desc) {
            throw new MigrationError(
              `SchemaRegistry: gap on the upcast path for '${stored.manifest}': v${version} not registered`,
              stored.manifest, stored.version,
            );
          }
          if (!desc.upcastFromPrev) {
            throw new MigrationError(
              `SchemaRegistry: ${stored.manifest}@v${version} has no upcastFromPrev — cannot bring v${stored.version} forward`,
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

  snapshotAdapter<S, StoredShape = S>(manifest: string): SnapshotAdapter<S, StoredShape> {
    // Same shape as eventAdapter — keep one implementation, two types.
    return this.eventAdapter<S, StoredShape>(manifest) as unknown as SnapshotAdapter<S, StoredShape>;
  }
}
