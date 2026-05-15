---
title: Rolling deployment migration
description: Deploy schema-breaking or master-key-rotating changes across a running actor-ts cluster without downtime or coordinated stops.
---

This guide describes how to deploy a schema-breaking or
master-key-rotating change across a running cluster **without
downtime** and **without coordinated stops**.  Every node continues
serving traffic while the new version rolls out instance-by-
instance.

The framework's rolling-deploy story is built on four shipped
features:

- **`writeVersion` on `migratingAdapter`** (#7) — readers handle
  every registered version; writers emit a chosen one.
- **`MasterKeyRing`** (#8) — `active` + `retired[]` keys; every
  encrypted body's manifest names the key version it used.
- **`wrapLegacy` helpers** (#9) — one-shot rewrite of pre-envelope
  events into the current schema envelope.
- **`SchemaRegistry`** (#6) — multi-version codec + compatibility
  checks.

The pattern below composes all four into a four-phase deploy.  It
applies identically to SQLite, Cassandra, in-memory, and
object-storage journals.

## TL;DR — the four-phase deploy

```
    PHASE 1            PHASE 2          PHASE 3            PHASE 4
    code-first         observation      writer flip        cleanup (optional)
    ───────────        ───────────      ───────────        ───────────────
v2 readers ──┐         all instances    v2 writers         old upcaster
v1 writers   │         running v2 code  enabled            dropped;
   coexist   │                                             optional one-shot
             └─────────── observe ──────────────►          backfill via
   chain.register(v1, v2)   verify v1 events still read    migrateInMemoryJournal
   writeVersion: 1          writers still emit v1          / migrateSnapshotStore
                                                           — keeps history
                                                             current-shape clean
```

Each instance in the cluster moves through these phases in
sequence; the cluster as a whole moves forward only when **every**
instance is at the same phase or later.

---

## Phase 1 — Code-first

Ship the new code with the new schema **registered** but still
write the old shape.

```ts
import {
  MigrationChain,
  migratingAdapter,
  PersistentActor,
} from 'actor-ts';

// 1. Define both versions in the chain.
const chain = MigrationChain
  .start<OrderEventV1>('OrderEvent', 1)
  .next<OrderEventV2>(2, (v1) => ({
    ...v1,
    currency: v1.currency ?? 'USD',  // upcast: default the new field
  }));

// 2. Pin the writeVersion at the OLD version for this phase.
const adapter = migratingAdapter(chain, { writeVersion: 1 });

class Order extends PersistentActor<OrderCmd, OrderEvent, OrderState> {
  override eventAdapter() { return adapter; }
  // ...
}
```

**Outcome after Phase 1:**

- Newly-deployed instances read **both** v1 and v2 events
  correctly (the chain upcasts v1 → v2 on read).
- All instances still **write** v1, because `writeVersion: 1`.
- Existing journal contents stay v1 — no historical rewrite.

**Why pin `writeVersion`?**  If a v1-only instance is still
running and reads a v2 event a v2 instance just wrote, the v1
reader has no upcaster to make sense of it — `MigrationChain.read`
throws `MigrationError`.  By holding writes at v1 until all
readers can handle v2, you avoid this split.

**Rollback at this stage is trivial** — the v2 code is just doing
v1's job; there's nothing new on disk to undo.

---

## Phase 2 — Observation

Roll the new code out to every instance.  No code or config
change between Phase 1 and Phase 2 — it's a deployment-completion
checkpoint, not a deployment step.

**What to verify:**

- All instances report the same build version (`/health`,
  cluster-management endpoints, or your own deploy-tracker).
- v1 events are being read by the new code path
  (`migration_chain_upcast_total{from="1",to="2"}` metric, or a
  log-line spot-check on `chain.read`).
- Writers are still emitting v1 (peek the journal — the most-
  recent record's manifest version should be `1`).

**Why wait?**  The instant any writer flips to v2, every reader
needs to be v2-capable.  If even one v1-only instance is still up,
its `MigrationChain` will lack the v2 step and `chain.read` will
throw `UnknownVersionError` on the first v2 event it sees.

**Don't skip this phase** even if your deploy pipeline is "fast" —
a 15-second pipeline can still leave a single instance behind
during a network blip, and Phase 3 makes that single instance
non-functional.

---

## Phase 3 — Writer flip

Redeploy (or hot-config-change) with `writeVersion: 2`.

```ts
// Drop the explicit writeVersion — it defaults to chain.currentVersion (2).
const adapter = migratingAdapter(chain);
```

**Outcome after Phase 3:**

- New writes use the v2 shape (`currency` set explicitly, etc.).
- v1 events on disk are still readable via the chain's upcaster.
- Mixed-version journal: oldest events are v1-shaped, newer events
  are v2-shaped — both round-trip through the same `applyEvent`
  thanks to the upcast on read.

**Rollback at this stage is non-trivial.**  Any v2 event written
since the flip cannot be read by a v1-only reader.  If you must
roll back, you have two paths:

1. **Forward-fix** — ship a v3 chain entry that handles v2.  This
   is just another rolling deploy on the same pattern.
2. **Restore from snapshot** — stop writes, restore the journal
   from the last pre-Phase-3 snapshot, redeploy v1 code.  Data
   written during the v2 window is lost.

The forward-fix is always preferable to the restore.

---

## Phase 4 — Cleanup (optional)

After Phase 3 has run long enough that no v1 events are likely to
be read on the hot path, you can:

1. **Backfill historical data into v2 shape**, so future reads
   skip the upcast.  Use the one-shot helpers:

    ```ts
    import { migrateInMemoryJournal, migrateSnapshotStore } from 'actor-ts';

    // Rewrite every event for every persistenceId into v2 shape.
    await migrateInMemoryJournal(journal, (event) => chain.manifestFor(event, 2));

    // Same for snapshots.
    await migrateSnapshotStore(snapshots, pids, (state) => chain.manifestFor(state, 2));
    ```

    For SQL / Cassandra journals where there's no in-place rewrite
    yet (tracked under #71 for bulk wrap-legacy), use `migrateBetween
    Journals(source, target, { eventTransform })` (v0.8.0) to read
    from the old backend and write a fresh, enveloped copy to the
    new one — same pattern as a backend swap, with the transform
    hook doing the wrap inline:

    ```ts
    await migrateBetweenJournals(oldJournal, newJournal, {
      eventTransform: (pe) => ({
        ...pe,
        event: wrapEventAsEnvelope(pe.event, chain.manifestFor),
      }),
    });
    ```

2. **Drop the v1 step** from the `MigrationChain` once the
   backfill is complete:

    ```ts
    const chain = MigrationChain.start<OrderEventV2>('OrderEvent', 2);
    ```

    All future events are now born v2 with no upcast overhead.

**Phase 4 is optional.**  Many production systems live indefinitely
with mixed-version journals and never run the backfill — the
upcast cost is typically nanoseconds per event.  Run Phase 4 only
when the historical-version step turns into operational drag
(extra code paths to maintain, mixed-version reads complicating
debugging, etc.).

---

## Master-key rotation — parallel story

Encryption keys rotate on the same four-phase shape, with one
extra acknowledgement: the **active** key is always one specific
entry; the **retired** array is what readers need to decrypt
historical bodies.

### Phase 1 — Code-first (key)

Ship the new key as `active`, keep the old as `retired`.

```ts
import { ObjectStoragePluginOptions, registerObjectStoragePlugins } from 'actor-ts';

const opts: ObjectStoragePluginOptions = {
  // ... backend, compression, etc.
  encryption: {
    keys: {
      active:  { version: 2, key: NEW_32_BYTES },
      retired: [{ version: 1, key: OLD_32_BYTES }],
    },
  },
};
```

After this phase, **new** bodies' manifests stamp `keyVersion = 2`;
**existing** bodies' manifests still say `keyVersion = 1` and
decrypt via the `retired[]` entry.

### Phase 2 — Observation (key)

Verify every instance has the new key ring.  A reader missing the
`retired` entry for v1 cannot decrypt the historical blobs.

### Phase 3 — Re-encryption sweep (optional)

Once you want to *physically remove* the old key from the system,
re-encrypt every historical body under the new key with the
`reEncryptObjectStorage` helper (v0.8.0):

```ts
import { reEncryptObjectStorage } from 'actor-ts';

const result = await reEncryptObjectStorage(backend, {
  keyPrefix: 'snapshots/',
  keyring: {
    active:  { version: 2, key: NEW },
    retired: [{ version: 1, key: OLD }],
  },
  onProgress: (e) => process.stderr.write(
    `${e.idx}/${e.total} ${e.action} ${e.key}\n`),
});
console.log(`rewrote ${result.rewrote} of ${result.scanned} objects`);
```

The sweep walks every object under `keyPrefix`, decrypts using
whichever retired/active version the body manifest references,
and re-encrypts under the active key.  Bodies already at the
active version are skipped on the fast path — the sweep is
idempotent and safe to re-run after a partial failure.
`If-Match` is used internally so a concurrent writer can't be
overwritten silently.

#### Durable resume tokens + completeness check

For million-object buckets the naive sweep above has two
weaknesses that bite hard in practice:

1. A crash partway through forces the resumed run to **re-list
   and re-GET every key from the start** — every body is still
   re-checked for "already at active version?", which costs one
   HEAD/GET per object even though no PUT happens.  For a
   24-hour sweep, that's a 24-hour wasted re-walk.
2. If the operator dropped a retired key from the config **too
   soon** (e.g. only kept the *most recent* retired entry but
   the corpus also references an older one), the sweep gets
   half-way through and then aborts on the first body that uses
   the missing version.  Half the corpus is now under the new
   key, half is still under the old.

Both are addressed by two opt-in options on
`reEncryptObjectStorage` (v0.10.0, #109):

```ts
import {
  reEncryptObjectStorage,
  InMemoryReEncryptProgressStore,
  type ReEncryptProgressStore,
} from 'actor-ts';

// File-backed progress store — survives a process crash.
// (The shipped `InMemoryReEncryptProgressStore` is the
//  in-process default for tests; for long-running production
//  sweeps you want a durable backing store.  Same shape, plug
//  any of: file on disk, single Redis key, or a sentinel
//  object in the same bucket under a different prefix.)
const progress: ReEncryptProgressStore = makeFileBackedStore('/var/lib/actor-ts/sweep.json');

const result = await reEncryptObjectStorage(backend, {
  keyPrefix: 'snapshots/',
  keyring: {
    active:  { version: 3, key: NEW },
    retired: [
      { version: 2, key: OLDER },
      { version: 1, key: OLDEST },
    ],
  },
  // — completeness check —
  // Default true.  Samples the first 100 encrypted bodies and
  // refuses to start if any body references a key version
  // that's absent from active/retired.  Catches the dropped-
  // retired-key footgun BEFORE the sweep writes a single PUT.
  verifyKeyringCompleteness: true,
  // sampleSize: 200,   // optional override; default = min(100, total)

  // — durable resume —
  // Save state every 500 rewrites.  After a crash, the next
  // call to reEncryptObjectStorage(backend, opts) picks up
  // exactly past the last saved key — no re-checking of
  // already-rewritten objects.
  progress,
  saveProgressEveryN: 500,

  onProgress: (e) => process.stderr.write(
    `${e.idx}/${e.total} ${e.action} ${e.key}\n`),
});

// On successful end-to-end completion, progress.clear() is
// called automatically — re-running the sweep starts fresh.
console.log(`rewrote ${result.rewrote} of ${result.scanned}`);
```

**What the progress store sees:**

- On first call: `load()` returns `{ lastKey: null, processedCount: 0 }`,
  the sweep runs from the start.
- Every `saveProgressEveryN`-th rewrite: `save({ lastKey, processedCount })`
  is called.  Pick the interval to trade IO overhead vs. crash-
  rewind window — `500` means a crash redoes at most ~500
  objects, which on a 10M-object bucket is a 0.005% rewind.
- After a clean end-of-sweep: `clear()` is called.  A fresh
  `reEncryptObjectStorage` invocation starts from the top.

**When to disable `verifyKeyringCompleteness`:**

The default is `true` and should stay that way for almost all
operators.  Set it to `false` only when:

- You've **independently verified** the keyring is complete
  (e.g. a separate audit job has already enumerated every body
  version and confirmed every one is in the ring).
- You're operating on a corpus where the sample-based check
  would itself be expensive (e.g. an extremely cold-storage
  backend where the first 100 reads cost real money), AND
  you've taken the independent-audit step above.

Disabling without independent verification trades a
deterministic pre-flight failure for a mid-corpus abort —
strictly worse from an operational-recovery standpoint.

### Phase 4 — Drop the old key

After the sweep, drop the `retired[1]` entry.  Manifests pointing
at `keyVersion = 1` would now fail to decrypt — but the sweep
guarantees none remain.

**Recommended pacing:** keep `retired[]` entries around for at
least one full backup cycle longer than the sweep takes.  A
corrupted sweep run that drops `retired[]` immediately is
unrecoverable.

---

## Reference — the symbols this guide uses

| Symbol                                    | What it does                              |
| ----------------------------------------- | ----------------------------------------- |
| `MigrationChain.start(name, v).next(...)` | Define a multi-version event/state chain  |
| `migratingAdapter(chain, { writeVersion })` | Adapter exposing the chain to the journal |
| `chain.manifestFor(value, version)`       | Lower-level envelope builder              |
| `wrapEventAsEnvelope(event, manifestFor)` | One-shot rewrite for pre-envelope data    |
| `migrateInMemoryJournal(journal, fn)`     | Bulk-rewrite every event under a journal  |
| `migrateSnapshotStore(store, pids, fn)`   | Same for snapshots                        |
| `MasterKeyRing` `{ active, retired? }`    | Multi-version encryption key ring         |
| `reEncryptObjectStorage(backend, opts)`   | Sweep: re-encrypt every body under a prefix to the active key |
| `ReEncryptProgressStore` / `InMemoryReEncryptProgressStore` | Durable resume tokens for the sweep (#109) — plug a file/Redis/object-storage backed implementation for million-object buckets |

All of them are exported from the top-level `actor-ts` barrel.

---

## Related

- [`docs/persistence/migration-recipes.md`](../persistence/migration-recipes.md)
  — decision tree for which adapter to pick.
- [`CHANGELOG.md`](../../CHANGELOG.md) `[0.6.0]` → "schema migration
  & encryption polish" for the underlying feature set.
- Open issues: [#71](https://github.com/pathosDev/actor-ts/issues/71)
  bulk wrap-legacy migration for SQL/Cassandra.
