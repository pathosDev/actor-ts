---
title: Rolling-Deployment-Migration
description: Schema-brechende oder Master-Key-rotierende Änderungen über einen laufenden actor-ts-Cluster ausrollen — ohne Downtime und ohne koordinierte Stops.
---

Dieser Guide beschreibt, wie du eine schema-brechende oder
Master-Key-rotierende Änderung über einen laufenden Cluster
ausrollst — **ohne Downtime** und **ohne koordinierte Stops**.
Jeder Node bedient weiter Traffic, während die neue Version
Instanz-für-Instanz rausgeht.

Die Rolling-Deploy-Story des Frameworks baut auf vier
ausgelieferten Features:

- **`writeVersion` auf `migratingAdapter`** (#7) — Reader handhaben
  jede registrierte Version; Writer emittieren eine gewählte.
- **`MasterKeyRing`** (#8) — `active` + `retired[]`-Schlüssel; das
  Manifest jedes verschlüsselten Bodys nennt die genutzte
  Schlüsselversion.
- **`wrapEventAsEnvelope` + `migrateInMemoryJournal`** (#9) —
  Einmal-Rewrite von Pre-Envelope-Events ins aktuelle
  Schema-Envelope.
- **`SchemaRegistry`** (#6) — Multi-Version-Codec +
  Kompatibilitäts-Checks.

Das untenstehende Muster komponiert alle vier zu einem
Vier-Phasen-Deploy. Es gilt identisch für SQLite-, Cassandra-,
In-Memory- und Object-Storage-Journals.

## TL;DR — das Vier-Phasen-Deploy

```
    PHASE 1            PHASE 2          PHASE 3            PHASE 4
    code-first         observation      writer flip        cleanup (optional)
    ───────────        ───────────      ───────────        ───────────────
v2-Reader ───┐         alle Instanzen   v2-Writer          alter Upcaster
v1-Writer    │         laufen v2-Code   aktiviert          fallengelassen;
   koexistieren│                                            optionales One-Shot-
             └─────────── beobachten ───────────►          Backfill via
   chain.register(v1, v2)   v1-Events weiter lesbar        migrateInMemoryJournal
   writeVersion: 1          Writer emittieren weiter v1    / migrateSnapshotStore
                                                           — hält die Historie
                                                             current-shape sauber
```

Jede Instanz im Cluster durchläuft diese Phasen der Reihe nach;
der Cluster als Ganzes geht nur vorwärts, wenn **jede** Instanz
auf derselben Phase oder weiter ist.

---

## Phase 1 — Code-first

Liefere den neuen Code mit dem neuen Schema **registriert** aus,
aber schreibe weiter die alte Form.

```ts
import {
  MigrationChain,
  migratingAdapter,
  PersistentActor,
} from 'actor-ts';

// 1. Beide Versionen in der Chain definieren.
const chain = MigrationChain
  .start<OrderEventV1>('OrderEvent', 1)
  .next<OrderEventV2>(2, (v1) => ({
    ...v1,
    currency: v1.currency ?? 'USD',  // Upcast: das neue Feld defaulten
  }));

// 2. writeVersion in dieser Phase auf der ALTEN Version pinnen.
const adapter = migratingAdapter(chain, { writeVersion: 1 });

class Order extends PersistentActor<OrderCommand, OrderEvent, OrderState> {
  override eventAdapter() { return adapter; }
  // ...
}
```

**Ergebnis nach Phase 1:**

- Neu deployte Instanzen lesen **sowohl** v1- als auch v2-Events
  korrekt (die Chain upcastet v1 → v2 beim Lesen).
- Alle Instanzen **schreiben** weiter v1, weil `writeVersion: 1`.
- Bestehender Journal-Inhalt bleibt v1 — kein Historien-Rewrite.

**Warum `writeVersion` pinnen?** Wenn eine v1-only-Instanz noch
läuft und ein v2-Event liest, das eine v2-Instanz gerade
geschrieben hat, hat der v1-Reader keinen Upcaster, um es zu
verstehen — `MigrationChain.read` wirft `MigrationError`. Indem du
Writes bei v1 hältst, bis alle Reader v2 können, vermeidest du
diesen Split.

**Rollback in dieser Phase ist trivial** — der v2-Code macht nur
v1s Job; nichts Neues auf Disk zum Rückgängigmachen.

---

## Phase 2 — Observation

Roll den neuen Code auf jede Instanz aus. Kein Code- oder
Config-Wechsel zwischen Phase 1 und Phase 2 — es ist ein
Deployment-Completion-Checkpoint, kein Deployment-Schritt.

**Was zu verifizieren ist:**

- Alle Instanzen melden dieselbe Build-Version (`/health`,
  Cluster-Management-Endpunkte oder dein eigener Deploy-Tracker).
- v1-Events werden vom neuen Code-Pfad gelesen
  (`migration_chain_upcast_total{from="1",to="2"}`-Metrik oder ein
  Log-Stichproben-Check auf `chain.read`).
- Writer emittieren weiter v1 (peek das Journal — die
  Manifest-Version des jüngsten Records sollte `1` sein).

**Warum warten?** In dem Moment, in dem ein Writer auf v2 flippt,
muss jeder Reader v2-fähig sein. Wenn auch nur eine v1-only-Instanz
noch läuft, fehlt ihrer `MigrationChain` der v2-Schritt, und
`chain.read` wirft `UnknownVersionError` beim ersten v2-Event, das
sie sieht.

**Lass diese Phase nicht aus**, auch wenn deine Deploy-Pipeline
"schnell" ist — eine 15-Sekunden-Pipeline kann während eines
Netzwerk-Blips eine einzelne Instanz zurücklassen, und Phase 3
macht diese eine Instanz funktionsunfähig.

---

## Phase 3 — Writer-Flip

Redeploye (oder Hot-Config-Change) mit `writeVersion: 2`.

```ts
// Das explizite writeVersion droppen — defaultet auf chain.currentVersion (2).
const adapter = migratingAdapter(chain);
```

**Ergebnis nach Phase 3:**

- Neue Writes nutzen die v2-Form (`currency` explizit gesetzt etc.).
- v1-Events auf Disk sind weiter über den Upcaster der Chain lesbar.
- Mixed-Version-Journal: älteste Events sind v1-geformt, neuere
  Events sind v2-geformt — beide round-trippen durch dasselbe
  `applyEvent`, dank des Upcasts beim Lesen.

**Rollback in dieser Phase ist nicht-trivial.** Jedes v2-Event,
das seit dem Flip geschrieben wurde, kann von einem v1-only-Reader
nicht gelesen werden. Wenn du zurück musst, hast du zwei Wege:

1. **Forward-Fix** — liefere einen v3-Chain-Eintrag aus, der v2
   handhabt. Das ist nur ein weiterer Rolling Deploy nach demselben
   Muster.
2. **Restore from Snapshot** — Writes stoppen, das Journal aus
   dem letzten Pre-Phase-3-Snapshot wiederherstellen, v1-Code
   redeployen. Daten, die im v2-Fenster geschrieben wurden, sind
   verloren.

Der Forward-Fix ist immer dem Restore vorzuziehen.

---

## Phase 4 — Cleanup (optional)

Nachdem Phase 3 lange genug gelaufen ist, dass keine v1-Events auf
dem Hot Path mehr gelesen werden dürften, kannst du:

1. **Historische Daten in die v2-Form backfillen**, damit
   zukünftige Reads den Upcast überspringen. Nutze die
   One-Shot-Helfer:

    ```ts
    import { migrateInMemoryJournal, migrateSnapshotStore } from 'actor-ts';

    // Jedes Event für jede persistenceId in die v2-Form umschreiben.
    await migrateInMemoryJournal(journal, (event) => chain.manifestFor(event, 2));

    // Dito für Snapshots.
    await migrateSnapshotStore(snapshots, pids, (state) => chain.manifestFor(state, 2));
    ```

    Für SQL- / Cassandra-Journals, wo es noch keinen In-Place-Rewrite
    gibt (getrackt unter #71 für Bulk-Wrap-Legacy), nutze
    `migrateBetweenJournals(source, target, { eventTransform })`
    (v0.8.0), um vom alten Backend zu lesen und eine frische,
    envelope-versehene Kopie ins neue zu schreiben — gleiches Muster
    wie ein Backend-Swap, mit dem Transform-Hook, der das Wrap inline
    erledigt:

    ```ts
    await migrateBetweenJournals(oldJournal, newJournal, {
      eventTransform: (pe) => ({
        ...pe,
        event: wrapEventAsEnvelope(pe.event, chain.manifestFor),
      }),
    });
    ```

2. **Den v1-Schritt** aus der `MigrationChain` droppen, sobald
   der Backfill durch ist:

    ```ts
    const chain = MigrationChain.start<OrderEventV2>('OrderEvent', 2);
    ```

    Alle zukünftigen Events werden jetzt nativ v2-geboren, ohne
    Upcast-Overhead.

**Phase 4 ist optional.** Viele Produktionssysteme leben
unbegrenzt mit Mixed-Version-Journals und lassen den Backfill nie
laufen — die Upcast-Kosten sind typischerweise Nanosekunden pro
Event. Lauf Phase 4 nur, wenn der Historien-Versions-Schritt zur
operativen Last wird (zusätzliche Code-Pfade zu warten,
Mixed-Version-Reads erschweren Debugging etc.).

---

## Master-Key-Rotation — parallele Story

Verschlüsselungsschlüssel rotieren nach derselben Vier-Phasen-Form,
mit einer zusätzlichen Anerkennung: Der **active**-Key ist immer
ein spezifischer Eintrag; das **retired**-Array ist das, was Reader
brauchen, um historische Bodies zu entschlüsseln.

### Phase 1 — Code-first (Key)

Liefer den neuen Schlüssel als `active` aus, behalte den alten als
`retired`.

```ts
import { ObjectStoragePluginOptions, registerObjectStoragePlugins } from 'actor-ts';

const options = ObjectStoragePluginOptions.create()
  // ... .withBackend(...), .withCompression(...) etc.
  .withEncryption({
    keys: {
      active:  { version: 2, key: NEW_32_BYTES },
      retired: [{ version: 1, key: OLD_32_BYTES }],
    },
  });
```

Nach dieser Phase stempeln die Manifeste **neuer** Bodies
`keyVersion = 2`; die Manifeste **bestehender** Bodies sagen
weiter `keyVersion = 1` und entschlüsseln via den
`retired[]`-Eintrag.

### Phase 2 — Observation (Key)

Verifiziere, dass jede Instanz den neuen Key-Ring hat. Ein Reader,
dem der `retired`-Eintrag für v1 fehlt, kann die historischen
Blobs nicht entschlüsseln.

### Phase 3 — Re-Encryption-Sweep (optional)

Sobald du den alten Schlüssel *physisch entfernen* willst,
verschlüssele jeden historischen Body unter dem neuen Schlüssel neu
mit dem `reEncryptObjectStorage`-Helfer (v0.8.0):

```ts
import { reEncryptObjectStorage } from 'actor-ts';

const result = await reEncryptObjectStorage(backend, {
  keyPrefix: 'snapshots/',
  keyring: {
    active:  { version: 2, key: NEW },
    retired: [{ version: 1, key: OLD }],
  },
  onProgress: (e) => process.stderr.write(
    `${e.index}/${e.total} ${e.action} ${e.key}\n`),
});
console.log(`rewrote ${result.rewrote} of ${result.scanned} objects`);
```

Der Sweep läuft durch jedes Objekt unter `keyPrefix`, entschlüsselt
mit der retired-/active-Version, auf die das Body-Manifest verweist,
und verschlüsselt unter dem Active-Key neu. Bodies, die bereits auf
der aktiven Version sind, werden auf dem Fast-Path übersprungen —
der Sweep ist idempotent und nach einem teilweisen Fehlschlag
sicher wieder ausführbar. `If-Match` wird intern genutzt, damit ein
gleichzeitiger Writer nicht still überschrieben wird.

#### Durable Resume-Tokens + Completeness-Check

Für Millionen-Objekt-Buckets hat der naive Sweep oben zwei
Schwächen, die in der Praxis hart treffen:

1. Ein Crash mittendrin zwingt den Resume-Lauf, **wieder die
   komplette Liste zu listen und jedes Key per GET zu prüfen**
   — jeder Body wird erneut auf "schon auf der Active-Version?"
   geprüft, was einen HEAD/GET pro Objekt kostet, selbst wenn
   kein PUT mehr nötig wäre. Bei einem 24-Stunden-Sweep heißt
   das: 24 Stunden verschwendetes Re-Walk.
2. Wenn der Operator einen Retired-Key **zu früh** aus der
   Config gedroppt hat (z. B. nur den jüngsten Retired-Eintrag
   behalten, der Korpus referenziert aber auch einen älteren),
   bricht der Sweep mittendrin am ersten Body ab, der die
   fehlende Version nutzt. Eine Hälfte des Korpus ist jetzt
   unter dem neuen Key, die andere weiter unter dem alten.

Beides wird durch zwei Opt-in-Optionen auf
`reEncryptObjectStorage` adressiert (v0.10.0, #109):

```ts
import {
  reEncryptObjectStorage,
  InMemoryReEncryptProgressStore,
  type ReEncryptProgressStore,
} from 'actor-ts';

// File-backed Progress-Store — übersteht einen Prozess-Crash.
// (Der mitgelieferte `InMemoryReEncryptProgressStore` ist der
//  In-Process-Default für Tests; für lange Production-Sweeps
//  willst du einen durable Backing-Store. Gleiche Shape, plug
//  beliebiges: Datei auf Disk, einen Redis-Key oder ein
//  Sentinel-Objekt im selben Bucket unter einem anderen Prefix.)
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
  // — Completeness-Check —
  // Default true. Sampelt die ersten 100 verschlüsselten Bodies
  // und weigert sich zu starten, wenn ein Body eine Key-Version
  // referenziert, die in active/retired fehlt. Fängt das
  // Dropped-Retired-Key-Footgun ab, BEVOR der Sweep ein
  // einziges PUT schreibt.
  verifyKeyringCompleteness: true,
  // sampleSize: 200,   // optionaler Override; Default = min(100, total)

  // — Durable Resume —
  // Persistiert den State alle 500 Rewrites. Nach einem Crash
  // greift der nächste Aufruf von reEncryptObjectStorage genau
  // hinter dem zuletzt gespeicherten Key — keine erneute
  // Prüfung bereits umgeschriebener Objekte.
  progress,
  saveProgressEveryN: 500,

  onProgress: (e) => process.stderr.write(
    `${e.index}/${e.total} ${e.action} ${e.key}\n`),
});

// Nach erfolgreichem End-to-End-Lauf wird progress.clear()
// automatisch aufgerufen — ein erneuter Sweep startet wieder
// von vorne.
console.log(`rewrote ${result.rewrote} of ${result.scanned}`);
```

**Was der Progress-Store sieht:**

- Erster Aufruf: `load()` liefert `{ lastKey: null, processedCount: 0 }`,
  der Sweep läuft von Anfang an.
- Bei jedem `saveProgressEveryN`-ten Rewrite: `save({ lastKey, processedCount })`
  wird aufgerufen. Wähle das Intervall, um IO-Overhead gegen
  Crash-Rewind-Window abzuwägen — `500` heißt, ein Crash wirft
  maximal ~500 Objekte zurück, was bei einem 10M-Bucket einem
  0,005%-Rewind entspricht.
- Nach einem sauberen End-of-Sweep: `clear()` wird aufgerufen.
  Ein frischer `reEncryptObjectStorage`-Aufruf startet von vorn.

**Wann `verifyKeyringCompleteness` deaktivieren:**

Default ist `true` und sollte das für nahezu alle Operatoren
auch bleiben. Setze es nur dann auf `false`, wenn:

- Du **unabhängig verifiziert** hast, dass der Keyring komplett
  ist (z. B. ein separater Audit-Job hat bereits jede vorhandene
  Body-Version enumeriert und bestätigt, dass jede davon im Ring
  liegt).
- Du auf einem Korpus arbeitest, auf dem der Sample-Check selbst
  teuer wäre (z. B. ein extrem-Cold-Storage-Backend, auf dem die
  ersten 100 Reads echtes Geld kosten) UND du den oben genannten
  Unabhängig-Audit-Schritt gegangen bist.

Deaktivieren ohne unabhängige Verifikation tauscht ein
deterministisches Pre-Flight-Failure gegen einen
Mitte-im-Korpus-Abbruch — operativ strikt schlechter.

### Phase 4 — den alten Schlüssel droppen

Nach dem Sweep den `retired[1]`-Eintrag droppen. Manifeste, die auf
`keyVersion = 1` zeigen, würden jetzt am Entschlüsseln scheitern —
aber der Sweep garantiert, dass keine mehr existieren.

**Empfohlenes Tempo:** Behalte `retired[]`-Einträge mindestens
einen vollen Backup-Zyklus länger als der Sweep braucht. Ein
korrumpierter Sweep-Lauf, der `retired[]` sofort droppt, ist nicht
wiederherstellbar.

---

## Referenz — die Symbole, die dieser Guide nutzt

| Symbol                                    | Was es tut                                  |
| ----------------------------------------- | ------------------------------------------- |
| `MigrationChain.start(name, v).next(...)` | Definiert eine Multi-Version-Event/State-Chain |
| `migratingAdapter(chain, { writeVersion })` | Adapter, der die Chain zum Journal exponiert |
| `chain.manifestFor(value, version)`       | Lower-Level-Envelope-Builder                |
| `wrapEventAsEnvelope(event, manifestFor)` | One-Shot-Rewrite für Pre-Envelope-Daten     |
| `migrateInMemoryJournal(journal, fn)`     | Bulk-Rewrite jedes Events unter einem Journal |
| `migrateSnapshotStore(store, pids, fn)`   | Dito für Snapshots                          |
| `MasterKeyRing` `{ active, retired? }`    | Multi-Version-Encryption-Key-Ring           |
| `reEncryptObjectStorage(backend, options)`   | Sweep: jeden Body unter einem Prefix mit dem Active-Key neu verschlüsseln |
| `ReEncryptProgressStore` / `InMemoryReEncryptProgressStore` | Durable Resume-Tokens für den Sweep (#109) — plug eine Datei-/Redis-/Object-Storage-backed Implementation für Millionen-Objekt-Buckets |

Alle werden aus dem Top-Level-`actor-ts`-Barrel exportiert.

---

## Verwandt

- [`docs/persistence/migration-recipes.md`](../persistence/migration-recipes.md)
  — Entscheidungsbaum, welchen Adapter zu wählen.
- [`CHANGELOG.md`](../../CHANGELOG.md) `[0.6.0]` → "schema migration
  & encryption polish" für das zugrundeliegende Feature-Set.
- Offene Issues: [#71](https://github.com/pathosDev/actor-ts/issues/71)
  Bulk-Wrap-Legacy-Migration für SQL/Cassandra.
