import type { EventAdapter, OutboundFrame, SnapshotAdapter, StoredFrame } from './Adapter.js';
import type { Codec } from './Codec.js';
import { MigrationError } from './Envelope.js';

/**
 * Wrap an existing `EventAdapter` / `SnapshotAdapter` with a
 * {@link Codec} that validates the payload on every write and
 * read (#6).  The codec runs **after** the inner adapter on the
 * write path (so versioned wire shapes — produced by `defaultsAdapter`,
 * `migratingAdapter`, etc — are validated against the wire schema)
 * and **before** the inner adapter on the read path (so corrupted /
 * mistyped wire data fails before any upcaster runs).
 *
 *   const adapter = validatedEventAdapter(
 *     defaultsAdapter<DepositedV2>({
 *       manifest: 'BankAccount.Deposited',
 *       currentVersion: 2,
 *       defaults: { 1: { currency: 'USD' } },
 *     }),
 *     zodCodec(DepositedV2WireSchema),
 *   );
 *
 * Errors thrown by the codec on encode become `PersistError`s in
 * the actor's outbox; on decode they bubble up as `MigrationError`s
 * with the manifest + version of the offending record so log
 * output points at the exact failure.
 */

/** Shape of error reasons surfaced from this wrapper. */
export interface ValidatedAdapterOptions {
  /**
   * Override how the wire payload is shown in the validation
   * error.  Defaults to `JSON.stringify(payload).slice(0, 200)` —
   * truncated so big payloads don't flood the error log.
   */
  readonly previewWire?: (wire: unknown) => string;
}

/**
 * Wrap an `EventAdapter` to run the codec on every read/write.
 * The inner adapter still owns version mapping (upcasters,
 * defaults, downcast for rolling deploys); the codec adds payload-
 * shape validation on top.
 */
export function validatedEventAdapter<E, J>(
  inner: EventAdapter<E, J>,
  codec: Codec<J>,
  opts: ValidatedAdapterOptions = {},
): EventAdapter<E, J> {
  return {
    manifest: (event: E) => inner.manifest(event),
    toJournal: (event: E): OutboundFrame<J> => {
      const out = inner.toJournal(event);
      const validated = runEncode(codec, out.payload, out.manifest, out.version, opts);
      return { manifest: out.manifest, version: out.version, payload: validated };
    },
    fromJournal: (stored: StoredFrame): E => {
      const validated = runDecode(codec, stored, opts);
      return inner.fromJournal({
        manifest: stored.manifest,
        version: stored.version,
        payload: validated,
      });
    },
  };
}

/**
 * Snapshot variant of {@link validatedEventAdapter}.  Same shape;
 * `SnapshotAdapter` differs from `EventAdapter` only in name (for
 * call-site clarity).
 */
export function validatedSnapshotAdapter<S, J>(
  inner: SnapshotAdapter<S, J>,
  codec: Codec<J>,
  opts: ValidatedAdapterOptions = {},
): SnapshotAdapter<S, J> {
  return {
    manifest: (state: S) => inner.manifest(state),
    toJournal: (state: S): OutboundFrame<J> => {
      const out = inner.toJournal(state);
      const validated = runEncode(codec, out.payload, out.manifest, out.version, opts);
      return { manifest: out.manifest, version: out.version, payload: validated };
    },
    fromJournal: (stored: StoredFrame): S => {
      const validated = runDecode(codec, stored, opts);
      return inner.fromJournal({
        manifest: stored.manifest,
        version: stored.version,
        payload: validated,
      });
    },
  };
}

/* ----------------------------- internals ------------------------------ */

function runEncode<J>(
  codec: Codec<J>, payload: J, manifest: string, version: number,
  opts: ValidatedAdapterOptions,
): J {
  try {
    return codec.encode(payload) as J;
  } catch (err) {
    throw new MigrationError(
      `validatedAdapter: codec '${codec.name ?? 'anonymous'}' rejected encode for `
      + `${manifest}@v${version}: ${(err as Error).message ?? String(err)} `
      + `[input=${preview(payload, opts)}]`,
      manifest, version,
    );
  }
}

function runDecode<J>(
  codec: Codec<J>, stored: StoredFrame, opts: ValidatedAdapterOptions,
): J {
  try {
    return codec.decode(stored.payload) as J;
  } catch (err) {
    throw new MigrationError(
      `validatedAdapter: codec '${codec.name ?? 'anonymous'}' rejected decode for `
      + `${stored.manifest}@v${stored.version}: ${(err as Error).message ?? String(err)} `
      + `[wire=${preview(stored.payload, opts)}]`,
      stored.manifest, stored.version,
    );
  }
}

function preview(wire: unknown, opts: ValidatedAdapterOptions): string {
  if (opts.previewWire) {
    try { return opts.previewWire(wire); } catch { /* fall through */ }
  }
  let serialized: string;
  try { serialized = JSON.stringify(wire); }
  catch { serialized = String(wire); }
  return serialized.length > 200 ? `${serialized.slice(0, 200)}…` : serialized;
}
