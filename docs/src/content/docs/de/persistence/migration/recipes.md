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
import { defaultsAdapter, PersistentActor } from 'actor-ts/persistence';

type DepositedV1 = { kind: 'deposited'; amount: number };
interface DepositedV2 extends DepositedV1 { currency: string }

class Account extends PersistentActor<Command, Deposited, State> {
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

Beispiel: [`examples/persistence/event-migration.ts`](https://github.com/pathosDev/actor-ts/blob/main/examples/persistence/event-migration.ts).

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

**Rolling Deploys:** pinne `writeVersion` auf `migratingAdapter`,
um Writes auf der alten Form zu halten, während die Reader
aufholen — siehe
[Rolling-Deployment-Migration](/de/operations/upgrades/rolling-migration/)
für das vollständige Vier-Phasen-Rezept.

**Verifizierbare Invariante:** Eine vN-Payload, die zurückgelesen
wird, kommt als `currentVersion`-förmiges Event an.  Jeder
Upcaster läuft genau einmal pro fehlendem Versionsschritt;
Zwischen-Formen erreichen `onEvent` nie.

Beispiel: [`examples/persistence/event-migration-chain.ts`](https://github.com/pathosDev/actor-ts/blob/main/examples/persistence/event-migration-chain.ts).

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

Beispiel: [`examples/persistence/schema-registry.ts`](https://github.com/pathosDev/actor-ts/blob/main/examples/persistence/schema-registry.ts).

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
} from 'actor-ts/persistence';

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

Beispiel: [`examples/persistence/migrate-legacy-events.ts`](https://github.com/pathosDev/actor-ts/blob/main/examples/persistence/migrate-legacy-events.ts).

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
([Rolling-Deployment-Migration](/de/operations/upgrades/rolling-migration/)).

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

### "Was, wenn die Quelle kompaktiert wurde?"

Sie wird so kopiert, wie sie ist — die Kompaktierung
eingeschlossen.  Ein Journal, das über einen Snapshot hinaus
kompaktiert wurde, beginnt nicht mehr bei Sequenznummer 1; ein
vollständig kompaktiertes hält gar keine Events mehr, während
seine High-Water-Mark sich noch an die vergebenen Nummern
erinnert.  `migrateBetweenJournals` bildet beides ab: Es hebt die
Kompaktierungsmarke des Targets auf den Wert direkt unterhalb des
ersten überlebenden Events an, bevor es anhängt — so landet jedes
Event auf genau der Sequenznummer, die es in der Quelle hatte.

Das ist wichtig, weil eine Sequenznummer eine **Referenz** ist und
nicht bloß eine Ordnungszahl: Der zugehörige Snapshot, jeder
Read-Side-Offset und jeder Projektions-Cursor benennt
`(persistenceId, sequenceNr)`.  Ein Umnummerieren des überlebenden
Endes löst sie alle gleichzeitig von ihrem Ziel — und in der
Form, die eine Kompaktierung normalerweise hinterlässt (der
Snapshot liegt *auf* dem Kompaktierungspunkt), schlägt nichts laut
fehl: Die Recovery faltet ein späteres Ende auf einen früheren
Zustand, und der Actor bedient Commands aus einem Zustand, den es
nie gegeben hat.

Zwei Konsequenzen für einen gepaarten Lauf:

- **Erst das Journal kopieren, dann die Snapshots.**  Ein Snapshot
  wird auf der Sequenznummer geschrieben, die er bereits hat, und
  bedeutet nur gegenüber einem gleich nummerierten Journal etwas.
- **Ein fremdes Target-Journal muss
  `Journal.raiseCompactionMark` implementieren.**  Alle zehn
  eingebauten Journals tun das.  Eines, das es nicht tut, lässt
  die Kopie mit `CompactedSourceError` fehlschlagen, statt den
  Stream umzunummerieren — mehr kann ein Target, das keine Marke
  festhalten kann, ehrlicherweise nicht anbieten.

### "Was, wenn die Quelle Tags trägt, die `append` nicht mehr annimmt?"

Sie wird zurückgewiesen — und zwar, bevor irgendetwas geschrieben ist.

Die Tag-Validierung läuft nur auf Schreibpfaden.  Ein Journal, das
vor diesen Regeln geschrieben wurde, spielt also für immer
unverändert ab; dieses Versprechen bleibt.  Bei einer Kopie reicht
es nicht mehr: Sie liest eine historische Liste und reicht sie an
das `append` des Ziels weiter — und das ist ein Schreibvorgang.  Die
beiden Formen, die ältere Releases üblicherweise hinterlassen haben,
sind ein **leerer** Tag (`['orders', '']`, aus einem
`[category, subCategory ?? '']`, dessen zweiter Platz nie gefüllt
wurde) und **derselbe Tag zweimal**.

`migrateBetweenJournals` geht die Quelle zuerst in einem rein
lesenden Vorlauf durch und weist deshalb mit `MigrationTagError`
zurück — mit Persistence-ID und Sequenznummer im Text —, während
Ziel und Fortschrittsspeicher noch unberührt sind.  Was es vorher
tat, war schlechter als eine Zurückweisung: Es traf die kaputte
Liste erst an dem `append`, das sie ablehnte, und ließ ein teilweise
gefülltes Ziel zurück, einen abgeschnittenen Stream und
Fortschrittseinträge, die die Streams davor als erledigt auswiesen.
Ein erneuter Lauf mit `skipExistingPersistenceIds` ging dann glatt
am abgeschnittenen vorbei, weil das Ziel *irgendwelche* Daten dafür
hatte.

Zwei Wege hindurch.  Die Listen selbst umschreiben:

```ts
await migrateBetweenJournals(oldJournal, newJournal, {
  eventTransform: (e) => ({ ...e, tags: e.tags?.filter((tag) => tag.length > 0) }),
});
```

Oder sich für die beiden Reparaturen entscheiden, die kein Urteil
erfordern — ein leerer Eintrag fällt weg, eine Wiederholung wird
zusammengefaltet:

```ts
const copied = await migrateBetweenJournals(oldJournal, newJournal, {
  invalidTags: 'sanitize',
});
console.log(`${copied.eventsWithSanitizedTags} tag lists rewritten`);
```

Die Zahl steht mit Absicht im Ergebnis: Historische Daten zu
reparieren heißt, sie zu ändern — ein Lauf, der saubere Tags
erwartet hat, kann so darauf bestehen, dass sie null ist.
`'sanitize'` hört dort auf: Ein Komma, ein Control-Zeichen, ein zu
langer Tag oder zu viele Tags an einem Event werden auch damit
zurückgewiesen, denn sie zu reparieren hieße, einen Tag zu erfinden
oder einen zu verwerfen, den der Aufrufer so gemeint hat.  Diese
Entscheidung gehört in `eventTransform`, in Code, den jemand lesen
kann.

Der Vorlauf deckt jede Zurückweisung der Kopie ab, nicht nur Tags:
Ein Loch in den Sequenznummern der Quelle und ein komprimiertes
Präfix, das das Ziel nicht abbilden kann, werden ebenfalls dort
entschieden.  Er kostet ein zusätzliches Lesen der Quelle — bei
einem Resume nur über das, was noch zu kopieren ist.

### "Meine Snapshots sind verschlüsselt — kommt die Kopie damit klar?"

Nur, wenn du ihr sagst, welche Schlüssel sie verwenden soll — und
zwar **zweimal**:

```ts
await migrateBetweenSnapshotStores(oldSnapshots, newSnapshots, {
  persistenceIds: await oldJournal.persistenceIds(),
  sourcePersistenceOptions: { encryption: oldEncryption },
  targetPersistenceOptions: { encryption: newEncryption },
});
```

Die beiden Seiten sind bewusst getrennt: Ein Re-Key-Durchlauf ist
ein ganz gewöhnlicher Grund zu migrieren, also halten Quelle und
Target regelmäßig unterschiedliche Schlüssel oder Keyrings.

Du brauchst sie nur, wenn der Master-Key **pro Aufruf** geliefert
wird — etwa durch den `encryption()`-Hook eines
`PersistentActor`.  Ein Store, der mit `withEncryption(...)`
gebaut wurde, greift auf seine eigene Konfiguration zurück und
braucht keins von beidem.  Lass aber `targetPersistenceOptions`
bei einem Target, das pro Aufruf verschlüsselt, nicht weg: Der
Schreibvorgang fällt still auf `{ mode: 'none' }` zurück, und der
migrierte Snapshot landet im Bucket als Klartext.

---

## Referenz

| Werkzeug                    | Modul                            | Verwenden, wenn                          |
| --------------------------- | --------------------------------- | ----------------------------------------- |
| `defaultsAdapter`           | `src/persistence/migration/DefaultsAdapter.ts` | Nur additiv                  |
| `MigrationChain` + `migratingAdapter` | `src/persistence/migration/{MigrationChain,migratingAdapter}.ts` | Alles andere  |
| `InMemorySchemaRegistry`    | `src/persistence/migration/SchemaRegistry.ts`  | Multi-Service / Multi-Version-Koexistenz |
| `validatedEventAdapter`     | `src/persistence/migration/ValidatedAdapter.ts` | On-Write-Validierung    |
| `wrapEventAsEnvelope` + `migrateInMemoryJournal` / `migrateSnapshotStore` | `src/persistence/migration/WrapLegacy.ts` | Pre-Envelope-Journal nachrüsten |
| `migrateBetweenJournals` / `migrateBetweenSnapshotStores` | `src/persistence/migration/JournalMigration.ts` | Kopieren + transformieren zwischen zwei Backends |

Alle werden aus dem Top-Level-`actor-ts`-Barrel exportiert.

---

## Verwandtes

- [Rolling-Deployment-Migration](/de/operations/upgrades/rolling-migration/)
  — wie du jedes davon über einen laufenden Cluster deployst.
- [Migration im Überblick](/de/persistence/migration/overview/)
  — Schnelltour von `defaultsAdapter` und `MigrationChain`.
- [`CHANGELOG.md`](https://github.com/pathosDev/actor-ts/blob/main/CHANGELOG.md)
  `[0.6.0]` → "schema migration & encryption polish" für das zugrunde
  liegende Feature-Set.
