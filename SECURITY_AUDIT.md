# Security-Audit — actor-ts

**Stand:** 2026-07-08 · **Version:** v0.10.0 (`develop`) · **Auditor:** interner Review (statisch, adversarial)

Dieser Bericht dokumentiert einen Security-Audit des `actor-ts`-Frameworks. Geprüft wurden die
Trust-Boundaries: Cluster-Remoting (TCP), der HTTP/WebSocket-Server, die Broker-Adapter,
Persistence/Serialisierung und die Krypto-/Objekt-Storage-Schicht. Jeder Befund ist mit
`Datei:Zeile` belegt; für ausnutzbare Befunde ist ein Proof-of-Concept angegeben.

## Bedrohungsmodell

- **Cluster-Transport:** Betrieb in einem **vertrauenswürdigen Privatnetz** (isoliertes
  VPC/Firewall) ist die dokumentierte Annahme. Befunde, die diese Annahme voraussetzen (#1, #4),
  sind entsprechend eingestuft — sie werden **kritisch, sobald der Cluster-Port erreichbar ist**.
- **HTTP-/WebSocket-Server:** der **exponierte Rand** — hier gilt ein Angreifer ohne
  Vorrechte. Befunde hier werden nicht durch die Netz-Annahme herabgestuft.
- **Broker-Adapter:** **Outbound-Clients** zu operator-konfigurierter Infrastruktur.
  „Untrusted" heißt hier feindlicher/kompromittierter Upstream oder MITM auf Klartext-Transport.

## Schweregrad-Legende

**KRITISCH** — direkte Kompromittierung/Übernahme. **HOCH** — unauth. DoS/Umgehung am
exponierten Rand oder Datenabfluss. **MITTEL** — DoS/Umgehung mit Vorbedingung. **NIEDRIG** —
begrenzte Auswirkung / Vorbedingungen. **INFO** — Härtung/Doku.

## Zusammenfassung

| Bereich | KRITISCH | HOCH | MITTEL | NIEDRIG/INFO |
|---|---|---|---|---|
| Cluster / Remoting | #1 | #2 | #4, #5 | #9 |
| Persistence / Krypto | – | – | #3 | #6, #7 |
| HTTP-Edge (Backend/Middleware) | – | – | HTTP-1, HTTP-2, HTTP-3, HTTP-4 | – |
| WebSocket-Stack | – | WS-1, WS-2 | WS-3, WS-4, WS-5 | WS-6 |
| Broker | – | – | BRK-1, BRK-2 | BRK-3, BRK-4, BRK-5 |
| Management-HTTP | – | – | – | #8 |

Status je Befund: **P0** = in Behebung (aktueller Hardening-Zweig); übrige offen bzw. als
Betriebsanforderung/Doku eingestuft.

---

## Cluster / Remoting

### #1 — KRITISCH (bei verletzter Netz-Annahme): Unauthentifiziertes Remoting

Die Cluster-Transportschicht hat **keine Anwendungs-Authentifizierung** (`HelloMsg` trägt nur
`self`, kein Token; `ClusterSettings` bietet keinen Auth-Mechanismus). Jeder, der den Cluster-Port
erreicht, gilt nach einem trivialen `hello` als Peer und kann Nachrichten an **beliebige** Actors
zustellen: `Transport.onMessage` → `Cluster.handleWire` ([Cluster.ts:497](src/cluster/Cluster.ts))
→ `dispatchEnvelope` ([Cluster.ts:598](src/cluster/Cluster.ts)) → `system._resolvePath`
([ActorSystem.ts:240](src/ActorSystem.ts)) → `ref.tell(body)`.

**PoC A — Nachrichten-Injektion:**
```js
import net from 'node:net';
const frame = (o) => { const p = Buffer.from(JSON.stringify(o));
  const h = Buffer.alloc(4); h.writeUInt32BE(p.length, 0); return Buffer.concat([h, p]); };
const s = net.connect(2552, 'victim-host');
s.on('connect', () => {
  s.write(frame({ t: 'hello', self: { systemName: 'evil', host: '10.0.0.66', port: 1 } }));
  s.write(frame({ t: 'envelope', from: null,
    to: 'actor-ts://victim-system/user/account-manager',
    body: { type: 'TransferFunds', to: 'attacker', amount: 1_000_000 } }));
});
```

**PoC B — Gossip-Poisoning:** `{ t:'gossip', members:[{ address:<victim>, status:'removed',
version: Date.now(), removedAt: Date.now() }] }` tombstoned einen gesunden Knoten (Version-Skew-Cap
[Cluster.ts:811](src/cluster/Cluster.ts) blockt nur absurde Werte). **PoC C — Leave-Spoofing:**
`{ t:'leave', node:<victim> }`.

**Remediation:** (a) opt-in Shared-Secret im `hello`-Handshake (neue `ClusterSettings.secret`,
Validierung vor `handleWire`); (b) mTLS unterstützen + dokumentieren; (c) Netz-Isolation als
Betriebsanforderung dokumentieren. **Status:** opt-in Auth + Doku (nachgelagert; Netzmodell).

### #2 — HOCH: SSRF über decodierte reply-to-Refs

`decodeSingleRef` ([RefCodec.ts:81](src/cluster/RefCodec.ts)) baut aus einem angreiferkontrollierten
`WireActorRef` (host/port frei) einen `RemoteActorRef`; antwortet ein Actor darauf, wählt
`RemoteActorRef.tell` → `openOutbound` ([Transport.ts:151](src/cluster/Transport.ts)) zur
angreiferdefinierten Adresse.

**PoC:** Envelope mit `body.replyTo = { $ref:'actor', host:'169.254.169.254', port:80, system:'x',
path:'…' }` → Antwort öffnet TCP zu `169.254.169.254:80` (Cloud-Metadata) → SSRF / interner
Port-Scan / Reflection.

**Remediation & Status — akzeptiert unter dem Netzmodell (nicht separat gefixt).** Ein
Membership-Allowlist-Guard im Decoder wurde umgesetzt, dann aber **verworfen**: er bricht den
Location-Transparency-Vertrag — ein Ref auf einen *dritten* Knoten muss originalgetreu relayen
(belegt durch `tests/integration/in-process/cluster/RefAcrossNodes.test.ts`), und „ist Member"
ist kein verlässliches Signal für „legitimes Ziel". SSRF-via-Ref ist nur durch einen
**bösartigen/kompromittierten Peer** auslösbar — im gewählten „vertrauenswürdiges Privatnetz"-
Modell ausgeschlossen. Die reale Gegenmaßnahme ist dieselbe wie für #1/#4: **Netz-Isolation +
opt-in Cluster-Auth + mTLS**. #2 ist damit ein Symptom von #1 (fehlende Auth), nicht unabhängig
behebbar, ohne Ref-Relaying zu brechen.

### #4 — MITTEL: Klartext-Transport per Default

`TcpTransport` ([Transport.ts:73](src/cluster/Transport.ts)) `tls = null` per Default → Actor-Pfade,
Bodies, Gossip unverschlüsselt; ohne Client-Zertifikate keine Peer-Auth. **Remediation:** mTLS-Pfad +
Produktions-Doku; `rejectUnauthorized`-Default prüfen. **Status:** Betriebsanforderung/Doku.

### #5 — MITTEL/NIEDRIG: Verbindungs-/Speicher-DoS im Cluster-Transport

Kein Handshake-Timeout für Verbindungen, die verbinden aber nie ein gültiges `hello` senden; kein
Limit gleichzeitiger Verbindungen; pro Verbindung bis knapp `maxFrameBytes` (16 MiB) gepuffert
([Protocol.ts:188](src/cluster/Protocol.ts)). **Remediation:** Handshake-Timeout, Conn-Limit.
**Status:** P2.

### #9 — INFO: `__proto__`-Keys in der Deserialisierung

`decodeTree` ([JsonSerializer.ts:85](src/serialization/JsonSerializer.ts)) / `walkDecode`
([RefCodec.ts:153](src/cluster/RefCodec.ts)) setzen Keys auf frische Objekte. **Keine** globale
Prototype-Pollution; Härtung: `Object.create(null)` bzw. `__proto__`/`constructor` überspringen.

---

## Persistence / Krypto

### #3 — MITTEL: Unbegrenzte Dekompression (Zip-Bomb → OOM)

`gunzipSync` / zstd-`decompress` ([Compression.ts:51,135,144](src/persistence/object-storage/Compression.ts))
ohne Output-Cap. Betrifft auch Snapshot-/Durable-State-Read und den Re-Encryption-Sweep. Ein
präparierter Body (wenige MB → viele GB) sprengt beim Recovery den Speicher. **Remediation:**
`maxOutputBytes`-Cap + Abbruch. **Status:** P1.

### #6 — NIEDRIG: Inkonsistente Identifier-Validierung (SQL/CQL)

Der Guard `assertSafeIdentifier` wird in **Postgres/MariaDB** korrekt angewandt
([PostgresJournal.ts:54](src/persistence/journals/PostgresJournal.ts),
[MariaDbJournal.ts:44](src/persistence/journals/MariaDbJournal.ts)); Datenwerte sind überall
gebunden. Er **fehlt** in [SqliteJournal.ts:73](src/persistence/journals/SqliteJournal.ts),
[SqliteSnapshotStore.ts:35](src/persistence/snapshot-stores/SqliteSnapshotStore.ts) und
**CassandraJournal** (`qualified()` [:250](src/persistence/journals/CassandraJournal.ts),
interpoliert `${keyspace}.${table}` inkl. unvalidiertem Keyspace). Latent (Identifier stammen aus
Entwickler-Config). **Remediation:** Guard konsistent anwenden. **Status:** P2.

### #7 — NIEDRIG: AES-GCM ohne AAD

`aesGcmEncrypt/Decrypt` ([Encryption.ts:86](src/persistence/object-storage/Encryption.ts)) binden
keine `additionalData`. pid ist über HKDF-Salt key-separiert. Neues opt-in **HMAC-SHA256**
([Integrity.ts](src/persistence/object-storage/Integrity.ts), #116) schließt die
„mode:none"-Tampering-Lücke inkl. DurableState-CAS. Härtung: pid+version+seq als AAD bei
verschlüsselten Bodies. **Status:** P2.

---

## HTTP-Edge (Backend / Middleware) — exponierter Rand

### HTTP-1 — MITTEL-HOCH: Hono-Body-Cap greift erst nach voller Pufferung

`adaptRequest` liest den ganzen Body via `await c.req.arrayBuffer()`
([HonoBackend.ts:345](src/http/backend/HonoBackend.ts)); der `maxBodyBytes`-Check läuft erst danach
([:225](src/http/backend/HonoBackend.ts)). Reales Limit = Runtime-Default (Bun 128 MiB, Node via
`@hono/node-server` ~unbegrenzt). **PoC:** wenige parallele große POSTs → OOM. **Remediation:**
beim Lesen cappen bzw. natives Body-Limit setzen (Express macht es korrekt, [ExpressBackend.ts:326](src/http/backend/ExpressBackend.ts)).
**Status:** P0 (in Behebung).

### HTTP-2 — MITTEL-HOCH: `InMemoryCache` wächst unbegrenzt

Nur Lazy-Expiry, kein Sweep/Max-Size ([InMemoryCache.ts](src/cache/InMemoryCache.ts)). Idempotency
([IdempotencyKey.ts:83,90](src/http/cache/IdempotencyKey.ts): Key = `req.headers[header]`, TTL 24 h,
volle Response gespeichert), Rate-Limit und Response-Cache wachsen mit angreiferwählbaren Keys.
**PoC:** viele verschiedene `Idempotency-Key`-Header fluten → RAM-DoS. **Remediation:**
`InMemoryCache` begrenzen (LRU/Max-Size + Sweep); Key-Länge/-Anzahl cappen. **Status:** P0.

### HTTP-3 — MITTEL: Rate-Limit-Beispiel lehrt spoofbaren Key

Das dokumentierte Beispiel ([RateLimit.ts:29](src/http/cache/RateLimit.ts)) keyt auf
`x-forwarded-for` → ohne Trusted-Proxy vollständig umgehbar (bzw. `<anon>`-Sammelbucket trifft
legitime Clients). **Remediation:** Beispiel auf `req.remoteAddress` + Trusted-Proxy-Hinweis.
**Status:** P1.

### HTTP-4 — MITTEL: Idempotency nicht identitätsgebunden

Fingerprint = Methode+Pfad+Body ohne Identität ([IdempotencyKey.ts:172](src/http/cache/IdempotencyKey.ts));
Cache-Hit repliziert die gespeicherte Response inkl. Header ([:113](src/http/cache/IdempotencyKey.ts)).
Different-Body → 422 ist verteidigt. Cross-User-Reuse bei geteiltem/erratenem Key möglich.
**Remediation:** Caller-Identität in Fingerprint/Namespace falten. **Status:** P1.

---

## WebSocket-Stack (`src/http/ws/`) — exponierter Rand

### WS-1 — HOCH: Unauth. Prozess-Crash beim Upgrade (Express)

`matchWsPattern` decodiert Param-Segmente mit `decodeURIComponent` ([matchPattern.ts:21](src/http/ws/matchPattern.ts)),
das bei `%ZZ` `URIError` wirft. Die Match-Schleife in der `void`-IIFE
([ExpressBackend.ts:230](src/http/backend/ExpressBackend.ts)) ist **nicht** in try/catch; der
`socket.on('error')`-Guard (241) und der `authorize`-try/catch liegen dahinter → unhandled rejection
→ Node beendet den Prozess. Vor-Auth.

**PoC:** Route `websocket('/room/:id', …)`; Upgrade-Request `GET /room/%ZZ` mit `Upgrade: websocket`
→ Prozess-Exit. Fastify/Hono nicht betroffen. **Remediation:** Match in try/catch (URIError →
404/no-match) **und** IIFE mit `.catch(() => socket.destroy())`. **Status:** P0 (in Behebung).

### WS-2 — HOCH (bei ambienter Auth): CSWSH — kein Origin-Check

Kein Upgrade-Handler prüft `Origin`; `WebSocketRouteOptions` bietet keine Allowed-Origins. Bei
Cookie-/IP-basierter Auth kann eine fremde Seite `new WebSocket('wss://victim/…')` öffnen (Browser
hängt Cookies an), `authorize` akzeptiert. Bearer-Token-Auth ist inzident geschützt (Browser kann
`Authorization` beim WS-Handshake nicht setzen). **Remediation:** Allowed-Origins-Option +
Origin-Prüfung im Upgrade (alle 3 Backends). **Status:** P0.

### WS-3 — MITTEL: `maxFrameBytes` erst nach Pufferung

Der Cap greift erst in [WebSocketConnectionActor.ts:126](src/http/ws/WebSocketConnectionActor.ts),
nachdem `ws` das Frame voll gepuffert hat; Transport-`maxPayload` wird nicht gesetzt (ws-Default
100 MiB, [ExpressBackend.ts:224](src/http/backend/ExpressBackend.ts)). **Remediation:** `maxPayload`
= `policy.maxFrameBytes` an die Transporte durchreichen. **Status:** P1.

### WS-4 — MITTEL: Backpressure auf Hono wirkungslos

Guard ist `if (buffered !== undefined …)` ([WebSocketConnectionActor.ts:164](src/http/ws/WebSocketConnectionActor.ts));
der Hono-Adapter ([HonoBackend.ts:264](src/http/backend/HonoBackend.ts)) implementiert kein
`bufferedAmount` → `maxBufferedBytes`/`onBackpressure` tot → Slow-Client-OOM. **Status:** P1.

### WS-5 — MITTEL: Kein Connection-Limit / kein Timeout

Kein Admission-Limit, kein Handshake-/Idle-Timeout (Slowloris); synchroner Inbound →
Hub-Mailbox-Wachstum ([WebSocketConnectionActor.ts:148](src/http/ws/WebSocketConnectionActor.ts)).
Actor-Teardown bei Close ist korrekt (kein Leak). **Status:** P1.

### WS-6 — NIEDRIG: CRLF-Injection in `writeRawHttpResponse`

App-Header werden verbatim geschrieben ([rawResponse.ts:52](src/http/ws/rawResponse.ts)); ein
`authorize`, das angreiferbeeinflusste Header in eine Reject-Response setzt, ermöglicht
Response-Splitting. **Remediation:** CR/LF in Header-Werten strippen. **Status:** P2.

---

## Broker (Outbound-Clients: feindlicher Upstream / MITM)

- **BRK-1 (MITTEL):** TCP-`lines`-Framing prüft `maxLineLen` nicht bei fehlendem Delimiter →
  unbegrenztes Puffer-Wachstum ([TcpSocketActor.ts:147](src/io/broker/TcpSocketActor.ts)).
  `length-prefixed` ist korrekt geguarded.
- **BRK-2 (MITTEL):** SSE-Client puffert Events ohne Cap ([SseActor.ts:86](src/io/broker/SseActor.ts)).
- **BRK-3 (NIEDRIG):** MQTT-Codec `JSON.parse` ohne App-Cap (lazy, broker-begrenzt)
  ([MqttCodec.ts:92](src/io/broker/MqttCodec.ts)).
- **BRK-4 (INFO):** gRPC-Server Default `insecure`, keine Msg-Size-Konfig, Metadata verworfen
  ([GrpcServerActor.ts:110](src/io/broker/GrpcServerActor.ts)).
- **BRK-5 (INFO):** UDP bindet default `0.0.0.0` ([UdpSocketActor.ts:39](src/io/broker/UdpSocketActor.ts)).

---

## Management-HTTP

### #8 — NIEDRIG/INFO: Read-only Endpunkte ohne Auth-Default

Destruktive Endpunkte (`/cluster/down`, `/cluster/leave`) sind korrekt standardmäßig **aus** und
auth-fähig ([HttpManagement.ts:139,203](src/management/HttpManagement.ts)). `/cluster/members|
leader|shards` sind ohne `auth`/`ipAllowlist` offen → Topologie-Leak. **Remediation:** Doku +
`ipAllowlist`-Empfehlung.

---

## Verifizierte Stärken

- **HMAC-Integrity** ([Integrity.ts](src/persistence/object-storage/Integrity.ts)): korrektes
  `constantTimeEqual`, 128-Bit-Tag, separater Key.
- **BearerTokenAuth** ([BearerToken.ts:80](src/http/middleware/BearerToken.ts)): constant-time,
  iteriert alle Tokens (nur minimaler Token-Längen-Leak).
- **IpAllowlist** ([IpAllowlist.ts:61](src/http/middleware/IpAllowlist.ts)): `remoteAddress`,
  vertraut `x-forwarded-for` bewusst **nicht**, fail-closed.
- **Express/Fastify-Body-Limits** (Stream+Cap vor Pufferung / 1 MiB-Default).
- **WS-Auth** läuft vor dem Upgrade; Route-Komposition fail-closed via `WS_ACCEPT`-Sentinel
  ([Route.ts:205](src/http/Route.ts)).
- **gRPC-`protoPath`** = Operator-Config (kein Arbitrary-File-Read).
- **Frame-Cap** (16 MiB) + Hello-Hijack-Schutz im Cluster-Transport; **Version-Skew-Cap** gegen
  Permanent-Down-Exploit; **Snapshot-Seq-Validierung**; **crypto.randomUUID** für Ask-IDs.
- **Re-Encryption-Sweep** ([reEncryptionSweep.ts](src/persistence/object-storage/reEncryptionSweep.ts)):
  `If-Match`-CAS, Keyring-Completeness-Check.

---

## Remediation-Roadmap / Status

**Behoben** (Branch `features/security-hardening`, je Fix + Test + CHANGELOG):
WS-1, WS-2, WS-3, WS-4, WS-6, HTTP-1, HTTP-2, HTTP-3, HTTP-4, BRK-1, BRK-2, #3, #6, #9.
**Teilweise:** WS-5 (Admission-Cap `maxConnections` behoben; Handshake/Idle-Timeout +
Hub-Mailbox-Bounding offen).

**Offen:**
- WS-5-Rest (Handshake/Idle-Timeout, Mailbox-Bounding) — Per-Backend-Upgrade-Timeout + Mailbox-Konfig.
- **#5** (Cluster-Handshake-Timeout/Conn-Limit) — Timer-Lifecycle; im Netzmodell gemindert.
- **#7** (AES-GCM-AAD) — weitgehend durch HMAC-Integrity (#116) gemindert.
- **#2 (SSRF):** akzeptiert unter dem Netzmodell — Gegenmaßnahme = #1/#4; kein separater Fix (siehe #2).
- **#8** (Management-Read-only-Doku), Doku-Erwähnungen HTTP-4 `identity` / #3 `maxOutputBytes` / BRK-3/4/5.

**Netzmodell:** #1 (opt-in Auth) + #4 (mTLS) als Betriebsanforderung + Doku.

## Methodik

Statische Analyse mit adversarialer Nachverfolgung der Trust-Boundaries; zwei fokussierte
Deep-Audit-Durchläufe (WebSocket-Stack; HTTP-Backends/Broker/Middleware); Eigenverifikation aller
HIGH/MEDIUM-Befunde an `Datei:Zeile`. Kein dynamisches Fuzzing, keine Abhängigkeits-CVE-Prüfung
(separat via `bun audit` empfohlen).
