---
title: Migrations-Rezepte
description: Entscheidungsbaum, um den richtigen Migrations-Adapter zu wählen — defaultsAdapter, migratingAdapter, InMemorySchemaRegistry, validatedEventAdapter oder wrapEventAsEnvelope.
---

Das Framework liefert fünf Migrations-Werkzeuge, die
oberflächlich ähnlich aussehen:

- **`defaultsAdapter`** — neue Felder in alten Payloads füllen.
- **`migratingAdapter`** (über `MigrationChain`) — reine
  Per-Version-Upcaster, optional bidirektional mit Downcastern.
- **`InMemorySchemaRegistry`** — Multi-Version-Registry, die
  Kompatibilitäts-Checks zur Registrierungszeit erzwingt.
- **`validatedEventAdapter`** — einen Adapter in einen Codec
  einwickeln für Per-Write-Validierung.
- **`wrapEventAsEnvelope`** + die Bulk-Migratoren — One-Shot-
  Retrofit für Journals, die der Envelope-Form vorausgehen.

Dieser Leitfaden ist der Entscheidungsbaum.  Die meisten
Änderungen wählen genau eines davon — sie komponieren, aber
nicht alle Kombinationen sind sinnvoll.

---

## Das Flussdiagramm

```
                          ┌──────────────────────────────┐
                          │  Was ist die Änderung?       │
                          └──────────────┬───────────────┘
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              │                          │                          │
              ▼                          ▼                          ▼
        ┌──────────┐             ┌──────────────┐            ┌──────────────┐
        │ Neues    │             │ Umbenennen / │            │ Pre-Envelope-│
        │ Feld     │             │ bestehende   │            │ Journal?     │
        │ mit      │             │ Form         │            └──────┬───────┘
        │ Default? │             │ restruktur.? │                   │
        └────┬─────┘             └──────┬───────┘                   ▼
             │                          │                  wrapEventAsEnvelope
             ▼                          ▼                  + Bulk-Migratoren
        defaultsAdapter          migratingAdapter           (Rezept 5)
        (Rezept 1)               (Rezept 2)
                                         │
                          ┌──────────────┼──────────────┐
                          │                             │
                          ▼                             ▼
                   ┌───────────────┐            ┌────────────────┐
                   │ Multi-Service │            │ Brauchst       │
                   │ geteiltes     │            │ On-Write-      │
                   │ Schema (Kafka │            │ Validierung    │
                   │ Topic, Bus)?  │            │ (z. B. zod)?   │
                   └──────┬────────┘            └──────┬─────────┘
                          ▼                            ▼
                   SchemaRegistry              validatedEventAdapter
                   (Rezept 3)                  (Rezept 4) — wickelt
                                               jeden obigen Adapter ein
```

---

## Rezept 1 — `defaultsAdapter`: additive Evolution

**Wann:** Ein neues Feld mit sinnvollem Default hinzufügen.
Keine Restrukturierung, keine Umbenennungen, keine
Typänderungen.

**Warum dieser:** Kein Upcaster-Code zu schreiben oder zu
testen.  Der Adapter fügt den Default ein, wenn das Feld fehlt —
das war's.

```ts
import { defaultsAdapter, PersistentActor } from 'actor-ts';

interface DepositedV1 { kind: 'deposited'; amount: number }
interface DepositedV2 extends DepositedV1 { currency: string }

class Account extends PersistentActor<Cmd, Deposited, State> {
  override eventAdapter() {
    return defaultsAdapter<DepositedV2>({
      manifest: 'BankAccount.Deposited',
      currentVersion: 2,
      defaults: { 1: { currency: 'USD' } },     // v1 fehlte `currency`
    });
  }
  // ...
}
```

**Verifizierbare Invariante:** Eine v1-Payload, die zurückgelesen
wird, kommt als v2-förmiges Event mit bereits gesetztem
`currency: 'USD'` an.  Keine `onEvent`-Änderung erforderlich.

**Außerhalb des Scopes für `defaultsAdapter`:** Felder entfernen,
Felder umbenennen, ein Feld in mehrere splitten, Feldtypen
ändern.  All das geht zu `migratingAdapter`.

Beispiel: [`examples/persistence/event-migration.ts`](../../examples/persistence/event-migration.ts).

---

## Rezept 2 — `migratingAdapter` über `MigrationChain`: alles Nicht-Additive

**Wann:** Ein Feld umbenennen, seinen Typ ändern, ein Feld in
zwei splitten, zwei in eins mergen, verschachtelte Objekte
restrukturieren.  Alles, was nicht als "fill in a default"
ausgedrückt werden kann.

**Warum dieser:** Reine `(vN) => vN+1`-Upcaster komponieren in
eine Chain.  Jeder Schritt ist einzeln typsicher; die Chain
type-checkt, dass Start- und End-Formen passen.

```ts
import { MigrationChain, migratingAdapter } from 'actor-ts';

interface DepositedV1 { kind: 'deposited'; amount: number }
interface DepositedV2 { kind: 'deposited'; amount: number; currency: string }
interface DepositedV3 { kind: 'deposited'; cents: number;  currency: string } // float→int

const chain = MigrationChain
  .start<DepositedV1>('BankAccount.Deposited', 1)
  .next<DepositedV2>(2, (v1) => ({ ...v1, currency: 'USD' }))
  .next<DepositedV3>(3, (v2) => ({
    kind: v2.kind,
    cents: Math.round(v2.amount * 100),
    currency: v2.currency,
  }));

class Account extends PersistentActor<Cmd, DepositedV3, State> {
  override eventAdapter() { return migratingAdapter(chain); }
  // ...
}
```

**Rolling Deploys:** pinne `writeVersion` auf `migratingAdapter`,
um Writes auf der alten Form zu halten, während die Reader
aufholen — siehe
[`docs/operations/rolling-migration.md`](../operations/rolling-migration.md)
für das vollständige Vier-Phasen-Rezept.

**Verifizierbare Invariante:** Eine vN-Payload, die zurückgelesen
wird, kommt als `currentVersion`-förmiges Event an.  Jeder
Upcaster läuft genau einmal pro fehlendem Versionsschritt;
Zwischen-Formen erreichen `onEvent` nie.

Beispiel: [`examples/persistence/event-migration-chain.ts`](../../examples/persistence/event-migration-chain.ts).

---

## Rezept 3 — `SchemaRegistry`: Multi-Service- oder Multi-Version-Koexistenz

**Wann:** Das Schema gehört nicht einem Actor — mehrere Services
schreiben auf dasselbe Kafka-Topic, denselben geteilten
Event-Bus, dasselbe Cross-Service-Journal.  Jeder Service kann
in jedem Moment auf einer anderen Version sein.  Du willst einen
zentralen Ort, um Schemas zu registrieren,
Kompatibilitäts-Regeln zu erzwingen (`backward` /
`backward-transitive` / `forward` / `full` / `none`) und die
Chain zur Laufzeit bereitzustellen.

**Warum dieser:** Registrierung ist ein First-Class-Schritt.
Eine neue Service-Version kann sich weigern zu starten, wenn ihr
Schema nicht rückwärtskompatibel mit dem registrierten ist.
Single Source of Truth für "wie sieht v2 aus?" über die ganze
Flotte.

```ts
import { InMemorySchemaRegistry } from 'actor-ts';
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

// Die Registry stellt die Chain bereit — gib sie an migratingAdapter.
const chain = registry.chainFor<DepositedV2>('BankAccount.Deposited');
const adapter = migratingAdapter(chain);
```

**Verifizierbare Invariante:** Eine neue Version zu registrieren,
die das konfigurierte Kompatibilitäts-Level bricht, wirft zur
Registrierungszeit, nicht zur ersten Schreibzeit.  Erwischt den
Bug vor dem Deployment.

**Wann NICHT verwenden:** Single-Service-Single-Actor-Evolution.
`MigrationChain` direkt ist kürzer, schneller zu type-checken
und braucht keine Registry-Instanz.

Beispiel: [`examples/persistence/schema-registry.ts`](../../examples/persistence/schema-registry.ts).

---

## Rezept 4 — `validatedEventAdapter`: On-Write-Validierung

**Wann:** Du willst, dass jeder Write gegen ein striktes Schema
(Zod, ts-pattern-Matcher, handgerollter Type Guard) validiert
wird, bevor er im Journal landet.  Erwischt "falscher Typ ist
durch JSON.parse an der Netzwerk-Grenze geschlüpft"-Bugs beim
Persist-Aufruf, nicht zur Recovery-Zeit drei Tage später.

**Warum dieser:** Wickelt einen existierenden Adapter ein; der
Upcast-Pfad der Chain bleibt unberührt.  Validierung passiert
auf der Write-Seite; Reads vertrauen dem Journal (zur
Schreibzeit validiert).

```ts
import {
  defaultsAdapter,
  validatedEventAdapter,
  zodCodec,
} from 'actor-ts';
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

**Verifizierbare Invariante:** Ein Write mit ungültiger Payload
wirft `PersistError` (mit dem eigenen Fehler des Validators
angehängt), bevor irgendetwas das Journal trifft.

**Komponierbar mit allem:** wickelt `defaultsAdapter`,
`migratingAdapter` oder jeden anderen `EventAdapter` ein.

---

## Rezept 5 — `wrapEventAsEnvelope` + Bulk-Migratoren: ein Legacy-Journal nachrüsten

**Wann:** Du hast ein existierendes Journal von **rohen Events**
(kein `{ _v, _t, _e }`-Envelope) und führst die Schema-Evolution-
Maschinerie zum ersten Mal ein.  Ohne Envelopes hat die Chain
keine Version, auf die sie schauen kann.

**Warum dieser:** One-Shot-Rewrite, der jedes existierende Event
in einen Envelope bei Version 1 verpackt, dann übernimmt deine
normale Migrations-Chain.  Nach dem Rewrite hat jedes Event im
Journal das Manifest, das das Migrations-Tooling erwartet.

```ts
import {
  wrapEventAsEnvelope,
  migrateInMemoryJournal,
} from 'actor-ts';

// One-Shot: jedes Event im Journal als Envelope umschreiben.
await migrateInMemoryJournal(journal, (event) =>
  wrapEventAsEnvelope(event, { manifest: 'BankAccount.Deposited', version: 1 }),
);

// Ab jetzt verwenden zukünftige Writes die Chain normal.
```

**Verifizierbare Invariante:** Nach der Migration hat jedes
Event im Journal ein Envelope-Manifest, das auf dasselbe
`(manifest, version: 1)`-Paar zeigt.  Reads über
`migratingAdapter` upcasten normal.

**Wann NICHT verwenden:** Neue Journals (starte mit Envelopes ab
Tag eins — `defaultsAdapter` oder `migratingAdapter` emittieren
automatisch Envelopes).  Oder Journals, die bereits Envelopes
haben (`wrapEventAsEnvelope` ist idempotent — der Aufruf auf
einem bereits eingewickelten Envelope ist ein No-op — aber der
Bulk-Pass ist verschwendete Arbeit).

Beispiel: [`examples/persistence/migrate-legacy-events.ts`](../../examples/persistence/migrate-legacy-events.ts).

---

## Stolperfallen

### "Sollte ich `defaultsAdapter` UND `migratingAdapter` verwenden?"

Nein.  `defaultsAdapter` ist ein Convenience-Wrapper, der eine
Chain impliziert, deren jeder Schritt "merge in diese Defaults"
ist.  Wenn du sowohl eine defaultbare Änderung als auch eine
nicht-additive hast, schreibe das Ganze als `MigrationChain` und
verwende `migratingAdapter` — die Chain kann "additive" Schritte
als plain Upcaster einschließen.

### "Kann ich downgraden?"

Ja, aber nur über `migratingAdapter` mit expliziten
Downcastern.  Spezifiziere `writeVersion < currentVersion` in
`migratingAdapter(chain, { writeVersion: oldV })`, und die Chain
führt die Downcaster auf dem Weg zum Journal aus.  Verwendet
während der **Code-First-Phase** eines Rolling Deploys
([rolling-migration.md](../operations/rolling-migration.md)).

### "Was ist mit Snapshots?"

Snapshots haben ihren eigenen parallelen Adapter:
`snapshotAdapter()`.  Alles in diesem Leitfaden gilt symmetrisch;
`DurableStateActor` stellt `stateAdapter()` auf derselben Form
bereit.

### "Was ist mit Manifest-Umbenennungen?"

Tu's nicht.  Der Manifest-String ist die Identität des
Event-Typs über die Lebensdauer des Journals — ihn umzubenennen
bricht jeden historischen Eintrag.  Wenn du wirklich ein
Manifest umbenennen musst, schreibe ein neues Manifest mit
Version 1 und emittiere einen One-Shot-Bulk-Migrator, der
Old-Manifest-Events als New-Manifest-Envelopes verpackt.
Verwende dafür
`migrateBetweenJournals(source, target, { eventTransform })` —
lies vom alten, schreibe die transformierte Kopie in ein
frisches Target.

---

## Referenz

| Werkzeug                    | Modul                            | Verwenden, wenn                          |
| --------------------------- | --------------------------------- | ----------------------------------------- |
| `defaultsAdapter`           | `src/persistence/migration/defaultsAdapter.ts` | Nur additiv                  |
| `MigrationChain` + `migratingAdapter` | `src/persistence/migration/{MigrationChain,migratingAdapter}.ts` | Alles andere  |
| `InMemorySchemaRegistry`    | `src/persistence/migration/SchemaRegistry.ts`  | Multi-Service / Multi-Version-Koexistenz |
| `validatedEventAdapter`     | `src/persistence/migration/validatedAdapter.ts` | On-Write-Validierung    |
| `wrapEventAsEnvelope` + `migrateInMemoryJournal` / `migrateSnapshotStore` | `src/persistence/migration/wrapLegacy.ts` | Pre-Envelope-Journal nachrüsten |
| `migrateBetweenJournals` / `migrateBetweenSnapshotStores` | `src/persistence/migration/journalMigration.ts` | Kopieren + transformieren zwischen zwei Backends |

Alle werden aus dem Top-Level-`actor-ts`-Barrel exportiert.

---

## Verwandtes

- [`docs/operations/rolling-migration.md`](../operations/rolling-migration.md)
  — wie du jedes davon über einen laufenden Cluster deployst.
- [`README.md` → Schema-Evolution](../../README.md#schema-evolution-event--state-migration)
  — Schnelltour von `defaultsAdapter` und `MigrationChain`.
- [`CHANGELOG.md`](../../CHANGELOG.md) `[0.6.0]` → "schema migration
  & encryption polish" für das zugrunde liegende Feature-Set.
