---
title: Writing-style guide
description: Internal style guide for actor-ts documentation contributors.
sidebar:
  hidden: true
template: doc
---

This page is the **internal contract** for everyone writing pages
under `docs/src/content/docs/`.  It's hidden from the public sidebar
(`sidebar.hidden: true` in front-matter) but lives in the repo, so
every contributor finds it when editing docs.

If you're reading this because you're about to write or revise a
documentation page: skim the first three sections, copy the template
in section 4, then keep this tab open while you write.

## 1 — Audience

The reader is a working TypeScript developer.  They are **not**:

- Necessarily familiar with the actor model.  Treat Akka / Erlang
  knowledge as a bonus, not a prerequisite.
- Coming from a Promise-heavy / Web-API background — most are.  Use
  Promise-comparisons over JVM-Akka-comparisons unless writing the
  explicit migration guide under `migration/from-akka-jvm`.
- Looking for a textbook.  They have a problem they want to solve,
  and the docs site is one of several tabs open.  Make them want to
  stay.

There are two skill levels we write for:

- **Newcomer**: hasn't built with actors before.  Needs the *why*
  before the *how*, and concrete examples over abstract diagrams.
- **Practitioner**: knows actors generally, wants to know how
  actor-ts handles a specific case — failover semantics, the
  difference between `tell` and `ask`, what happens on a journal
  read error during recovery.  Wants depth without preamble.

A good page serves both.  The template in section 4 does this via
progressive disclosure: easy stuff first, hard stuff later, both on
the same page.

## 2 — Voice

> An experienced colleague explains a thing to a motivated junior.

That's the entire voice in one sentence.  Some implications:

- **Direct**: short sentences, active voice.  "Actors process messages
  one at a time" beats "Messages are processed by actors sequentially."
- **Honest about gaps**: pre-1.0 is rough in places.  Where there
  are known limitations, say so and link to the issue.  Manufactured
  cheerfulness is worse than honest unfinished-ness.
- **No condescension**: avoid "easy", "simple", "just".  These read
  as gaslight when the reader is stuck.  Replace with "in one line"
  or just nothing.
- **No academic register**: skip "consider the following monoidal
  composition under the actor monad."  We're not writing a paper.
- **No marketing tone**: skip exclamation marks, "amazing",
  "powerful".  Let the content do the lifting.

## 3 — Three-tier reading model

Every concept page is built so the reader can stop at any tier and
have learned something useful:

| Tier | Question answered | Length budget |
|---|---|---|
| 1 — **Was du damit machen kannst** | What real-world problem does this solve? | 2-4 sentences |
| 2 — **Minimales Beispiel** | What's the smallest runnable demonstration? | 15-30 line code block |
| 3 — **Wie es funktioniert** | What are the mechanics + trade-offs? | 1-3 paragraphs |
| 3a — **Wann (nicht) anwenden** | When is this the right tool, when not? | Bulleted decision guide |
| 3b — **Häufige Fallstricke** | What goes wrong in practice? | 1-3 callout blocks |
| 3c — **Verwandte Konzepte** | What else should I look at? | 3-6 internal links |
| — | **API-Referenz** | Link to TypeDoc page |

A reader who only wants the gist reads tier 1 and stops.  A reader
who wants to use it reads tiers 1+2 and copies the code.  A reader
who wants to *understand* reads everything.

## 4 — Page template

Copy-paste this as the starting point for any new concept page.
Adjust headings to fit the topic; keep the order.

````markdown
---
title: <Topic>
description: <One-sentence summary, shows in browser tab + search results>
---

<1-sentence opener, plain prose.  Sets context.>

## Was du damit machen kannst

<2-4 Sätze.  Beispiele aus der echten Welt, keine API-Namen.>

## Minimales Beispiel

```typescript
// docs/snippets/<topic>.ts — kopiere und führe aus.

import { ActorSystem, Actor, Props } from 'actor-ts';

class Greeter extends Actor<string> {
  onReceive(name: string): void {
    console.log(`hello, ${name}`);
  }
}

const system = ActorSystem.create('demo');
const ref = system.actorOf(Props.create(() => new Greeter()), 'greeter');
ref.tell('world');
await system.terminate();
```

<1 Absatz darunter, der den Code in Prosa erklärt — Schritt für Schritt.>

## Wie es funktioniert

<Technische Tiefe.  Konzepte, Trade-offs, was passiert intern.
 Vergleiche mit "normalem" TS-Code (Promise-Welt) hilft.
 Akka-Vergleiche gehen in `migration/from-akka-jvm`, nicht hier.>

## Wann (nicht) anwenden

- Verwende ..., wenn du ...
- Verwende ..., wenn du ...
- Verwende **nicht** ..., wenn du ... (Alternative: <Link auf Alternative>).

## Häufige Fallstricke

import { Aside } from '@astrojs/starlight/components';

<Aside type="caution" title="Dein Recovery hängt">
  Symptom: <konkret>.  Ursache: <konkret>.  Fix: <konkret>.
</Aside>

<Aside type="tip" title="Snapshot-Frequenz">
  Eine Faustregel: ein Snapshot pro 100 Events ist ein guter Default.
  Höher = schnellere Recovery, mehr Snapshot-Disk-Cost.
</Aside>

## Verwandte Konzepte

- [<Verwandtes Konzept 1>](/build/fundamentals/...)
- [<Verwandtes Konzept 2>](/persist/snapshots/)

## API-Referenz

[`<ClassName>` in der API-Dokumentation](/api/classes/<className>/)
````

Where the topic doesn't fit (Reference pages like `configuration.md`,
FAQ pages, etc.) follow the section's own pattern — the three-tier
model is for concept guides specifically.

## 5 — Dos and Don'ts

**Schreibe so:**

- "Ein Actor verarbeitet seine Nachrichten der Reihe nach — wie eine
  Queue mit einem einzigen Worker."  *(Bildhaft, präzise, kein
  Jargon-Stack.)*
- "Wenn dein Service einen Crash überlebt, willst du dass die
  Nachrichten nicht weg sind.  Genau dafür ist at-least-once da."
  *(Use-Case-first, dann der Begriff.)*
- "Du brauchst kein `ask` wenn ein `tell` reicht — `tell` ist
  fire-and-forget, `ask` blockt auf Antwort mit Timeout."
  *(Hilft beim Entscheiden, statt nur zu beschreiben.)*

**Schreibe NICHT so:**

- "Consider the following monoidal composition of message handlers
  under the actor monad..."  *(Akademisch, distanziert.)*
- "Easy! Just call `system.actorOf(Props.create(...))`."  *("Easy"
  ist eine Lüge — und vermutlich nicht, wenn der Leser hier ist.)*
- "TBD" / "TODO" / "..."-Platzhalter im veröffentlichten Content.
  *(Stattdessen: explizit "Diese Seite ist im Aufbau, der Source
  unter `src/X.ts` ist die aktuelle Wahrheit." + Link.)*
- "Just" / "Simply" / "Obviously" — alle drei sind versteckte
  Gaslights und sollten ausnahmslos weg.

## 6 — Konkrete Regeln

1. **Jeder neue Fachbegriff wird beim ersten Auftritt erklärt**, in
   einem Satz oder per Link auf das Glossar
   (`docs/src/content/docs/intro/glossary.md`).
2. **Code-Blöcke sind selbst-erklärend**: ein Leser muss den Block
   lesen können ohne nach unten zu scrollen.  Imports sichtbar,
   keine `...`-Auslassung an spannenden Stellen.  Die Datei läuft
   real, wenn man sie kopiert.
3. **Vergleiche mit "normalem" TypeScript-Code**, nicht mit
   Akka-Scala oder Erlang.  Die Mehrheit der Leser kommt aus der
   Promise-/async-Welt.  JVM-Akka-Vergleiche gehören nach
   `migration/from-akka-jvm`.
4. **Maximal zwei unbekannte Begriffe pro Satz**.  Wenn ein Satz
   "Sharding-Region", "Allocation-Strategy" und
   "Rebalance-Coordinator" gleichzeitig aufmacht, ist er falsch
   geschnitten — in zwei Sätze splitten.
5. **Diagramme dann, wenn Prosa nicht reicht**: Sequence-Diagrams
   für Cluster-Joining, State-Diagrams für FSMs, Boxen-und-Pfeile
   für Sharding-Architektur.  Mermaid-Syntax — Starlight kann das
   nativ, keine externen PNGs.
6. **Honest about gaps**: wo etwas noch nicht durch Tests
   abgesichert ist oder nur halb fertig ist, lieber explizit
   verlinken ("Dieses Verhalten ist noch nicht durch Multi-Runtime-
   CI abgesichert — siehe #293") als so tun als gäbe es die Lücke
   nicht.
7. **Englisch ist Default-Sprache** der Site, Deutsch wo i18n
   vorhanden ist.  Beide Sprachen folgen demselben Voice-Guide —
   DE-Übersetzungen sind keine wörtlichen Carbon-Copies, sondern
   in DE neu geschrieben.  Sprich beim Übersetzen ein anderes Sprach-
   Tempo: Deutsche Sätze dürfen länger sein.
8. **Cross-links statt Wiederholung**: wenn ein Konzept auf einer
   anderen Seite ausführlich erklärt ist, in der eigenen Seite ein
   1-Satz-Reminder + Link.  Keine Copy-Paste zwischen Seiten — das
   driftet später auseinander.
9. **Heading-Tiefe maximal H3**: H1 ist der Page-Title (von
   Front-Matter gesetzt), H2 für Top-Level-Sektionen, H3 für
   Unterabschnitte.  Tiefer ist schwer zu navigieren.
10. **Hauptbeispiele auf ein Konzept fokussiert**: ein Code-Block
    soll **eine** Sache zeigen.  Wer „Persistent Actor mit
    Snapshots in Cluster Sharding mit Reliable Delivery" auf einer
    Seite zeigen will, zerlege das in 4 Seiten mit Cross-Links.

## 7 — Starlight-spezifische Conventions

- **Front-Matter immer am Anfang**: minimum `title` + `description`.
  Optional: `sidebar.order` (für manuelle Reihenfolge in
  auto-sidebar), `sidebar.label` (kürzere Sidebar-Label),
  `sidebar.hidden: true` (nicht im Nav, aber per URL erreichbar),
  `template: splash` (Landing-Page-Layout statt Doc-Layout),
  `tableOfContents: false` (TOC rechts ausblenden).

- **Aside-Komponente für Hervorhebungen**:

  ```mdx
  import { Aside } from '@astrojs/starlight/components';

  <Aside type="note">Hintergrund-Info, nicht zwingend.</Aside>
  <Aside type="tip">Praktischer Hinweis.</Aside>
  <Aside type="caution">Pass auf — kann schiefgehen.</Aside>
  <Aside type="danger">Wirklich schlimm wenn ignoriert.</Aside>
  ```

  Verwende `caution` und `danger` sparsam — wenn alles eine Warnung
  ist, ist nichts mehr eine.

- **Tabs für Variants** (Bun vs. Node vs. Deno; Kafka vs. NATS;
  …):

  ```mdx
  import { Tabs, TabItem } from '@astrojs/starlight/components';

  <Tabs>
    <TabItem label="Bun">
      ```sh
      bun add actor-ts
      ```
    </TabItem>
    <TabItem label="Node">
      ```sh
      npm install actor-ts
      ```
    </TabItem>
    <TabItem label="Deno">
      ```ts
      import { ActorSystem } from "npm:actor-ts";
      ```
    </TabItem>
  </Tabs>
  ```

- **Code-Snippet-Sammlung**: Snippets, die in mehreren Seiten
  vorkommen, leben unter `docs/snippets/<topic>.ts`.  Über
  `<Code code={...} file="<topic>.ts" />` einbinden.  Hält Code
  aus dem Markdown raus + macht Snippets testbar.

## 8 — i18n-Notizen

- **EN ist die kanonische Sprache**.  Wenn eine Seite zuerst auf DE
  geschrieben wird (weil der Autor DE-Muttersprachler ist), kommt
  trotzdem die EN-Version als erstes ins Repo.
- **DE-Übersetzung liegt unter `docs/src/content/docs/de/<pfad>.md`**
  und folgt dem gleichen Pfad-Mapping wie die EN-Datei.
- **Voice ist sprach-spezifisch, nicht Übersetzung**.  Englisch
  bevorzugt kurze Sätze; Deutsch darf länger sein.  Eine
  EN→DE-Übersetzung 1:1 klingt in DE oft staksig.
- **Coverage-Lücken sind OK** — Starlight fällt transparent auf
  EN zurück.  Die Onboarding-Trio-Pages (Quickstart, Why-Actors,
  Installation) müssen aber auf beiden Sprachen sauber sein, weil
  das die Erstkontakt-Pages für DE-Muttersprachler sind.

## 9 — Wenn du unsicher bist

- Ein guter **Voice-Anker** ist die migrate-Seite
  `operate/upgrades/rolling-migration.md` (305 Zeilen, bereits
  vor diesem Style-Guide geschrieben).  Operativ, konkret,
  ehrlich über Schwierigkeiten — der Ton stimmt.
- **Schreib so wie du es einem Kollegen erklärst, der gerade vor
  dir sitzt**.  Wenn du den Satz nicht laut sagen würdest, schreib
  ihn auch nicht.
- **Bei zwei guten Varianten: die kürzere**.  Vier Wörter weniger
  ist fast nie ein Verlust.

---

Wenn du etwas am Style-Guide selbst ändern willst — PR mit `docs:`
prefix, Body erklärt warum die Regel sich ändern sollte.  Style-
Guide-Änderungen brauchen kein Vorab-Issue; einfach PR.
