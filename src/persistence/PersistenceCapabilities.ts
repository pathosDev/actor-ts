import type { PersistenceOptions } from './PersistenceOptions.js';
import type { StorageUseKind } from './StorageLocality.js';

/**
 * Which fields of {@link PersistenceOptions} a store actually acts on.
 *
 * The three per-actor hooks (`compression()`, `encryption()`, `integrity()`)
 * are folded into a `PersistenceOptions` and handed to the snapshot or
 * durable-state store on every read and every write — never to the journal,
 * whose contract takes no options (#1430) — but only the object-storage pair
 * has ever read them.
 * Every other shipped store binds the parameter and drops it, and the
 * contracts used to *sanction* that — "stores that cannot honour them
 * silently ignore the field", a clause written for `compression`, where
 * dropping the request costs disk, and then applied unchanged to
 * `encryption` and `integrity`, where it costs confidentiality and tamper
 * detection (#960).
 *
 * A declaration turns that from a documentation question into a
 * machine-readable one: the caller asked for a control, and the store can
 * now say whether the control exists.  What the framework does with the
 * answer is split by what the field *is* — see
 * {@link PERSISTENCE_SECURITY_CONTROL_FIELDS}.
 *
 * The contracts carry this as an **optional** member, in the same
 * absence-is-meaningful family as `storageLocality`: a store that does not
 * declare its support is *unknown*, and unknown never throws.  Every
 * in-tree store declares explicitly, so the shipped surface is fully
 * covered; a third-party store that genuinely encrypts would otherwise
 * start throwing on upgrade for having declared nothing — the same rule
 * `StorageLocality` states as "a third-party store must never be misjudged
 * by a default it did not choose".
 */
export type PersistenceOptionSupport = {
  readonly encryption: boolean;
  readonly compression: boolean;
  readonly integrity: boolean;
};

/** The fields of {@link PersistenceOptions} a store declares support for. */
export type PersistenceOptionField = 'encryption' | 'compression' | 'integrity';

/**
 * The two fields whose absence is a security failure rather than a missed
 * optimisation, and which therefore refuse the actor outright.
 *
 * `encryption` and `integrity` are controls: a caller that sets them has
 * decided the data at rest must be unreadable, or must be detectably
 * unaltered.  Writing plaintext instead is not a degraded version of that —
 * it is the opposite of it, delivered silently, and pre-1.0 a hard cut is
 * sanctioned where the alternative is a control that only appears to hold.
 *
 * `compression` is deliberately NOT in this set.  It is a performance hint,
 * so killing an actor over it would be hostile and would make any
 * system-wide compression default unusable the moment one store in the
 * deployment cannot compress; it warns once instead (#960).
 */
export const PERSISTENCE_SECURITY_CONTROL_FIELDS: ReadonlySet<PersistenceOptionField> =
  new Set<PersistenceOptionField>(['encryption', 'integrity']);

/**
 * Refusal raised when an actor asks for a persistence control the store it is
 * wired to does not implement.  A class of its own, exported, for the same
 * reason `StorageLocalityError` and `SnapshotIntegrityError` are: callers
 * discriminate on the class, and `error.name === '…'` breaks on rewording.
 */
export class UnsupportedPersistenceOptionError extends Error {
  constructor(
    public readonly storeName: string,
    public readonly field: PersistenceOptionField,
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedPersistenceOptionError';
  }
}

/**
 * Which requested fields of `options` the store will not act on.
 *
 * Two silences are deliberate:
 *
 *   - **An undeclared store** (`support === undefined`) reports nothing.
 *     Unknown is not evidence — see {@link PersistenceOptionSupport}.
 *   - **A directive that asks for nothing** — `{ mode: 'none' }`,
 *     `{ algorithm: 'none' }` — is honoured by every store trivially, since
 *     "do not encrypt" is exactly what a store that cannot encrypt does.
 *     Refusing those would turn an explicit opt-*out* into a startup
 *     failure, which is the one shape of this check nobody would expect.
 */
export function unhonouredPersistenceOptions(
  options: PersistenceOptions | undefined,
  support: PersistenceOptionSupport | undefined,
): readonly PersistenceOptionField[] {
  if (options === undefined || support === undefined) return [];
  const unhonoured: PersistenceOptionField[] = [];
  if (!support.encryption && options.encryption !== undefined && options.encryption.mode !== 'none') {
    unhonoured.push('encryption');
  }
  if (!support.integrity && options.integrity !== undefined && options.integrity.mode !== 'none') {
    unhonoured.push('integrity');
  }
  if (!support.compression && options.compression !== undefined && options.compression.algorithm !== 'none') {
    unhonoured.push('compression');
  }
  return unhonoured;
}

/**
 * The refusal's text.  Carries the stable needle `does not implement` plus
 * the field name, the same filterable-message contract the node-local
 * storage advisory serves for operators and tests.
 *
 * A snapshot-store refusal also says what its own advice does not buy
 * (#1430).  Switching to the object-storage snapshot store protects the
 * snapshots and nothing else: the journal is never asked — its contract
 * takes no `PersistenceOptions` at all — so an actor that follows the advice
 * starts cleanly and appends its events in the clear, unsigned.  Left
 * unsaid, the one message an operator reads about these hooks would steer
 * them into exactly that configuration.  A durable-state store has no
 * journal behind it, which is why that refusal does not carry the clause.
 */
export function unsupportedPersistenceOptionMessage(
  kind: StorageUseKind,
  storeName: string,
  field: PersistenceOptionField,
): string {
  const refusal = `persistence: this actor sets ${field}(), but the ${kind} '${storeName}' does not implement `
    + `${field} — it accepts PersistenceOptions and never reads them, so the write would be stored `
    + `unprotected and the read would hand back unverified data, with nothing reporting either (#960). `
    + 'Use the object-storage snapshot or durable-state store, which honours all three hooks on both '
    + `the write and the read path, or drop the ${field}() override. Declaring `
    + `{ mode: 'none' } is accepted by every store and is the way to say "deliberately unprotected".`;
  if (kind !== 'snapshot-store') return refusal;
  return `${refusal} Switching stores protects the snapshots and nothing else (#1430). `
    + 'encryption() and integrity() on a PersistentActor protect its snapshots only: every journal '
    + 'stores events as plaintext JSON, nothing detects an event edited in place, and database-side '
    + 'controls — transparent data encryption, an encrypted volume, access control — are the only '
    + 'protection for events today.';
}

/**
 * The compression warning's text — same needle discipline, but it names the
 * consequence as cost rather than exposure, because that is what it is.
 */
export function unhonouredCompressionMessage(kind: StorageUseKind, storeName: string): string {
  return `persistence: this actor sets compression(), but the ${kind} '${storeName}' does not implement `
    + 'compression — the directive is accepted and dropped, so bodies are stored uncompressed (#960). '
    + 'This is a performance hint and not a correctness problem, which is why it warns rather than '
    + 'failing the actor; the object-storage stores are the ones that compress.';
}
