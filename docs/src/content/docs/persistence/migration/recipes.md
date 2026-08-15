---
title: Migration recipes
description: Decision tree for picking the right migration adapter — defaultsAdapter, migratingAdapter, InMemorySchemaRegistry, validatedEventAdapter, or wrapEventAsEnvelope.
---

The framework ships five migration tools that look superficially
similar:

- **`defaultsAdapter`** — fill in new fields on old payloads.
- **`migratingAdapter`** (over `MigrationChain`) — pure-function
  per-version upcasters, optional bidirectional with
  downcasters.
- **`InMemorySchemaRegistry`** — multi-version registry that
  enforces compatibility checks at registration time.
- **`validatedEventAdapter`** — wrap an adapter in a codec for
  per-write validation.
- **`wrapEventAsEnvelope`** + the bulk migrators — one-shot
  retrofit for journals predating the envelope shape.

This guide is the decision tree.  Most changes pick exactly one of
them — they compose, but not all combinations make sense.

---

## The flowchart

```
                          ┌──────────────────────────────┐
                          │  What's the change?          │
                          └──────────────┬───────────────┘
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              │                          │                          │
              ▼                          ▼                          ▼
        ┌──────────┐             ┌──────────────┐            ┌──────────────┐
        │ New      │             │ Rename /     │            │ Pre-envelope │
        │ field    │             │ restructure  │            │ journal?     │
        │ with     │             │ existing     │            └──────┬───────┘
        │ default? │             │ shape?       │                   │
        └────┬─────┘             └──────┬───────┘                   ▼
             │                          │                  wrapEventAsEnvelope
             ▼                          ▼                  + bulk migrators
        defaultsAdapter          migratingAdapter           (recipe 5)
        (recipe 1)               (recipe 2)
                                         │
                          ┌──────────────┼──────────────┐
                          │                             │
                          ▼                             ▼
                   ┌───────────────┐            ┌────────────────┐
                   │ Multi-service │            │ Need on-write  │
                   │ shared schema │            │ validation     │
                   │ (Kafka topic, │            │ (e.g. zod      │
                   │  shared bus)? │            │  schema)?      │
                   └──────┬────────┘            └──────┬─────────┘
                          ▼                            ▼
                   SchemaRegistry              validatedEventAdapter
                   (recipe 3)                  (recipe 4) — wraps
                                               any adapter above
```

---

## Recipe 1 — `defaultsAdapter`: additive evolution

**When:** Add a new field with a sensible default.  No
restructuring, no renames, no type changes.

**Why this one:** No upcaster code to write or test.  The
adapter inserts the default if the field is missing — that's it.

```ts
import { defaultsAdapter, PersistentActor } from 'actor-ts/persistence';

type DepositedV1 = { kind: 'deposited'; amount: number };
interface DepositedV2 extends DepositedV1 { currency: string }

class Account extends PersistentActor<Command, Deposited, State> {
  override eventAdapter() {
    return defaultsAdapter<DepositedV2>({
      manifest: 'BankAccount.Deposited',
      currentVersion: 2,
      defaults: { 1: { currency: 'USD' } },     // v1 lacked `currency`
    });
  }
  // ...
}
```

**Verifiable invariant:** A v1 payload read back arrives as a
v2-shaped event with `currency: 'USD'` already set.  No
`onEvent` change required.

**Out-of-scope for `defaultsAdapter`:** removing fields, renaming
fields, splitting one field into many, changing field types.  All
of those go to `migratingAdapter`.

Example: [`examples/persistence/event-migration.ts`](https://github.com/pathosDev/actor-ts/blob/main/examples/persistence/event-migration.ts).

---

## Recipe 2 — `migratingAdapter` over `MigrationChain`: anything non-additive

**When:** Rename a field, change its type, split one field into
two, merge two into one, restructure nested objects.  Anything
that can't be expressed as "fill in a default".

**Why this one:** Pure-function `(vN) => vN+1` upcasters compose
into a chain.  Each step is type-safe individually; the chain
type checks the start and end shapes match.

```ts
import { MigrationChain, migratingAdapter } from 'actor-ts/persistence';

type DepositedV1 = { kind: 'deposited'; amount: number };
type DepositedV2 = { kind: 'deposited'; amount: number; currency: string };
type DepositedV3 = { kind: 'deposited'; cents: number;  currency: string }; // float→int

const chain = MigrationChain
  .start<DepositedV1>('BankAccount.Deposited', 1)
  .next<DepositedV2>(2, (v1) => ({ ...v1, currency: 'USD' }))
  .next<DepositedV3>(3, (v2) => ({
    kind: v2.kind,
    cents: Math.round(v2.amount * 100),
    currency: v2.currency,
  }));

class Account extends PersistentActor<Command, DepositedV3, State> {
  override eventAdapter() { return migratingAdapter(chain); }
  // ...
}
```

**Rolling deploys:** pin `writeVersion` on `migratingAdapter` to
hold writes at the old shape while readers catch up — see
[Rolling deployment migration](/operations/upgrades/rolling-migration/)
for the full four-phase recipe.

**Verifiable invariant:** A vN payload read back arrives as a
`currentVersion`-shaped event.  Each upcaster runs exactly once
per missing version step; intermediate shapes never reach
`onEvent`.

Example: [`examples/persistence/event-migration-chain.ts`](https://github.com/pathosDev/actor-ts/blob/main/examples/persistence/event-migration-chain.ts).

---

## Recipe 3 — `SchemaRegistry`: multi-service or multi-version coexistence

**When:** The schema isn't owned by one actor — multiple services
write to the same Kafka topic, the same shared event bus, the
same cross-service journal.  Each service may be on a different
version at any moment.  You want a central place to register
schemas, enforce compatibility rules (`backward` /
`backward-transitive` / `forward` / `full` / `none`), and serve
the chain at runtime.

**Why this one:** Registration is a first-class step.  A new
service version can refuse to start if its schema isn't
backward-compatible with the registered one.  Single source of
truth for "what does v2 look like?" across the fleet.

```ts
import { InMemorySchemaRegistry } from 'actor-ts/persistence';
import { z } from 'zod';

const registry = new InMemorySchemaRegistry();

registry.register({
  manifest: 'BankAccount.Deposited',
  version: 1,
  codec: zodCodec(z.object({ kind: z.literal('deposited'), amount: z.number() })),
  compatibility: 'backward',
});

registry.register({
  manifest: 'BankAccount.Deposited',
  version: 2,
  codec: zodCodec(z.object({ kind: z.literal('deposited'), amount: z.number(), currency: z.string() })),
  upcast: (v1) => ({ ...v1, currency: 'USD' }),
  compatibility: 'backward',
});

// The registry exposes the chain — feed it to migratingAdapter.
const chain = registry.chainFor<DepositedV2>('BankAccount.Deposited');
const adapter = migratingAdapter(chain);
```

**Verifiable invariant:** Registering a new version that breaks
the configured compatibility level throws at registration time,
not at first-write time.  Catches the bug before deployment.

**When NOT to use this:** Single-service single-actor evolution.
`MigrationChain` directly is shorter, faster to type-check, and
doesn't need a registry instance.

Example: [`examples/persistence/schema-registry.ts`](https://github.com/pathosDev/actor-ts/blob/main/examples/persistence/schema-registry.ts).

---

## Recipe 4 — `validatedEventAdapter`: on-write validation

**When:** You want every write to be validated against a strict
schema (Zod, ts-pattern matcher, hand-rolled type guard) before
it lands in the journal.  Catches "wrong type sneaked through
JSON.parse on the network boundary" bugs at the persist call, not
at recovery time three days later.

**Why this one:** Wraps an existing adapter; the chain's upcast
path is untouched.  Validation happens on the write side; reads
trust the journal (validated at write).

```ts
import {
  defaultsAdapter,
  validatedEventAdapter,
  zodCodec,
} from 'actor-ts/persistence';
import { z } from 'zod';

const codec = zodCodec(
  z.object({ kind: z.literal('deposited'), amount: z.number().positive() }),
);

const base = defaultsAdapter<DepositedV2>({
  manifest: 'BankAccount.Deposited',
  currentVersion: 2,
  defaults: { 1: { currency: 'USD' } },
});

const adapter = validatedEventAdapter(base, codec);
```

**Verifiable invariant:** A write with an invalid payload throws
`PersistError` (with the validator's own error attached) before
anything hits the journal.

**Composable with everything:** wraps `defaultsAdapter`,
`migratingAdapter`, or any other `EventAdapter`.

---

## Recipe 5 — `wrapEventAsEnvelope` + bulk migrators: retrofit a legacy journal

**When:** You have an existing journal of **raw events** (no
`{ _v, _t, _e }` envelope) and you're adopting the schema-
evolution machinery for the first time.  Without envelopes, the
chain has no version to look at.

**Why this one:** One-shot rewrite that wraps every existing
event in an envelope at version 1, then your normal migration
chain takes over.  After the rewrite, every event in the journal
has the manifest the migration tooling expects.

```ts
import {
  wrapEventAsEnvelope,
  migrateInMemoryJournal,
} from 'actor-ts/persistence';

// One-shot: rewrite every event in the journal as an envelope.
await migrateInMemoryJournal(journal, (event) =>
  wrapEventAsEnvelope(event, { manifest: 'BankAccount.Deposited', version: 1 }),
);

// From here on, future writes use the chain normally.
```

**Verifiable invariant:** After the migration, every event in
the journal has an envelope manifest pointing at the same
`(manifest, version: 1)` pair.  Reads via `migratingAdapter`
upcast normally.

**When NOT to use this:** New journals (start with envelopes from
day one — `defaultsAdapter` or `migratingAdapter` automatically
emit envelopes).  Or journals that already have envelopes
(`wrapEventAsEnvelope` is idempotent — calling on an already-
wrapped envelope is a no-op — but the bulk pass is wasted work).

Example: [`examples/persistence/migrate-legacy-events.ts`](https://github.com/pathosDev/actor-ts/blob/main/examples/persistence/migrate-legacy-events.ts).

---

## Pitfalls

### "Should I use `defaultsAdapter` AND `migratingAdapter`?"

No.  `defaultsAdapter` is a convenience wrapper that implies a
chain whose every step is "merge in these defaults".  If you have
both a defaultable change and a non-additive one, write the whole
thing as a `MigrationChain` and use `migratingAdapter` — the
chain can include "additive" steps as plain upcasters.

### "Can I downgrade?"

Yes, but only via `migratingAdapter` with explicit downcasters.
Specify `writeVersion < currentVersion` in
`migratingAdapter(chain, { writeVersion: oldV })` and the chain
runs the downcasters on the way to the journal.  Used during the
**code-first phase** of a rolling deploy
([Rolling deployment migration](/operations/upgrades/rolling-migration/)).

### "What about snapshots?"

Snapshots have their own parallel adapter: `snapshotAdapter()`.
Everything in this guide applies symmetrically; `DurableStateActor`
provides `stateAdapter()` on the same shape.

### "What about manifest renames?"

Don't.  The manifest string is the identity of the event type
across the lifetime of the journal — renaming it breaks every
historical entry.  If you really need to rename a manifest, write
a new manifest with version 1 and emit a one-shot bulk migrator
that wraps old-manifest events as new-manifest envelopes.  Use
`migrateBetweenJournals(source, target, { eventTransform })` for
this — read from the old, write the transformed copy to a fresh
target.

### "What if the source has been compacted?"

It is copied as it stands, including the compaction.  A journal
that has been compacted past a snapshot no longer starts at
sequence 1, and one that was compacted completely holds no events
at all while its high-water mark still remembers the numbers it
handed out.  `migrateBetweenJournals` reproduces both: it raises
the target's compaction mark to just below the first surviving
event before appending, so every event lands on the sequence
number it had in the source.

That matters because a sequence number is a **reference**, not
just an ordinal — the paired snapshot, every read-side offset and
every projection cursor names `(persistenceId, sequenceNr)`.
Renumbering the surviving tail detaches all of them at once, and
in the layout compaction normally leaves behind (the snapshot
sitting *at* the compaction point) nothing fails loudly: recovery
folds a later tail onto an earlier state and the actor serves
commands from a state that never existed.

Two consequences for a paired run:

- **Copy the journal first, then the snapshots.**  A snapshot is
  written at the sequence number it already has, and only means
  anything against a journal numbered the same way.
- **A third-party target journal must implement
  `Journal.raiseCompactionMark`.**  All ten built-in journals do.
  One that does not makes the copy throw `CompactedSourceError`
  rather than renumber the stream — refusing is the only honest
  answer a target that cannot record a mark can give.

### "My snapshots are encrypted — does the copy handle that?"

Only if you tell it which keys to use, and you tell it **twice**:

```ts
await migrateBetweenSnapshotStores(oldSnapshots, newSnapshots, {
  persistenceIds: await oldJournal.persistenceIds(),
  sourcePersistenceOptions: { encryption: oldEncryption },
  targetPersistenceOptions: { encryption: newEncryption },
});
```

The two sides are separate on purpose: a re-key sweep is an
ordinary reason to migrate, so source and target routinely hold
different keys or keyrings.

You only need these when the master key is supplied **per call**
— by a `PersistentActor`'s `encryption()` hook, say.  A store
built with `withEncryption(...)` falls back to its own
configuration and needs neither.  But do not omit
`targetPersistenceOptions` on a target that encrypts per call:
the write silently resolves to `{ mode: 'none' }` and the
migrated snapshot lands in the bucket as plaintext.

---

## Reference

| Tool                       | Module                            | Use when                                  |
| -------------------------- | --------------------------------- | ----------------------------------------- |
| `defaultsAdapter`          | `src/persistence/migration/DefaultsAdapter.ts` | Additive only            |
| `MigrationChain` + `migratingAdapter` | `src/persistence/migration/{MigrationChain,migratingAdapter}.ts` | Anything else  |
| `InMemorySchemaRegistry`   | `src/persistence/migration/SchemaRegistry.ts`  | Multi-service / multi-version coexistence |
| `validatedEventAdapter`    | `src/persistence/migration/ValidatedAdapter.ts` | On-write validation     |
| `wrapEventAsEnvelope` + `migrateInMemoryJournal` / `migrateSnapshotStore` | `src/persistence/migration/WrapLegacy.ts` | Retrofit pre-envelope journal |
| `migrateBetweenJournals` / `migrateBetweenSnapshotStores` | `src/persistence/migration/JournalMigration.ts` | Copy + transform between two backends |

All of them are exported from the top-level `actor-ts` barrel.

---

## Related

- [Rolling deployment migration](/operations/upgrades/rolling-migration/)
  — how to deploy any of these across a running cluster.
- [Migration overview](/persistence/migration/overview/)
  — quick-tour of `defaultsAdapter` and `MigrationChain`.
- [`CHANGELOG.md`](https://github.com/pathosDev/actor-ts/blob/main/CHANGELOG.md)
  `[0.6.0]` → "schema migration & encryption polish" for the underlying
  feature set.
