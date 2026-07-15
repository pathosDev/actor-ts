# Changelog

All notable changes to this project follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is a pre-1.0 hobby project — every minor version is potentially
breaking.  See `ROADMAP.md` for what's coming, and `README.md` →
"What's in here / What isn't" for current scope honesty.

## [Unreleased]

### Changed

- **TypeScript 7 — the native compiler** (#361).  The `typescript`
  devDependency moved from 6.0.3 to **7.0.2**, Microsoft's ground-up native
  (Go) port of the compiler that replaces the JavaScript-based `tsc`.  The
  npm package now ships a platform-specific native binary
  (`@typescript/typescript-win32-x64` etc.).  For this repo the switch was
  drop-in: no source or `tsconfig` changes were needed, `bun run typecheck`
  is clean and the full test suite passes.  The payoff is speed — a full
  `tsc --noEmit` over the repo dropped from **~6.5 s (6.0.3) to ~1.0 s
  (7.0.2)** on the same machine.  TypeScript is a devDependency only, so
  nothing changes for consumers of the published package.
- **`@fastify/static` 9.3.0 → 10.1.0** (#362) — devDependency used by the
  Fastify HTTP backend examples/tests; no code changes required.
- **CI: `actions/setup-node` 6 → 7** (#363) in the docs, multi-runtime, and
  publish workflows.

## [0.11.0] — 2026-07-15

### Changed — Naming conventions: no abbreviations, unified vocabulary

Repo-wide naming sweep for consistency.  Pre-1.0, so these are hard
renames with no deprecation shims.  All are mechanical — same behavior,
new names.

- **BREAKING — WebSocket → `Websocket` (single-cap), no `Ws` abbreviation.**
  Every identifier and file/dir uses the `Websocket` spelling:
  `WebSocketServerActor`/`WebSocketClientActor` → `WebsocketServerActor`/
  `WebsocketClientActor`; the `Ws*` supporting types (`WsConnection`,
  `WsCodec`, `WsFrame`, `WsServerMessage`, …) → `Websocket*`; `wsSend()` →
  `websocketSend()`; `DEFAULT_WS_MAX_FRAME_BYTES` →
  `DEFAULT_WEBSOCKET_MAX_FRAME_BYTES`; the module moved
  `src/http/ws/` → `src/http/websocket/`.  The `websocket()` routing
  directive, the global `WebSocket`, the `ws` package's `WebSocketServer`,
  and the `Sec-WebSocket-Protocol` header are unchanged.
  *Migration:* replace `Ws`/`WebSocket` identifier prefixes with
  `Websocket`; `wsSend` → `websocketSend`.
- **BREAKING — abbreviations spelled out** in type/member names: `*Cmd` →
  `*Command`, `*Msg` → `*Message`, `*Ack` → `*Acknowledgment`, `ByPid*` →
  `ByPersistenceId*`, `*Impl` → `*Implementation`, `*Ctor` → `*Constructor`.
  Wire/discriminator string literals are unchanged.
  *Migration:* e.g. `MqttCmd` → `MqttCommand`, `EnvelopeMsg` →
  `EnvelopeMessage`, `SubscribeAck` → `SubscribeAcknowledgment`.
- **BREAKING — testkit assertions spelled out too:** `TestProbe.expectMsg()`
  → `expectMessage()`, `TestProbe.expectMsgType()` → `expectMessageType()` —
  the last `Msg` holdouts, now consistent with `expectNoMessage()`.
  *Migration:* rename the calls; signatures and behavior are unchanged.
- **BREAKING — one config vocabulary: `Options`, never `Settings`.**
  Remaining `*Settings` types → `*OptionsType` (`CircuitBreakerSettings`,
  `TlsTransportSettings`, `Bounded/PriorityMailboxSettings`,
  `ManagementRoutesSettings`, `ConsumerControllerSettings`,
  `KeepMajoritySettings`, the testkit specs); `BrokerSettings.ts` folded
  into `BrokerOptions.ts` (`BrokerSettingsError` → `BrokerOptionsError`);
  the `BrokerActor` glue `readSettingsFromConfig`/`requiredSettings`/
  `builtInDefaults`/`settings` → `readOptionsFromConfig`/`requiredOptions`/
  `builtInDefaultOptions`/`options`; `default{FailureDetector,PhiAccrual}Settings`
  → `default*Options`.  New dedicated `ConsumerControllerOptions` +
  `KeepMajorityOptions` files with builders.
- **BREAKING — Command vs Signal unified on `kind`.**  MQTT and WebSocket
  internal mailbox signals are now `kind`-tagged plain objects (dispatched
  by `kind`, like the typed-actor `Signal`), not `instanceof`-dispatched
  classes; the bad-payload hook is `onInvalidMessage` everywhere (MQTT's
  `onDecodeError` is gone); `WebSocketAcceptSignal` → `WebsocketAcceptCommand`
  and `WebsocketClientSend` is a command, both lifted out of the `*Signal`
  unions.
  *Migration:* override `onInvalidMessage` instead of `onDecodeError`;
  construct outbound sends via `websocketSend(msg)` (unchanged).
### Added — Options validation

- **`OptionsValidator` + `OptionsError`** (#274) — a declarative-but-code
  validator layer for the `XOptions` pattern.  Each options file with
  constrained fields exports an `XOptionsValidator` (`extends
  OptionsValidator<XOptionsType>`, brokers via `BrokerOptionsValidator`) whose
  `rules(s)` uses typo-checked, no-op-on-`undefined` helpers (`port`,
  `positiveNumber`, `positiveInt`, `nonNegativeInt`, `oneOf`, `nonEmptyString`,
  `url`, …) plus `fail(field, reason, value)` for cross-field rules.  Validation
  runs **once at consume time on the merged settings**, so builder, plain-object,
  and HOCON inputs are all checked and cross-field rules see the final values —
  broker actors via the `optionsValidator()` hook (in `preStart`, after the
  required-field check), non-broker consumers via one
  `new XOptionsValidator().validate(settings)` call in their constructor.
- **Validators shipped for**: every broker (MQTT, Kafka, AMQP, Redis Streams,
  NATS, JetStream, SSE, TCP, UDP, gRPC client) and the WebSocket client; the
  cluster core (`Cluster`, `ClusterBootstrap`, `FailureDetector`, `PhiAccrual`,
  `ClusterClient`, `ClusterClientReceptionist`, `StaticQuorum`, `KeepReferee`,
  `LeaseMajority`, `ClusterRouter`), sharding (`Sharding`, `StartSharding`,
  `ShardedDaemonProcess`) and singleton (`StartSingleton`); discovery
  (`AutoDiscovery`, `ConfigSeedProvider`, `DnsSeedProvider`,
  `KubernetesApiSeedProvider`, `Receptionist`) and gossip intervals
  (`DistributedPubSub`, `DistributedData`); leases (`Lease`, `KubernetesLease`);
  caches (`RedisCache`, `MemcachedCache`, `CachedSnapshotStore`); the
  `CassandraJournal` and S3 / filesystem object-storage backends; the
  Express/Hono HTTP backends; `WorkerCluster`; delivery `ProducerController`;
  and `TestProbe`.  Options whose fields carry no real constraint
  (all-boolean/string/callback, or degrade-gracefully knobs like snapshot
  `keepN` where `<= 0` means "keep all") intentionally get no validator.

### Changed — Options validation

- **BREAKING** (#274) — invalid **option values** now throw `OptionsError` at
  construction / actor start instead of a bare `Error` (or, previously, going
  unchecked on the builder/plain-object path).  Notably MQTT `protocolVersion`
  outside `{4, 5}` now throws `OptionsError` on **all** input paths (previously
  only the HOCON path threw, as a bare `Error`).  *Migration:* catch
  `OptionsError` (exported from the package root) where you previously matched
  the ad-hoc `Error` message.  Missing **required** broker settings still throw
  `BrokerOptionsError`; malformed HOCON still throws `ConfigError`.
- **BREAKING — `InMemoryCache` joins the `XOptions` family.** It now takes an
  `InMemoryCacheOptions` builder (or plain object) with `withMaxEntries` /
  `withCleanupMs`, validates via `InMemoryCacheOptionsValidator` (out-of-range
  values throw `OptionsError` instead of a bare `Error`, and `cleanupMs` — a
  negative / `NaN` sweep interval — is now checked too), and reads its defaults
  from HOCON `actor-ts.cache.in-memory.{maxEntries, cleanupMs}` via the
  `CacheExtension` (previously the bounds were unreachable through the
  extension).  The internal `InMemoryCacheSettings` interface is **removed** —
  use `InMemoryCacheOptionsType` (both `InMemoryCacheOptions` and the type are
  now exported from the package root).  *Migration:* a plain
  `{ maxEntries, cleanupMs }` object still works unchanged; only the type name
  changed.
- **WebSocket route / policy options are now validated.** The resolved
  per-connection policy (`maxFrameBytes`, `maxBufferedBytes`, `maxConnections`,
  and the `onOversizeFrame` / `onInvalidMessage` / `onBackpressure` enums) is
  checked on every path — route options, HOCON `actor-ts.http.websocket`, and
  defaults — via `WebsocketPolicyOptionsValidator`, and `allowedOrigins` via
  `WebsocketRouteOptionsValidator`.  Bad values throw `OptionsError` (the enum
  guard previously threw a bare `Error`, and only on the HOCON path; the
  numeric knobs — e.g. `maxConnections: 0`, which silently admitted nobody —
  were unchecked).  The reference config now ships an `actor-ts.http.websocket`
  section documenting the defaults.
- **The object-storage decompression cap is now a store option.** The 512 MiB
  decompression-bomb guard (#3) was pinned to its default because the stores
  called `decodeBody` without a cap.  `withMaxDecompressedBytes` is now on
  `ObjectStorageSnapshotStoreOptions`, `ObjectStorageDurableStateStoreOptions`,
  and `ObjectStoragePluginOptions` (validated at construction — a non-positive
  / non-integer cap throws `OptionsError`, `Infinity` opts out), and both
  stores forward it into `decodeBody`.  Raise it to restore a legitimately
  large snapshot / state blob, or lower it for a tighter bound.
- **HTTP middleware + directives now validate their options.** Added
  `OptionsValidator`s for `TimeoutOptions` (`ms`), `HstsOptions` (`maxAge` plus
  the preload cross-field), `CorsOptions` (`maxAge` plus credentials-vs-`*`),
  `CsrfOptions` (present-secret length, cookie `sameSite` / `maxAgeSeconds`),
  and `StaticFilesOptions` (`maxFileSize`, `dotfiles` / `symlinks` enums); the
  ad-hoc bare-`Error` validity checks in the consumers now throw `OptionsError`
  (required-field guards stay as-is).  `rateLimit` and `idempotent` also gained
  the real `RateLimitOptions` / `IdempotencyOptions` fluent builders they were
  already documented to have, each with a validator (`windowMs`/`max`,
  `ttlMs`/`missingHeader`); the plain-object call form is unchanged.
- **`CircuitBreaker` and `BoundedMailbox` now validate their options too** —
  the last exported options types with real numeric constraints join the
  validator family.  `CircuitBreakerOptionsValidator` checks `maxFailures`
  (integer >= 1), `resetTimeoutMs` (finite >= 0), and the previously-unchecked
  `callTimeoutMs` (> 0 — omit it to disable the per-call timeout; `0`, which
  previously meant "no timeout" silently, now throws), and requires
  `maxFailures`/`resetTimeoutMs` at runtime (a builder without them previously
  produced a breaker that silently never opened).
  `BoundedMailboxOptionsValidator` checks `capacity` (integer >= 1, and now
  required — previously a missing `capacity` made the "bounded" mailbox
  silently unbounded) and the previously-unchecked `overflow` enum.  The old
  ad-hoc bare-`Error` guards now throw `OptionsError`.

### Added — HTTP hardening

- **Scoped error handling + fallback routes** (#352) — `handleErrors(handler,
  child)` catches exceptions from a subtree (akka-http `ExceptionHandler`
  style; sees the original error, returns a response or `null` to decline);
  `fallback(handler)` answers any unmatched request via each backend's
  not-found hook; `ServerBuilder.withErrorHandler(...)` is the server-wide
  last resort.  Precedence, uniform across Fastify/Express/Hono: innermost
  `handleErrors` → `withErrorHandler` → framework default.
- **HTML response utilities** (#352) — `escapeHtml`, an auto-escaping `html`
  tagged template with a `SafeHtml` brand, `rawHtml` escape hatch, and
  `completeHtml` (`text/html` + `nosniff`).
- **Security-middleware suite** (#353) — `cors` (a route directive that the
  compiler expands into per-pattern preflight `OPTIONS` routes),
  `strictTransportSecurity` / `hsts`, `contentSecurityPolicy`,
  `csrfProtection` + `requireSameOrigin`, `securityHeaders`, `requestId`,
  `BasicAuth`, and `requestTimeout` — each with an `XOptions` builder.  Plus
  public `parseCookies` / `serializeCookie` helpers.
- **Static file serving** (#354) — `getFromFile`, `getFromDirectory`, and
  `getFromBrowseableDirectory`: MIME detection, index resolution, conditional
  requests (weak ETag + `Last-Modified` → 304), single `Range` (206/416),
  HEAD, trailing-slash redirects, and XSS-safe directory listings.
- **MIME-type registry** (#354) — `contentTypeFor(pathOrExt, overrides?)` and
  `DEFAULT_MIME_TYPES`.
- **Streaming response bodies** (#354) — `HttpResponse.body` now accepts a web
  `ReadableStream<Uint8Array>`, written natively by all three backends.

### Changed — HTTP hardening

- **`Middleware` `next()` accepts an optional request override** (#353) —
  `next(req?)` lets a middleware enrich what the handler sees (request-id,
  CSRF token).  Backward compatible.
- **HonoBackend now answers `HEAD` on `GET` routes** (#354), matching
  Fastify/Express; a route pattern ending in `/*` exposes the remainder as
  `req.params['*']` on every backend.
- **BREAKING:** the `Route` / `CompiledEndpoint` unions gain `fallback` and
  `cors` variants — an exhaustive `match` over `Route` must handle them
  (#352, #353).
- **BREAKING:** `ServerBuilder` gains a required `withErrorHandler` method —
  structural third-party implementers must add it (#352).
- **BREAKING:** `HttpError`'s constructor gains an optional 4th `headers`
  parameter (after `extra`); `BearerTokenAuth` 401s now expose the challenge
  on `err.headers['www-authenticate']`, no longer `err.extra.wwwAuthenticate`
  (#352).

### Security

- **CORS, CSRF, and security-header middleware** (#353) — origin allowlisting
  with correct preflight handling, an HMAC-signed double-submit CSRF token
  (plus an Origin/Referer check), and HSTS / CSP / COOP / CORP / nosniff /
  frame-options; secret comparisons are constant-time.
- **`WWW-Authenticate` reaches the wire** (#353) — `BearerTokenAuth` (and the
  new `BasicAuth`) 401s emit a real challenge header instead of burying it in
  the body.
- **Hardened path-traversal defence for static files** (#354) — the URL
  remainder is fully decoded before validation, every segment is rejected if
  it is `..`, empty, NUL, a backslash, or a `:` (drive/ADS) segment, absolute
  forms are refused, the joined path is confined to the root, symlink escapes
  are refused, and dotfiles are denied — every rejection a uniform 404.

- **WS-1 (HIGH) — WebSocket upgrade crash hardened**.
  A malformed percent-escape in the upgrade path (e.g. `GET /room/%ZZ` against a
  `websocket('/room/:id', …)` route) made `decodeURIComponent` throw inside the
  Express backend's fire-and-forget upgrade handler, surfacing as an *unhandled
  rejection* — process-fatal under Node's default and reachable **pre-auth** by
  an unauthenticated client.  `matchWebsocketPattern` now treats a malformed escape as
  a non-match (→ 404), and the Express upgrade handler attaches its socket
  error-guard before any async work and wraps the handler in a last-resort
  `.catch` that closes the socket.  Fastify/Hono were not affected.
- **WS-2 (HIGH) — Cross-Site WebSocket Hijacking (CSWSH) defence**.  No upgrade handler validated the `Origin` header, so a
  malicious web page could open an authenticated WebSocket riding a victim
  browser's ambient cookie/IP auth.  New **`allowedOrigins`** option on
  `websocket()` routes (`.withAllowedOrigins([...])` on the builder): an upgrade
  whose `Origin` is present but not listed is rejected with 403 before the
  handshake on all three backends; a missing `Origin` (non-browser client) is
  allowed.  Bearer-token auth was already resistant (browsers can't set
  `Authorization` on a WS handshake).
- **HTTP-1 (MEDIUM-HIGH) — Hono body-size cap enforced before buffering**.  The Hono backend read the whole request body via
  `arrayBuffer()` and only then compared it against `maxBodyBytes`, so the cap
  was cosmetic — the real ceiling was the runtime's native default (128 MiB on
  Bun, effectively unbounded on Node via `@hono/node-server`).  It now rejects
  an oversized `Content-Length` with 413 *before* buffering; the post-buffer
  check remains a backstop for chunked bodies that omit Content-Length.
  Express (streaming cap) and Fastify (framework default) were unaffected.
- **HTTP-2 (MEDIUM-HIGH) — `InMemoryCache` is now bounded (LRU)**.  The default in-process cache was an unbounded `Map`
  with lazy expiry only, so a flood of distinct attacker-chosen keys
  (`Idempotency-Key`; rate-limit keys — idempotency additionally stores the
  full response body for 24 h) grew it without limit → RAM exhaustion.  It now
  accepts `{ maxEntries?, cleanupMs? }` (defaults `10_000` / `60_000`): a new
  key beyond the cap evicts the least-recently-used entry, and a background
  sweep reclaims expired entries.  *Behaviour change:* the default
  is now bounded — pass `maxEntries: Infinity` for the previous unbounded
  behaviour (documented OOM risk).  Options / validation / HOCON plumbing for
  these fields landed as the `InMemoryCacheOptions` follow-up (see *Changed —
  Options validation*).
- **WS-6 (LOW) — CRLF stripped from raw upgrade-reject headers**.  `writeRawHttpResponse` (the Express pre-handshake
  reject path) wrote app-supplied header names/values verbatim onto the raw
  socket, so an `authorize` guard echoing attacker-influenced data into a
  header could split the response.  CR/LF are now stripped from header names
  and values.
- **#9 (hardening) — JSON deserialization ignores the `__proto__` setter**
 .  `JsonSerializer` and the cluster ref decoder
  now define a decoded `"__proto__"` key as an own data property instead of
  assigning through the prototype setter, so a hostile payload can't change
  the decoded object's prototype.
- **BRK-1 / BRK-2 (MEDIUM) — inbound buffer caps for TCP `lines` + SSE**.  A hostile / MITM'd upstream could stream bytes with no
  frame delimiter, growing the inbound buffer without bound.  The TCP `lines`
  framer now rejects an un-terminated remainder that already exceeds
  `maxLineLen` (matching the existing terminated-line check), and the SSE
  client caps its pending event buffer at 1 MiB — both drop the connection
  instead of buffering forever.  (`length-prefixed` TCP framing was already
  bounded.)
- **#6 (LOW) — consistent SQL/CQL identifier validation**.  Postgres/MariaDB already validated table identifiers,
  but SQLite (journal + snapshot store) and Cassandra (keyspace + table names,
  interpolated into CQL) did not.  A shared `assertSafeIdentifier`
  (`/^[A-Za-z_][A-Za-z0-9_]*$/`) is now applied across all four, so a
  config-sourced identifier can't inject SQL/CQL.  Data values were, and
  remain, bound parameters.
- **HTTP-3 (docs) — rate-limit examples key on the socket peer, not
  `x-forwarded-for`**.  The shipped `rateLimit`
  examples taught keying on the client-settable `x-forwarded-for` header, which
  an attacker rotates per request to bypass the limit (and which collapses all
  header-less clients into one shared bucket).  The JSDoc and the bilingual
  docs now use `req.remoteAddress` and state the trusted-proxy caveat.  No
  behaviour change — `key` was always caller-supplied.
- **#3 (MEDIUM) — decompression-bomb cap on stored bodies**.  Reading a snapshot / durable-state / object body
  decompressed it with no output bound, so a tampered or hostile compressed
  blob (a few KB expanding to many GB) could OOM the process on recovery.
  `decodeBody` now caps the decompressed size at **512 MiB** by default
  (`DecodeOptions.maxOutputBytes`; `Infinity` opts out): gzip enforces it at
  allocation time via zlib's `maxOutputLength`, and every path asserts the
  decoded size as a portable backstop.
- **HTTP-4 (MEDIUM) — idempotency responses can be scoped per caller**.  The idempotency cache keyed only on the
  `Idempotency-Key` header plus a method/path/body fingerprint, so two callers
  reusing the same key for the same request shape shared one cached response —
  a cross-user disclosure when the response is identity-specific (e.g. carries
  `Set-Cookie` or the first caller's data).  New opt-in `identity: (req) =>
  string` folds the authenticated principal into the cache key so responses are
  partitioned per caller.  (Same-key-different-body poisoning was already
  rejected with 422.)
- **WS-4 (MEDIUM) — WebSocket backpressure works on the Hono backend**.  The Hono socket adapter didn't implement
  `bufferedAmount`, so the connection actor's `maxBufferedBytes` /
  `onBackpressure` guard was a no-op on Hono — a slow / idle-reading client
  could grow the outbound send buffer without bound (OOM).  The adapter now
  surfaces the send-buffer depth from the native socket (Bun
  `getBufferedAmount()`, Node/Deno numeric `.bufferedAmount`).
- **WS-3 (MEDIUM) — cap the WebSocket transport frame size (Express + Fastify)**
 .  The `ws`-backed backends left the transport at the
  `ws` default `maxPayload` (100 MiB), so an oversized frame was buffered in
  full before the app-level `maxFrameBytes` (1 MiB default) rejected it —
  allocation-amplification DoS.  Both now pass `maxPayload:
  DEFAULT_WEBSOCKET_MAX_FRAME_BYTES` (1 MiB), so an oversized frame is rejected at the
  protocol level.  *Caveat:* on these backends a route that raises
  `maxFrameBytes` above the default is currently still capped at the default by
  the transport; a per-route / configurable transport cap and the Hono
  runner-level cap are tracked follow-ups.
- **WS-5 (MEDIUM, partial) — per-route WebSocket connection admission cap**
 .  New opt-in `maxConnections` on `websocket()`
  routes (`.withMaxConnections(n)`, or `actor-ts.http.websocket.maxConnections`
  in HOCON): a new upgrade beyond the cap is closed with 1013 in the shared
  wiring layer before an actor is wired for it, and the live count decrements
  when a connection closes.  Default: unlimited (behaviour unchanged).  The
  other WS-5 sub-parts — a handshake/idle timeout and hub-mailbox bounding —
  remain tracked follow-ups.

### Documentation

- Moved the Server-WebSocket page from the IO section into the HTTP section
  (#351).
- Reconciled stale API-reference pages with the shipped code (#360): rewrote the
  persistence adapter & migration pages and the OTel **tracing** adapter page to
  the function-based APIs, rewrote the management & health-check and cache &
  durable-data pages to their real APIs, and removed the page for the
  never-shipped OTel *metrics* adapter.
- Repointed stale `*Settings` type names in prose to the `*OptionsType`
  vocabulary (#349).
- Fixed broken code samples that declared a `const` inside a call's object
  literal (#359).

## [0.10.0] — 2026-07-08

### Added — Typed WebSocket & MQTT

- **Typed WebSocket routing** (#1) — a `websocket(path, actorRef)` directive
  in the HTTP routing DSL binds a `WebSocketServerActor<TOut, TIn>`.  The
  hub receives codec-decoded messages (JSON by default; `rawCodec()` for
  binary), replies to the sending connection with `this.reply(...)` or
  fans out with `this.broadcast(...)`, and gets `onClientConnected` /
  `onClientDisconnected` / `onInvalidMessage` hooks.  The framework spawns
  an internal session actor per connection and solves the first-frame
  race by construction (listeners attach synchronously at upgrade; the
  mailbox is the buffer).  Works on all three HTTP backends — Fastify
  (`@fastify/websocket`), Express (`ws` upgrade handling), and Hono
  (per-runtime: Bun/Node/Deno).  `withMiddleware(...)` runs at upgrade
  time, so `BearerTokenAuth` / `IpAllowlist` gate the handshake.
- **`WebSocketClientActor<TOut, TIn>`** (#1) — the typed client half, built
  on `BrokerActor`: reconnect-with-backoff, outbound buffering across
  reconnects, circuit breaker, and HOCON settings.  Other actors push a
  typed send with `ref.tell(wsSend(msg))`.
- **`actor-ts.http.websocket` HOCON block** — server-side WebSocket
  defaults (`maxFrameBytes`, `onOversizeFrame`, `onInvalidMessage`,
  `maxBufferedBytes`, `onBackpressure`); route options override HOCON,
  which overrides built-in defaults.
- **Subclass-first, typed `MqttActor<T, TSelf>`** (#345) — the MQTT
  counterpart to `WebSocketClientActor`.  Extend it, declare
  subscriptions in the constructor with `this.subscribe(topic, { qos })`,
  handle inbound traffic in `onMessage(msg)`, and publish with
  `this.publish(topic, payload)`.  Lifecycle events (inbound / connected /
  disconnected) run on the actor thread via the mailbox.  Hooks:
  `onMessage`, `onConnected`, `onDisconnected`, `onDecodeError`,
  `onSelfMessage`.  Still externally controllable via
  `ref.tell({ kind: 'publish' | 'subscribe' | 'unsubscribe', … })`.
- **`MqttOptions` fluent builder** (#345) — `MqttOptions.create()
  .withBrokerUrl(…).withClientId(…).withQos(…)…`; feeds the same
  three-layer settings merge (constructor > HOCON
  `actor-ts.io.broker.mqtt` > built-in defaults).  (As of #346/#348 this is
  the primary way to construct; a plain `MqttOptionsType` object works too —
  see the options note under *Changed*.)
- **Typed MQTT payloads** (#345) — inbound `MqttMessage<T>` carries a
  lazily-decoding `MqttPayload<T>` (`.bytes` / `.text()` / `.entity<U=T>()`,
  successes cached).  A pluggable `MqttCodec<T>` seam (default
  `mqttJsonCodec()`) decodes `entity()` and encodes non-string publishes;
  `publish(topic, { … })` encodes an entity, `publish(topic, string |
  Uint8Array)` sends raw bytes.  Decode failures surface via
  `onDecodeError`.  `MqttClientLike` / `MqttModuleLike` are exported as
  test seams for the `mqttModule()` override.

### Changed — Options overhaul & MQTT

- **Fluent options, framework-wide** (#346, #348) — every configurable
  constructor and factory takes a fluent options builder **or** a plain
  settings object, interchangeably: `new MqttActor(MqttOptions.create()
  .withClientId('x'))` behaves identically to `new MqttActor({ clientId:
  'x' })`.  A builder *is* its settings — `OptionsBuilder` stores each field
  as an own property, so a builder instance reads and spreads exactly like a
  plain settings object (no separate resolve step; consumers just read the
  argument).  Each configurable type exposes **three names from one
  `XOptions.ts` file**: `XOptionsType` (the plain object), `XOptionsBuilder`
  (the fluent builder, `XOptions.create().withField(…)`), and `XOptions` — the
  **union** of the two that every consumer signature accepts (`options:
  XOptions`), plus a value alias so `XOptions.create()` keeps working.  There
  is no separate "Settings" concept (the former `XSettings` interface is now
  `XOptionsType`, co-located in `XOptions.ts`).  HOCON resolution is
  unchanged — the builder / plain object only supplies the
  highest-precedence explicit layer, and unset fields still fall through
  to config then defaults.  Naming lockstep with no divergence: builder
  method `withX` ⇔ settings field `x` ⇔ HOCON leaf `x`.  Affected
  (non-exhaustive): `ActorSystem.create(name, ActorSystemOptions
  .create()…)`; `TestKit.create` / `new TestProbe` (`TestKitOptions` /
  `TestProbeOptions`); every broker actor (`MqttOptions`, `KafkaOptions`,
  `AmqpOptions`, `NatsOptions`, `JetStreamOptions`, `RedisStreamsOptions`,
  `SseOptions`, `TcpSocketOptions`, `UdpSocketOptions`, `GrpcClientOptions`,
  `GrpcServerOptions`); HTTP/WS (`WebSocketClientOptions`,
  `WebSocketRouteOptions`, `ExpressBackendOptions`, `HonoBackendOptions`);
  cache (`RedisCacheOptions`, `MemcachedCacheOptions`); persistence
  journals / snapshot stores / durable-state stores / object-storage
  backends / projections / plugin registrations; cluster / sharding /
  singleton / client / pub-sub / router / downing / failure detectors;
  leases, seed providers + discovery, observability adapters
  (`OtelAdapterOptions`, `PromClientAdapterOptions`), `WorkerClusterOptions`,
  `DistributedDataOptions`, and `ProducerControllerOptions`.  Migration:
  `new X({ a, b })` still works, or use `new X(XOptions.create()
  .withA(a).withB(b))`; the positional "context" args that were never
  settings (a system name, a `Cluster`, a sharding entity + type name)
  stay positional.  **BREAKING** (pre-1.0 hard cut): the builder class
  `XOptions` is renamed `XOptionsBuilder` and the settings interface
  `XSettings` is renamed `XOptionsType`; `XOptions` is now the accepted-input
  union.  Everyday call sites — `XOptions.create()…` and plain objects — are
  unaffected; only code that referenced the old `XSettings` type name or the
  builder *class* by name needs updating.
- **BREAKING: renamed settings fields + HOCON keys** (#348) — to keep the
  builder-method ⇔ settings-field ⇔ HOCON-leaf names in lockstep, six
  fields were renamed: MQTT `defaultQos` → `qos` (`withQos`) and
  `keepAliveSec` → `keepAlive` (`withKeepAlive`); JetStream `ackTimeoutMs`
  → `ackTimeout`; ClusterClient `log` → `logger`; DistributedData
  `gossipIntervalMs` → `gossipInterval`; ProducerController
  `resendTimeoutMs` → `resendTimeout`.  Update any plain settings objects
  and HOCON keys using the old names.
- **BREAKING: `MqttActor` is now abstract** (#345) — you subclass it and
  override `onMessage` instead of spawning it directly and driving it only
  with `tell`.  Migration: `class MyClient extends MqttActor<T> { … }` and
  spawn the subclass.  A pure external-router setup needs a trivial
  subclass with an empty `onMessage`.
- **BREAKING: `MqttMessage.payload` is a `MqttPayload<T>` wrapper**, no
  longer a raw `Uint8Array` (#345).  Migration: `msg.payload` →
  `msg.payload.bytes`; `new TextDecoder().decode(msg.payload)` →
  `msg.payload.text()`; JSON reads → `msg.payload.entity()`.
- **BREAKING: `MqttOptionsType.subscriptions` and the `MqttSubscription`
  type are removed** (#345) — they were never HOCON-expressible (targets
  are actor refs).  Migration: move `subscriptions: [{ topic, target }]`
  into the subclass constructor as `this.subscribe(topic, { target })`, or
  send `ref.tell({ kind: 'subscribe', topic, target })`.
- **BREAKING: `subscribe`/`unsubscribe` command `target` semantics**
  (#345) — a `subscribe` command with no `target` now delivers to the
  actor's own `onMessage` (previously `target` was required).  An
  `unsubscribe` command with no `target` now removes only the *foreign*
  targets and leaves the actor's own subscription intact (previously it
  dropped the whole topic).

### Fixed — MQTT

- **MQTT runtime subscriptions are re-applied after a reconnect** (#345) —
  previously only the (now-removed) `settings.subscriptions` were
  re-subscribed on reconnect, so subscriptions added at runtime silently
  stopped receiving after a drop.  The unified registry is now re-applied
  on every (re)connect.
- **MQTT `subscribe` while disconnected reaches the broker on connect**
  (#345) — previously it updated only the local routing map and never
  issued the broker SUBSCRIBE.
- **MQTT terminated fan-out targets are cleaned up** (#345) — subscriber
  refs are deathwatched; when one stops it is pruned from the registry and
  a broker UNSUBSCRIBE fires once the pattern has no consumers left.

### Removed — legacy frame-level WebSocket API

- **BREAKING: the legacy frame-level WebSocket API** — `WebSocketActor`
  (client), `ServerWebSocketActor` (server bridge), and the
  `serverWebSocketActorOf` / `bunWebSocketHandlers` adapters are gone.
  They worked at the raw text/binary frame level and needed ~150 lines of
  backend-specific boilerplate to stand up a server.  Replace a
  `WebSocketActor` with `WebSocketClientActor`, and a hand-rolled server
  plugin with a `websocket(path, ref)` route + `WebSocketServerActor`.
  The client HOCON key `actor-ts.io.broker.websocket` is unchanged.

### Security

- **WebSocket DoS hardening carried into the new stack** (#1) — inbound
  frames are size-capped (`maxFrameBytes`, default 1 MiB) *before* the
  codec decodes them; oversize frames close 1009 (or drop) and
  undecodable frames close 1003 (or drop / hook) per policy.  Slow-consumer
  backpressure closes/drops past `maxBufferedBytes`.

- **DurableState revision tampering** (#116) — `ObjectStorageDurableStateStore.load()`
  previously trusted the `revision` value inside the body JSON, so an
  attacker with write access to the underlying bucket could roll back
  state past CAS checks.  Two-track integrity fix: encrypted bodies use
  AES-GCM with `revision` as AAD (already wired); unencrypted bodies
  gain an opt-in HMAC-SHA256 over `{ revision, etag }` with per-pid
  HKDF-derived subkeys.  Set `integrity: { mode: 'hmac-sha256', integrityKey }`
  on the store + `requireIntegrity: true` to refuse legacy un-tagged
  bodies on the read path.
- **ClusterClient ask-ID predictability** (#120) — `nextAskId()` used
  `Date.now() + counter`, predictable enough that a MitM on the
  TCP socket could pre-compute likely IDs and inject forged
  `cluster-client-reply` frames.  Switched to `crypto.randomUUID()`
  (122 bits of entropy per call).
- **Master-key rotation sweep race** (#109) — `reEncryptObjectStorage()`
  had no durable progress token, so a crash forced the resumed run
  to re-list and re-GET every object from scratch (a 24-hour sweep =
  a 24-hour wasted re-walk).  Worse: if the operator dropped a
  retired key from the keyring too soon, the sweep would only
  notice mid-corpus, leaving the bucket half-rewritten.  Added two
  opt-in options: `progress: ReEncryptProgressStore` for durable
  resume tokens (file/Redis/object-storage-backed) and
  `verifyKeyringCompleteness: boolean` (default `true`) for a
  pre-sweep sample that refuses to start when a body's key version
  is absent from `active`/`retired`.
- **LeaseMajority split-brain** (#142) — a slow `lease.acquire()`
  that the local defence-in-depth timeout had given up on could
  later resolve `true` and write `decision=surviveSet`, letting
  both sides of an equal partition claim victory.  Three layered
  fixes: (1) monotonic `acquireEpoch` so a late result with a
  stale epoch is dropped; (2) fire-and-forget `lease.release()`
  on abandon to undo any wire-side success after the local
  give-up, with fail-safe-on-rejection (refuse to claim majority
  on the same view); (3) optional fencing tokens — `Lease.acquireWithToken?():
  Promise<{ token: string } | null>` with `KubernetesLease`
  returning `<resourceVersion>/<leaseTransitions>` and
  `InMemoryLease` a monotonic per-name version stamp.

### Added — Persistence, HTTP & observability

- **PostgreSQL persistence backend** (#323) — `PostgresJournal`,
  `PostgresSnapshotStore`, and `PostgresDurableStateStore` (the first
  SQL-backed durable-state store) on top of the `pg` driver, registered
  via `registerPostgresPlugins(ext, …)` which selects the journal +
  snapshot store by config plugin ID and returns the durable-state-store
  handle (the object-storage-plugin pattern — `PersistenceExtension` has
  no durable-state registry).  Optimistic concurrency (per-pid
  `SELECT MAX(seq)` inside a transaction plus a primary-key
  unique-violation `23505` backstop; revision CAS via
  `ON CONFLICT`/`UPDATE … WHERE revision`), an indexed tags join table,
  and auto-created schema (`autoCreateTables`, default on).  `pg` is an
  optional peer-dependency, lazy-imported; the backend defines its own
  minimal client shapes so the framework stays dependency-free.  Ships
  with an in-process fake-pool unit suite and a live `postgres:latest`
  Docker suite wired into the integration-brokers CI matrix.
- **MariaDB persistence backend** (#324) — sibling of #323 for
  MariaDB / MySQL via the official `mariadb` connector: `MariaDbJournal`,
  `MariaDbSnapshotStore`, `MariaDbDurableStateStore`, and
  `registerMariaDbPlugins`.  A separate implementation with the MariaDB
  dialect (`?` placeholders, `INSERT IGNORE` for the tag dedup,
  `ON DUPLICATE KEY UPDATE` snapshot upsert, a derived-table-wrapped
  `keepN` prune, `ER_DUP_ENTRY`/1062 concurrency backstop, and
  `LONGTEXT`/`VARCHAR(255)`/`BIGINT` columns).  Optional `mariadb`
  peer-dep; in-process fake-pool suite + live `mariadb:latest` Docker
  suite in CI.
- **Configurable compression level** (#322) — `CompressionConfig` gains
  an optional `level` (gzip 0–9, zstd 1–22) threaded through the codec to
  the object-storage snapshot + durable-state stores.  Out-of-range values
  are clamped; the level is encoder-only and is NOT written to the wire
  (the ATS1 manifest records only the algorithm), so changing it needs no
  migration — old bodies keep decoding, new bodies use the new level, and
  the two mix freely in one bucket.
- **Real-network multi-node integration tests** (#313) — new
  `tests/integration/` subtree with a Docker-compose setup that
  brings up 5 cluster-node containers + 1 controller container
  on a shared bridge network and runs partition / heal /
  membership-convergence scenarios over a real TCP stack.  All
  fault injection happens inside each container's network
  namespace via `iptables` + `tc netem`, so no host privileged
  mode is required — just `NET_ADMIN` on each cluster-node
  container.  Two npm scripts ship: `bun run test:integration`
  (build + up + auto-exit on the controller's status) and
  `bun run test:integration:teardown`.  The same command works
  locally on Docker Desktop and in
  `.github/workflows/integration.yml`; the workflow is
  triggered by pushes to `main`, manual dispatch, and a nightly
  schedule.  Fifteen scenarios covering the cluster's load-bearing
  primitives:
  - **01** — membership convergence (smoke test)
  - **02** — 2:3 split-brain with partition + heal verification
  - **03** — Receptionist gossip-convergence over a shared
    `ServiceKey` across all 5 nodes, with partition + heal
  - **04** — DistributedData `LWWRegister` quorum reads/writes
    during a 50ms `tc-netem` egress latency storm — proves
    `majority`-consistency operations survive a real network
    slowdown
  - **05** — Cluster Singleton failover after the host node
    `cluster.leave()`s; new leader's manager spawns the
    singleton, proxies from every remaining node converge
  - **06** — Cluster Sharding rebalance: 30 entities warmed up,
    victim node leaves, 8 ex-victim entities relocate to
    surviving regions via the coordinator's HandOff path
  - **07** — Concurrent `GCounter` increments from all 5 nodes
    converge to the exact expected total (proves CRDT merge +
    `ddata-gossip` wire path under write pressure)
  - **08** — Receptionist `Subscribe` continuous-listing
    notifications fire on register / deregister, observable
    from every cluster node within gossip-propagation latency
  - **09** — External `ClusterClient` (NOT a cluster member)
    makes 100 sequential asks against `/user/echo`; exercises
    the #120 `randomUUID` ask-id path end-to-end
  - **10** — Management HTTP auth end-to-end: 401 without
    token, 200 with valid token, 404 with valid token + fake
    address, /health stays anonymous (probe contract)
  - **11** — `PersistentActor` event-sourcing + snapshot +
    replay: 5 increments → snapshot at seq=3 → kill → respawn
    triggers `recover()` → snapshot-load + replay restores
    state.  Two-kill cycle verifies determinism.
  - **12** — `DistributedPubSub` topic fan-out: 15 events
    published from two different nodes, all 5 subscribers
    receive both bursts in order
  - **13** — `CoordinatedShutdown` pipeline progresses through
    early (`BeforeServiceUnbind`) + late
    (`BeforeActorSystemTerminate`) phases on a victim node;
    markers POST'd to a peer observer verify both fired in
    chronological order
  - **14** — Bounded mailbox + `actor_mailbox_dropped_total`
    metric: bombard a slow actor with 15 000 messages, verify
    ~5 000 drops are counted in the Prometheus output with
    correct `{class, path, reason}` labels
  - **15** — `DnsSeedProvider` against docker's embedded DNS:
    resolves every peer hostname, validates IPv4 shape and
    `<systemName>@<host>:<port>` stamping
- **Backend `remoteAddress` wiring** (#312 follow-up) — the
  Fastify, Express, and Hono backends now populate
  `HttpRequest.remoteAddress` from the socket peer
  (`req.ip` / `req.socket.remoteAddress` on Fastify+Express;
  best-effort across `c.req.raw` / `c.env.requestIP` on Hono).
  `IpAllowlist` works end-to-end on real socket peers — the
  pre-existing `getClientIp` override is no longer required for
  default deployments behind direct connections.
- **HTTP route middleware framework** (#312) — new
  `withMiddleware(mw, route)` builder + `Middleware` type
  `(req, next) => Promise<HttpResponse> | HttpResponse`.  Middlewares
  compose outside-in; nested wraps run in declaration order.  The
  HTTP cache primitives (`rateLimit`, `idempotent`, `cached`) are
  unchanged, but new orthogonal concerns (auth, allowlists, custom
  logging, request tracing) can hang off the same hook.
- **`BearerTokenAuth({ tokens })`** (#312) — built-in middleware
  that 401s every request lacking a `Authorization: Bearer <token>`
  header from the configured (rotatable) shared-secret list.
  Constant-time comparison so an attacker probing tokens can't
  distinguish "first character wrong" from "last character wrong"
  by timing.  Rejection includes `WWW-Authenticate: Bearer realm=...`.
- **`IpAllowlist({ allow })`** (#312) — built-in middleware for
  CIDR-based network-level isolation.  Parses IPv4 + IPv6 CIDRs
  (including IPv4-mapped IPv6 like `::ffff:10.0.0.1` so a dual-
  stack socket peer matches an IPv4 CIDR).  Fail-secure: no
  resolvable client IP means 403.  Trust-source is explicit:
  default reads `req.remoteAddress` (the socket peer); operators
  behind a trusted proxy must opt-in to header trust via the
  `getClientIp` extractor.
- **`HttpRequest.remoteAddress?: string`** (#312) — optional new
  field on the request shape.  Backends should populate from the
  underlying socket where available.  Consumers that need to
  trust `x-forwarded-for` must do so explicitly (see
  `IpAllowlist`'s `getClientIp`).
- **`managementRoutes`** gains `auth`, `ipAllowlist`, and
  `authProtectHealth` settings (#312).  By default the auth
  middleware wraps the privileged subtree (`/cluster/*`,
  `/metrics`) but leaves `/health` and `/ready` anonymous —
  standard Kubernetes liveness/readiness probes can't easily
  attach an Authorization header.  Set `authProtectHealth: true`
  when the deployment can present credentials on probes.  The
  IP-allowlist wraps EVERYTHING (network-level isolation
  precedes any application policy).
- **`JsonLogger`** (#311) — structured-logging logger that emits one
  `\n`-delimited JSON object per record to `process.stdout` (or an
  injected `JsonLogSink`).  Every record carries `ts` (ISO-8601),
  `level`, optional `source`, `msg`, the merged static + dynamic
  MDC, and positional `...args` under an `args` array.  Errors
  serialise as `{ name, message, stack }`; circular refs,
  `BigInt`, and functions are sanitised so a log call never throws.
  Drop-in for log-aggregation pipelines (Loki, ELK, Datadog,
  CloudWatch, etc.) via the standard stdout-pipe path.
- **`otelLogger({ api })`** (#311) — bridge to
  `@opentelemetry/api-logs` for OTLP-Logs pipelines.  Optional peer
  dep (structural-typed on the OTel surface, like `otelTracer`).
  Maps severity to OTel's standard severity-number range, attaches
  the actor's path on `source`, merges static + dynamic MDC into
  `attributes`, and the SDK auto-links the active span's
  `traceId`/`spanId` when tracing is enabled in the same process.

### Changed — Bounded mailbox default

- **Bounded mailbox is now the default** (#310) — every actor spawned
  without an explicit `Props.withMailbox(...)` gets a
  `BoundedMailbox` with `capacity = 10_000` and `overflow = 'drop-head'`.
  The pre-#310 unbounded shape was a classic Akka-anti-pattern in
  disguise: a runaway producer could absorb the JVM, ahem, the V8
  heap, until OOM.  10 000 is high enough that a well-tuned actor
  never hits it on a normal traffic spike; if it does, the actor's
  throughput is mismatched and the bound makes that operationally
  visible.  Drops are emitted as the `actor_mailbox_dropped_total`
  Counter (labels `class`, `path`, `reason`).  Opt back into unbounded
  per-actor via `Props.withMailbox(() => new Mailbox())`; keep the
  bounded shape but change the capacity via `Props.withMailboxCapacity(n)`.

### Fixed — Compression

- **zstd compression on runtimes without native zstd** (#321) — the
  compression codec wired the `fzstd` peer-dependency as a compressor, but
  `fzstd` is decompression-only (it has no `compress`), so
  `compression: { algorithm: 'zstd' }` threw `fzstd.compress is not a
  function` on any runtime without native zstd (i.e. not Bun and not
  Node ≥22.15) — and the eager peer-dep probe passed anyway.  zstd
  resolution is now split by direction: compress is native-only with a
  clear "needs Bun / Node ≥22.15" error, decompress keeps the `fzstd`
  fallback so a non-native runtime can still READ zstd bodies written
  elsewhere, and `probeCompressionAvailability('zstd')` now checks the
  compress path so the misconfig surfaces at plugin-init, not on first
  persist.
- **Object-storage compression docs were inaccurate** — the docs
  described `gzip` / `brotli` / `deflate` with a `level` field and
  `Content-Encoding`-header-driven decode, none of which matched the
  implementation.  Corrected across EN + DE to the real `none` / `gzip` /
  `zstd` set, the ATS1-manifest-driven decode, the now-real `level`
  option, and the per-direction zstd runtime support.

## [0.9.1] — 2026-05-15

Docs-only patch release covering the first round of post-v0.9.0
publish feedback.

### Fixed

- README logo no longer 404s on the npmjs.com package page —
  switched from relative `./docs/public/logo.png` to an absolute
  `raw.githubusercontent.com/pathosDev/actor-ts/main/...` URL.
  Relative paths inside raw `<img>` tags aren't rewritten by
  npm's README renderer, only Markdown image syntax is.
- README license badge link similarly switched to an absolute
  `github.com/.../LICENSE` URL.
- README "## License" section text — said "MIT" left over from
  the original metadata-only declaration; corrected to
  "Apache 2.0" matching the v0.9.0 relicense.
- Sub-package READMEs (`benchmarks/`, `examples/chat/`,
  `examples/voice/`) referenced a non-existent `assets/logo.svg`
  path (the `assets/` folder never existed in this layout).
  Switched to the same absolute
  `raw.githubusercontent.com/pathosDev/actor-ts/main/docs/public/logo.svg`
  URL the root README now uses — consistent across every README
  and robust under any rendering target (GitHub, npm, mirrored
  forks).

## [0.9.0] — 2026-05-14

The "public-launch readiness" release.  Six workstreams accumulated
since v0.8.0 (142 commits total): the docs site goes live at
`actor-ts.dev` with 199+ pages and full German translation; a wave
of API shortcuts collapses the clustered-actor setup from 15–30
lines to a single `Cluster.bootstrap({ name })`; eight latent
security weaknesses get patched; a code-quality sprint closes 17
audit-catalog issues; the chat sample grows DMs / typing /
read-receipts / production-grade auth.

### Added — Quality-of-life API shortcuts

- `Cluster.bootstrap({ name })` — one-call setup that builds the
  `ActorSystem`, joins the cluster, starts the Receptionist, and
  wires `SIGTERM` / `SIGINT` shutdown.  Discovery defaults to an
  env-driven chain (`CLUSTER_SEEDS` → Kubernetes API → DNS) via
  the new `autoDiscovery()` builder so the same code runs
  single-node in dev and joins an existing cluster in production
  without a config change.
- `cluster.sharding` getter on `Cluster` — replaces the
  `ClusterSharding.get(system, cluster)` ceremony.  The static
  form still works for callers that need to reference the class
  from outside a `Cluster` handle.
- `ClusterSharding.start('cart', CartActor, { extractEntityId })`
  — class-shorthand overload that wraps the entity in
  `Props.create(() => new CartActor())` internally.  Factory form
  also accepted (`() => new CartActor(deps)`); full-form
  `start({ typeName, entityProps, ... })` stays valid.
- `ref.ask<TRes>(msg, timeoutMs?)` — method form of the ask
  pattern.  Auto-injects `replyTo: ref` on the message so
  recipients can read either `this.sender` or `msg.replyTo`
  without callers supplying it.  `OmitReplyTo<TMsg>` distributes
  across unions so the call site never has to satisfy the
  `replyTo` field.
- `system.spawnTyped(behavior, name)` +
  `system.spawnTypedAnonymous(behavior)` — method form symmetric
  to `spawn` / `spawnAnonymous`.  Same pair on `ActorContext` for
  typed-child creation from untyped parents.
- `system.http(port, { host?, backend? })` — Fastify-default HTTP
  shortcut.  Returns the same `ServerBuilder` as the explicit
  `system.extension(HttpExtensionId).newServerAt(...)` chain.
- `ActorSystem.create('app', { persistence: { journal,
  snapshotStore } })` — wire real persistence backends at creation
  time.  Either slot is independent; the in-memory default stays
  in place for the omitted slot.

### Removed — replaced by method forms

- Free function `ask(ref, msg, timeoutMs?)` — use
  `ref.ask<TRes>(msg, timeoutMs?)`.  Pre-1.0, no compat shim.
- Free functions `spawnTyped(system, behavior, name?)` and
  `spawnTypedChild(ctx, behavior, name?)` — use
  `system.spawnTyped(...)` / `ctx.spawnTyped(...)` (with
  anonymous variants).  Internal `Ask.ts` and
  `internal/PromiseActorRef.ts` modules deleted; ask impl
  inlined into `ActorRef.ts`.

### Security

Eight latent weaknesses patched.  All defenses are at the
deserialisation / boundary layer with regression tests pinning
both the attack vector and the legitimate path.

- **Wire-frame size cap** — `cluster/protocol` rejects frames
  claiming gigabyte+ lengths before allocation; defeats a
  4-GiB-claim memory-exhaustion DoS.  Configurable; `Infinity`
  cap remains the escape hatch.
- **Path-traversal block in `FilesystemObjectStorageBackend`** —
  keys containing `..` or absolute-path patterns rejected at the
  boundary instead of being resolved through to disk.
- **Memcached protocol injection** — `MemcachedCache` keys
  validated against the 250-byte / printable-ASCII rule before
  being placed on the wire; defeats injection via attacker-
  controlled keys.
- **Gossip-version cap against permanent-down exploit** —
  versions more than 24 h above the local wall-clock are
  rejected on the spot; previously a malicious peer could send
  `version: MAX_SAFE_INTEGER` to pin a healed node as `down`
  forever.
- **Snapshot-seq validation on recovery** — `PersistentActor`
  rejects snapshots whose `seqNr` is non-monotonic with the
  journal; defeats tampered-snapshot replay.
- **WebSocket inbound frame size cap** — `WebSocketActor`
  rejects oversized inbound frames before assembly; defeats
  memory-exhaustion DoS via fragmented frames.
- **Duplicate-identity hello rejection** — `cluster/transport`
  refuses a second hello frame claiming an already-connected
  identity; defeats peer-hijack where an attacker rebinds to a
  victim's `from` address.  Legitimate reconnect (after clean
  close) unaffected.
- **Idempotency-key cache binding** — `http/cache/idempotency`
  ties each cached response to the request fingerprint (method
  + path + body hash) so a poisoned key can't replay one
  response across different requests.

### Documentation

- **Public website at [actor-ts.dev](https://actor-ts.dev)** —
  Astro Starlight site under `docs/`, 199+ pages across the
  12-Part IA, full Quickstart + fundamentals + per-subsystem
  deep-dives + migration guides + API reference (TypeDoc).
- **Full German translation** — every page mirrored under
  `/de/`.  Seven additional UI locales (fr, es, ja, ko, pt-BR,
  ru, zh-CN) staged with sidebar labels translated; full content
  translations tracked as #300–#306.
- **Mermaid diagrams throughout** — replaces ASCII art across
  all subsystem pages (cluster, sharding, distributed-data,
  persistence, observability, operations, testing, IO, delivery).
- **Landing-page polish** — animated particle-network hero,
  prose-driven "What is actor-ts" cards, See-it-in-action status
  grid, custom-domain redirect, mobile-responsive splash.
- **Issue templates** — `.github/ISSUE_TEMPLATE/` gains
  `security_report.yml`; bug template gets a security-flag
  checkbox.
- `decodeCrdt` (`src/crdt/DistributedData.ts`) annotated as the
  codebase's reference shape for discriminator-union dispatch,
  with explicit notes on what makes the existing
  `const _exhaustive: never = json` pattern safe and when to
  prefer it vs `match().exhaustive()` (#231).

### Code-quality hygiene sprint

A focused refactor pass — no behavioural changes, no public-API
breaks, no new features.  Goal: more compile-time safety, fewer
duplicated literals, easier-to-write tests.  17 issues closed
(15 implemented + 2 auto-corrections from the audit catalog).

**Pattern-match exhaustiveness pass** — 9 discriminator-union
dispatch sites converted from if/else-or-switch to
`match(...).exhaustive()` so the TypeScript compiler refuses to
compile when a new variant is added to one of the unions without
a matching arm at the dispatch site.  Touches:
`BrokerActor.enqueueOutbound` state (#230),
`JetStreamActor` / `MqttActor` / `KafkaActor` cmd dispatch (#232,
#233, #234), `BackoffSupervisor` reset-policy + termination-trigger
(#240), `HoconParser` value-shape walk (#241), `Compression` codec
selection (#243), `BodyCodec` encode-compression (#244),
`PersistentActor` (#239 — see below).

**Foundational DRY helpers** (`src/util/`):
- `Constants.ts` — centralised duplicated defaults (gossip
  interval, ask timeout, tombstone TTL, seed-retry, etc.).  6
  named exports replace ~10 inline-literal sites across
  `Cluster`, `Receptionist`, `DistributedPubSubMediator`,
  `ClusterClient`, `ClusterClientReceptionist`, `DistributedData`
  (#257).
- `LazyImport.ts` — uniform peer-dep import + helpful "missing
  package" error.  Replaces ~7 lines × 6 broker actors of
  hand-rolled try/catch + bespoke install messages (#252).
- `WrapError.ts` — typed-error wrap helper with double-wrap
  prevention.  Migrated 8 sites across cache + object-storage
  (#254).

**Foundational typed names**:
- `src/config/ConfigKeys.ts` — typed const-tree for every
  `actor-ts.*` HOCON path.  Migrated 16 call sites across all
  brokers + ActorSystem + CacheExtension (#265).
- `src/persistence/storage/KeyValidator.ts` — declarative
  rule-based factory replacing the hand-rolled `assertSafeKey`
  (filesystem) and `assertSafeMemcachedKey`.  Adding a new
  storage backend with similar key rules becomes a 6-line
  `as const` rule set (#251).

### Chat sample feature sweep

Five "Chat sample: …" follow-up issues resolved across five
commits.  Four shipped as features, one closed-not-implement, one
sub-feature spun off as its own focused issue.

- **User-created rooms at runtime** (#98) — new
  `ChatRoomDirectoryActor` wraps a cluster-wide `DistributedData`
  ORSet of room names.  `DEFAULT_ROOMS` becomes the idempotent seed
  list; the actor fans out `RoomsChanged` / `RoomAdded` /
  `RoomRemoved` events to per-session subscribers.  Protocol gains
  `create-room` (client → server) plus `room-added` / `room-removed`
  (server → client).  Six frontends grow a "+ new room" input.
- **Private direct messages** (#100) — DMs ride on existing
  protocol frames as virtual `@<username>` "rooms".  Server
  distinguishes by the leading `@` and routes through a sharded
  `DmChannelActor` keyed on the canonical pair-id
  (`canonicalPairId('alice', 'bob') === 'alice|bob'` regardless of
  ordering).  Each user subscribes once at login to their inbox
  topic `chat.dm.user.<self>` — single subscription covers every
  DM conversation.  Six frontends: click any user in the Online
  panel to open a DM.
- **Typing indicators** (#103 slice 1) — `{ type: 'typing', room }`
  fan-outs via the room's existing PubSub topic as an ephemeral
  `TypingBroadcast`; server filters self-echoes; clients debounce
  outbound at 1/2 s and auto-clear stale indicators after 3 s.
- **Read receipts** (#103 slice 2) — per-room
  `read-up-to.<room>` `DistributedData` LWWMap mapping username →
  highest acked message timestamp.  New `ReadReceiptsActor` enforces
  a monotonic guard at the boundary (LWW's wall-clock tiebreak
  doesn't know read pointers can't go backwards).  Frontends render
  ✓ / ✓✓ on own messages.
- **Emoji passthrough** (#103 slice 1, doc-only) — server is
  text-agnostic; any frontend can wire an `emoji-mart` /
  `<emoji-picker-element>` / native picker on top without server
  changes.  Documented in the chat README; no code shipped.
- **Production-realistic auth** (#99, Option A) — passwords stored
  as `<salt>:<hash>` scrypt records (`crypto.scryptSync`,
  N=16384/r=8/p=1, constant-time verify via
  `crypto.timingSafeEqual`).  Session tokens become HMAC-SHA256-
  signed JWT-style strings; `lookupToken` self-validates without a
  DD read.  DD-LWWMap shrinks to a revocation-only set
  (`chat.session-revocations`).  Server secret comes from
  `CHAT_TOKEN_SECRET` env (warned-and-fallback otherwise).
- **#104 (mobile frontends)** — closed-not-implement.  Six web
  frontends already cover the "protocol works anywhere" story;
  adding React Native + Flutter is two more app-frameworks to
  maintain for marginal sample-value gain.  Rationale in the issue
  closing comment.
- **#292 (file uploads)** — spun off as its own focused issue
  because object-storage wiring is qualitatively different from
  the other UI-polish items.  Not blocking the rest of the sweep.

Chat-sample smoke-test grows from passes 1–2 to **passes 1–7**,
covering: login + send + history (1–2), user-created rooms (3),
direct messages (4), typing indicators (5), read receipts including
a monotonic-guard probe (6), and auth hardening — wrong password,
valid resume, revoked-token resume rejection, tampered-token resume
rejection (7).

### Added — Persistence

- `eventDispatcher<S, E>()` (#239) — typed builder for
  `PersistentActor.onEvent` that the compiler refuses to finish
  until every variant of the event union has a handler.  Missing
  variants surface as a clear "EventDispatcherIncomplete<missing>"
  type error at the build site.  Documented as the preferred shape
  for new persistent actors; existing handwritten `onEvent`
  impls continue to work unchanged.

### Added — Testing infrastructure

- `tests/util/AsyncAssertions.ts` — `assertCompletesWithin(promise,
  ms, label)` + `assertDoesNotCompleteWithin` for diagnostic-quality
  timeout failures (the label appears in the error message;
  default Bun timeouts give no clue which step was slow) (#288).
- `tests/util/TestActorSystem.ts` — `createTestActorSystem(options?)`
  consolidates the per-file `makeSystem` boilerplate.  Demo
  migration in `BrokerActor.test.ts`; other test files can opt-in
  over time (#283, scope-adjusted).
- `tests/unit/cache/_Contract.ts` — `runCacheContractTests(spec)`,
  a backend-agnostic suite covering set/get/delete/incr/setIfAbsent/
  TTL semantics.  InMemoryCache wired as first consumer; Redis +
  Memcached can opt-in once their mock-client factories are
  available (#287, scope-adjusted).

### Issue hygiene

- Closed as duplicate: #267 → #253, #266 → #255, #167 → #164.
- Closed as not-applicable: #245 — `BrokerEvents.ts` has no
  in-file dispatch; events flow through `EventStream`'s
  per-subscriber `instanceof` machinery, which by design isn't a
  closed-union dispatch.

## [0.8.0] — 2026-05-11

The "production-vertical big" release — one priority:high cornerstone
plus four mid-sized operator-facing items.  Wire-format additive: new
optional message types and HTTP routes; no existing callers break.

### Added — DistributedData quorum writes / reads (#81)

- `DistributedDataHandle.updateAsync(key, factory, fn, { consistency })`
  and `.getAsync(key, { consistency })` — promise-returning variants
  with a `WriteConsistency` / `ReadConsistency` target.
- Consistency levels: `'local'` (legacy fire-and-forget), `'majority'`
  (⌊N/2⌋+1), `'all'` (every up-member), `{ from: K }` (clamped to
  `[1, N]`).  Self always counts as the first ack; single-node
  clusters resolve instantly.
- Reads merge incoming responses into the local replica before
  resolving, so a `ReadMajority` effectively pulls the freshest
  state without waiting for gossip.
- Timeouts reject writes (the local apply still stands, gossip
  continues) and resolve reads with the best-available merge —
  reads stay best-effort even on partial failure.
- New wire messages `ddata-write-request|ack` /
  `ddata-read-request|response`.  Registered via the extension's
  synchronous `start()` so the inbound side routes before the user
  can issue the first quorum write.

### Added — operations tooling

- `reEncryptObjectStorage(backend, opts)` (#70) — re-encrypt every
  body under a prefix to the active master key from a `MasterKeyRing`.
  Idempotent fast-path on bodies already at the active version;
  `If-Match` CAS internally so a concurrent writer isn't overwritten
  silently.  Closes the missing step in v0.7's
  `docs/operations/rolling-migration.md` Phase-3 — the doc now shows
  the real call instead of a TBD marker.
- `migrateBetweenJournals(source, target, opts?)` /
  `migrateBetweenSnapshotStores(source, target, { pids })` (#87) —
  copy-with-optional-transform helpers for backend swaps and
  schema-piggyback migrations.  Per-pid resume from `target.highest
  Seq + 1`; optional `MigrationProgressStore` for cross-process
  resumability.  `skipExistingPids` for fan-out across worker pools.

### Added — outside-in cluster connectivity (#86)

- `ClusterClient({ contactPoints })` — lightweight handle for
  processes that aren't cluster members (REST frontends, batch jobs,
  operator scripts).  Opens one persistent TCP connection to a
  contact-point, performs the standard hello handshake with a
  synthetic client address, and exchanges `cluster-client-envelope`
  / `cluster-client-reply` frames.
- `send(targetPath, message)` for fire-and-forget,
  `ask(targetPath, message, timeoutMs?)` for request/reply,
  `close()` for teardown.
- Contact-point failover: tries them in round-robin; the first
  successful dial wins.  Ask rejections come back as deterministic
  Error rejections (path-not-found, timeout, cluster-side ask
  failure).
- `ClusterClientReceptionist` extension — cluster-side endpoint.
  Resolves the target path through the local ActorSystem and
  forwards as tell (no askId) or `ask` (with askId) plus a reply
  frame.  Start once per cluster node that should accept client
  traffic.
- Out of scope for v1: ActorRef payloads (no `encodeRefs` round-trip
  on this path), push-style subscriptions, cluster-aware routing on
  the receptionist side.

### Added — extended cluster-management HTTP endpoints (#56)

- `GET /cluster/shards?type=<typeName>` — shard-to-region map for one
  sharded type, read from the coordinator state stored in
  DistributedData.  Returns 404 if DD isn't started or the type
  hasn't recorded state yet.
- `POST /cluster/down` body `{ address }` — operator-initiated
  force-down of a remote peer.  Backed by a new public
  `cluster.down(addr)` method that emits MemberDown + MemberRemoved
  and tombstones the address.  Opt-in via `enableDownEndpoint`;
  production deployments should still gate this behind an auth
  proxy.
- `GET /metrics` — Prometheus text format from the system's
  MetricsRegistry.  Opt-in via `enableMetricsEndpoint` because most
  deployments scrape metrics from a separate port.

### Added — public Cluster API

- `Cluster.down(addr: NodeAddress | string): boolean` — operator
  force-down of a remote peer.  Symmetric to `Cluster.leave()` but
  for someone else's address.  Returns `true` if the member was
  found and downed, `false` if the address was unknown or already
  terminal.  Refuses to down `selfAddress` — that's `leave()`'s
  job (#56).

## [0.7.0] — 2026-05-11

### Added — operator-facing documentation under `docs/`

- `docs/operations/rolling-migration.md` (#91) — the canonical
  four-phase rolling-deploy walkthrough on top of `writeVersion` +
  `MasterKeyRing` + `wrapLegacy` + `SchemaRegistry`.  Code-first →
  observation → writer flip → optional cleanup, with the parallel
  master-key-rotation story.  ASCII diagram up top for the elevator
  pitch; symbol-reference table at the bottom mapping every
  mentioned API to its export path.
- `docs/persistence/migration-recipes.md` (#93) — decision-tree
  guide for picking among the five overlapping migration tools
  (`defaultsAdapter` / `migratingAdapter` / `SchemaRegistry` /
  `validatedEventAdapter` / `wrapEventAsEnvelope` + bulk
  migrators).  ASCII flowchart routes "what's the change?" to
  exactly one recipe; each recipe has a worked example and a
  "when NOT to use this" note.  Pitfalls section covers the four
  common questions (mixing adapters, downgrades, snapshots,
  manifest renames).
- `ClusterEvents.MemberRemoved` JSDoc + README clarification (#79)
  spelling out the two paths a removal can take — definitive
  (tombstoned with `removedAt`, pruneable after `tombstoneTtlMs`)
  vs FD-driven (deleted outright so a healed partition recovers).
  Public APIs already filter; only direct iteration of the raw
  membership view needs the explicit status check.
  `MemberStatus`'s `'removed'` enum entry gains a paragraph-length
  docstring with cross-refs to #75 and the event JSDoc.

### Added — broker-actor extensions

- MQTT 5.0 user properties + reason codes (#13) — opt in via
  `protocolVersion: 5` on `MqttActorSettings` (default 4 keeps
  every existing config unchanged).  Inbound `MqttMessage`
  carries optional `userProperties: Record<string, string |
  string[]>` (multi-valued per the MQTT 5.0 spec) and
  `reasonCode?: number`; outbound `MqttPublish` accepts a
  `userProperties` map that the actor attaches to the PUBLISH
  packet's v5 properties block.  On v3.1.1 those fields are
  silently dropped — the wire format has no slot for them.  New
  pure helper `buildPublishProperties(p, protocolVersion)` is
  exported for users testing the v5 path without a broker.
- JetStream pull-consumer mode (#62) — opt in via `consumer.mode:
  'pull'`.  Push remains the default.  In pull mode the actor
  doesn't run an auto-iterating subscription; instead the
  application sends `{ kind: 'fetch'; batch; expiresMs? }` cmds
  to drive batch deliveries.  Per-message ack/nak/term handshake
  is unchanged.  Batch semantics fan out all messages to `target`
  up front, then `Promise.all`-await the per-message acks —
  matches the natural pull-consumer pattern (target processes
  the batch as it likes, acks come back independently).
  `JetStreamClientLike` gains `consumers.get(stream, durable):
  Promise<PullConsumerLike>` for the structural-typing contract.

### Added — cache: bulk operations across all three backends

- `Cache.mget<V>(keys: ReadonlyArray<string>): Promise<Map<string,
  V>>` and `Cache.mset<V>(entries: ReadonlyMap<string, V>,
  ttlMs?: number): Promise<void>` (#14).  Hits land in the result
  Map keyed by request keys; misses (no entry / expired /
  malformed payload / transient backend failure) are simply
  absent — `Map.get(k)` returns `V | undefined` with the same
  "missing key" semantics as the single-key `get`.  Backend
  specifics:
    - **InMemoryCache** — iterates the underlying Map; lazy
      expiry applies to `mget` just like `get`.
    - **RedisCache** — `mget` emits a single `MGET`; `mset`
      without TTL emits a single `MSET`, with TTL falls back to
      pipelined `SET ... PX` (Redis MSET has no per-key TTL).
      `RedisClientLike` gains `mget` and `mset` to satisfy the
      structural-typing contract.
    - **MemcachedCache** — no native bulk ops on the wire;
      falls back to `Promise.all` of single-key calls.

### Added — replicated event sourcing: optional Lease

- `ReplicatedEventSourcedActor.lease()` protected hook (#89).
  Default returns `null` (multi-master, unchanged).  When it
  returns a `Lease`, the actor enforces single-writer mode for
  its `persistenceId`: only the lease holder may `persist`,
  non-holders are observers that throw on `persist` (use the
  `isLeaseHolder` getter to gate side-effect logic before
  calling).  Companion `onLeaseLost(reason)` hook fires when a
  TTL expiry / fence / backend failure flips the actor to
  observer mode.  Same Lease-based pattern v0.6.0's
  ClusterSingleton (#38) and ShardCoordinator (#60) ship —
  different scope (per-pid among replicas instead of
  cluster-wide), same machinery.  Use cases: non-replayable
  side effects (card charges, webhooks) and heartbeat actors
  where N replicas would multiply the rate.

### Changed — `Cache` interface (additive)

- The `Cache` interface gains two REQUIRED methods (`mget` and
  `mset`).  Existing user-side implementations of `Cache` must
  add them — the three shipped backends (`InMemoryCache`,
  `RedisCache`, `MemcachedCache`) are updated.  Pre-1.0
  framework, so this counts as additive evolution rather than
  a tracked breaking change — but worth flagging.

### Removed — `CONTRIBUTING.md`

- `CONTRIBUTING.md` (v0.6.0's #92) is removed.  The doc was
  written under the assumption external contributors would land
  PRs; the actual project posture is single-maintainer and PRs
  aren't accepted.  Internal conventions stay in `CLAUDE.md` /
  the plan-doc / commit-message style.
- Replaced with four issue templates under `.github/ISSUE_TEMPLATE/`:
  `bug_report.yml` (pre-labelled `bug` + `priority: medium`,
  prompts for repro / version / runtime / peer-deps / logs),
  `feature_request.yml` (pre-labelled `enhancement` +
  `priority: low`, use-case + API sketch + acceptance criteria),
  `documentation.yml` (pre-labelled `documentation` +
  `priority: low`, location + kind), and `config.yml`
  (disables blank issues, links to README / ROADMAP / CHANGELOG).
  Closes the original #77 (multi-issue close-syntax — the
  convention itself stays in commit-message style, not docs).

## [0.6.0] — 2026-05-08

### Added — sample apps (chat, voice, six frontends each)

- `examples/chat/` — clustered chat app on a 3-node TCP cluster:
  sharded persistent rooms (`ChatRoomActor` + SQLite journal),
  `OnlineUsersActor` via DistributedData + DistributedPubSub,
  cluster-singleton HTTP front door (auto-failover ~5–10 s), six
  frontends (Plain, Lit, Svelte, React, Next.js, Angular) sharing
  one `protocol.ts` over the wire (#94, #95, #96, #97).
- `examples/voice/` — distributed voice server: 1:1 PTT, group, and
  Teams-style rooms; `MediaRecorder` + `MediaSource` per-sender
  audio relay over WebSocket binary frames; same six-frontend
  matrix.  Plain HTML frontend gates `getUserMedia` on
  `isSecureContext` so Safari quirks surface upfront.
- Chat sample now uses snapshots — `ChatRoomActor.snapshotPolicy`
  via `everyNEvents(100)` + `SqliteSnapshotStore` (#102), and
  optional TLS / WSS via `--tls-cert` / `--tls-key`
  (Fastify `https` option threaded through `FastifyBackend`),
  with frontends auto-switching to `wss:` based on
  `location.protocol` (#101).

### Added — observability bridges to industry-standard SDKs

- `promClientRegistry({ client, registry, namePrefix? })` in
  `src/metrics/PromClientAdapter.ts` — bridges the framework's
  `MetricsRegistry` to a user-owned `prom-client` registry so app
  + framework metrics share one `/metrics` endpoint.  Structural
  typing on `PromClientLike` keeps `prom-client` an optional peer
  dep with no hard `import` (#64).
- `otelTracer({ api, tracer?, tracerName?, tracerVersion? })` in
  `src/tracing/OtelAdapter.ts` — bridges the framework's `Tracer`
  to `@opentelemetry/api`.  W3C `traceparent` cross-actor /
  cross-cluster propagation; `SpanKind` / `SpanStatusCode` mapping
  via lookup tables; same structural-typing approach so the OTel
  SDK stays optional (#63).
- README documents both adapters with end-to-end snippets in a new
  "Observability — Prometheus + OpenTelemetry" section.  See also
  `examples/management/prom-client-shared.ts` and
  `otel-jaeger.ts`.

### Added — persistence query: multi-tag filter

- `eventsByTag` accepts a `TagFilter` object combining three
  operators (#90):
    - `all: [...]` — intersect (every listed tag must appear).
    - `any: [...]` — union (at least one listed tag must appear).
    - `not: [...]` — exclusion (no listed tag may appear).
  A bare string stays a back-compat shorthand for `{ all: [tag] }`.
- `InMemoryQuery` does the whole match in JS.  `SqliteQuery` pushes
  the filter into SQL — `JOIN events_tags` for `all`, `IN (?,?,…)`
  with `DISTINCT` for `any`, JS-refines `not`.  Prepared statements
  cached per arity.
- `CassandraQuery` follows the same three strategies once the new
  optional `events_by_tag` side table is populated (`useTagIndex:
  true` on `CassandraJournal`).  DDL + dual-write per `(event, tag)`
  pair, exposed via `tagIndexDdl` (#44).

### Added — cluster lifecycle: TTL tombstones + LRU sharding

- Cluster-member tombstone pruning (#75) — `Member.removedAt`
  travels in gossip; new `tombstoneTtlMs` (24 h),
  `tombstonePruneIntervalMs` (5 min), `tombstoneMinRetentionMs`
  (`6 × downAfterMs`) settings; `mergeMember` rejects expired
  tombstones from gossip so a slow peer can't resurrect addresses
  already pruned cluster-wide.
- ClusterSharding `maxEntities` cap with LRU passivation (#82) —
  when the local region is at capacity, the entity with the oldest
  `lastActivity` is passivated to make room.  Default `0` (no
  cap, current behaviour); already-passivating entities don't
  count toward the cap.
- Cassandra-backed `RememberEntitiesStore` (#84) — state-based
  schema (`(type_name, shard_id, entity_id) → started_at`),
  partition-by-type for atomic whole-partition `clear`.  Both
  `JournalRememberEntitiesStore` and `CassandraRememberEntitiesStore`
  now exported from `cluster/index.ts`.

### Added — framework primitives: FSM, supervision, throttle

- `PersistentFSM.stateTimeout` (#65) — declare a per-state
  `_timeout: { afterMs, event, next, guard? }` to auto-fire a
  transition when no command moves the FSM out within the window.
  Routes the timeout fire through the actor mailbox via a magic
  self-tell so it serialises cleanly with concurrent commands;
  recovery re-arms the timer relative to wall-clock at recovery
  completion.
- `PersistentFSM` multi-event transitions (#66) — `event` in the
  transitions table accepts `Event[]` (or a function returning one)
  alongside the single-Event form.  Multiple events persist
  atomically via `persistAll`; final-state vs `next` check fires
  against the post-replay state.
- `BackoffSupervisor.triggerOn: 'failure' | 'stop' | 'any'` (#68)
  — split crash-only vs clean-stop respawn (mirrors Akka's
  `Backoff.onFailure` / `Backoff.onStop`).  Default `'any'` keeps
  the v1 behaviour.
- `BackoffSupervisor.forwardDuringGrace: false` (#67) — opt-in
  strict gate: messages arriving in the post-respawn grace window
  stash until the child confirms it survived `drainGraceMs`.  Fixes
  the dead-letter cascade described in the issue at the cost of
  `drainGraceMs` of latency on the first message after each
  respawn.
- `context.throttle({ qps, burst, onExcess: 'pause' | 'drop' })`
  per-actor token-bucket rate limiter (#83).  New `TokenBucket`
  utility class (`src/util/TokenBucket.ts`) — pure, clock-injected,
  refill-on-read.  System messages bypass the gate so lifecycle
  stays responsive under tight throttles.
- `EventStream.subscribe(actor, channel, predicate)` overload
  (#85) — predicate-filtered subscriptions, evaluated before
  delivery; throwing predicates are treated as no-match and the
  bus stays alive for other subscribers.

### Added — broker actors: long-running handler heartbeat

- `KafkaActor` `heartbeat` command + `withAutoHeartbeat` helper
  (#78) — long manual-commit handlers can periodically tell
  `{ kind: 'heartbeat', topic, partition, offset }` to bump
  kafkajs's session-deadline mid-processing.  The convenience
  helper wraps a body in a `setInterval` that fires the cmd at
  ~1/3 of session-timeout.

### Added — DX: CONTRIBUTING.md

- New `CONTRIBUTING.md` covers the workflow this project actually
  uses: setup, test layout (unit / multi-node / smoke /
  cross-runtime), commit conventions, the multi-issue close-syntax
  gotcha (`Closes #N. Closes #M.` — separate keywords required),
  Co-Authored-By trailer convention, pre-1.0 release stance, code
  style (#92, #77).

### Added — multi-node test harness + cluster sharding hardening

- `MultiNodeSpec` test harness — in-process N-role cluster with
  failure-detector tightening, partition / heal helpers,
  `awaitMembers` / `awaitMemberStatus` / `awaitLeader` synchronisation,
  per-role downing-provider injection (#34).
- `ParallelMultiNodeSpec` — worker-thread variant for tests that need
  true parallelism across OS threads (#46).
- Sharding rebalance hardening + sharded-daemon failover; `Passivate`
  semantics across shard hand-off; coordinator state machine
  reviewed against partition / leader-change scenarios (#35).
- Persistent `ShardCoordinator` allocation state via `DistributedData`
  — survives leader hand-off without re-emitting allocations (#39).
- Persistent Remember-Entities — entity list rides through cluster
  restart instead of being re-discovered lazily (#49).
- `KubernetesLease` real implementation against the K8s coordination
  API (replaces the stub from 0.2) (#33).
- `ClusterSingleton` accepts an optional Lease for split-brain-safe
  handover (#38, #61).
- `ShardCoordinator` accepts an optional Lease for split-brain-safe
  coordinator handover (#60).
- `LeaseMajority` split-brain resolver — external Lease as tiebreaker
  in the partition-resolution race (#51).

### Added — persistence performance + projections + replicated ES

- Persistence Query / projections read-side query layer:
  `PersistenceQuery` with `eventsByPersistenceId` / `eventsByTag`, plus
  `ProjectionActor` with at-least-once delivery + offset persistence
  (`InMemoryOffsetStore`, `DurableStateOffsetStore`) (#36).
- Push-based `PersistenceQuery` — events delivered on append via
  `JournalEventBus` instead of polling (#42).
- SQLite tags join table — indexed `events_by_tag` query path (#43).
- Snapshotting for `ReplicatedEventSourcedActor` — vector-clock-aware
  snapshots survive multi-master replay (#41).
- Durable `DistributedData` — CRDT state survives full cluster
  restart via per-replica `DurableStateStore` records (#40).
- CRDTs + Replicated Event Sourcing core: `GCounter`, `PNCounter`,
  `GSet`, `ORSet`, `LWWRegister`, `DistributedData` extension with
  gossip replication; `ReplicatedEventSourcedActor` for multi-master
  event sourcing with conflict-resolver pluggability (#37).

### Added — additional CRDTs + persistent FSM + DX patterns

- `LWWMap`, `ORMap`, `MVRegister`, `GCounterMap` — round out the CRDT
  family.  All four implement the same `Crdt<Self>` interface,
  expose `equals` / `toJSON` / `fromJSON`, and are wired into
  `DistributedData`'s discriminator (#45).
- `PersistentFSM` — finite-state machine combined with event sourcing.
  Declare a transitions table, an `applyEvent` function, and the
  base class handles invalid-transition rejection, guard checks,
  and replay-driven state rebuild (#52).
- `BackoffSupervisor` — restart-with-exponential-backoff supervisor
  for transient failures, with optional message stash during the
  backoff window and a configurable counter-reset rule (#48).
- `ClusterRouter` — cluster-aware router with role filter + four
  routing strategies (round-robin, random, consistent-hashing,
  broadcast).  Routees auto-rebuild on `MemberUp` / `MemberRemoved`
  (#50).

### Added — observability stack

- `LogContext` — Mapped Diagnostic Context (MDC) backed by
  `AsyncLocalStorage`.  Propagates through `tell` / `ask` calls and
  across cluster nodes; `Logger.withFields` for static fields,
  `LogContext.run` / `with` for dynamic scoping (#53).
- Prometheus / OpenMetrics export — `MetricsRegistry` with
  Counter / Gauge / Histogram primitives, label support,
  `exportPrometheus` text-format renderer, `prometheusHandler`
  for `Bun.serve`.  Stock instrumentation: actor lifecycle counters,
  message-handler-duration histogram, cluster gossip + member-up
  metrics.  Opt-in via `MetricsExtensionId.enable()` so the no-
  metrics path is zero-cost (#11).
- OpenTelemetry-style distributed tracing — `Tracer` interface +
  `RecordingTracer` reference impl + W3C `traceparent` codec.
  `actor.receive` and `cluster.envelope.received` spans wired
  automatically; trace context rides cross-wire envelopes
  alongside MDC.  `@opentelemetry/api` is NOT a dependency — users
  bring their own SDK and wrap it in the framework's `Tracer` (#10).

### Added — schema migration & encryption polish

- Master-key rotation for client-side AES-256-GCM snapshots — new
  `MasterKeyRing` shape (`active` + `retired`), key-version byte
  in the body manifest (`FLAG_KEY_VERSIONED`), legacy single-key
  bodies remain readable (#8).
- Rolling-deployment-friendly schema migration — `MigrationChain`
  gains downcasters; `migratingAdapter` / `defaultsAdapter` accept
  a `writeVersion` so v2 nodes can keep emitting v1 events while
  v1 readers still exist (#7).
- One-shot migration helpers — `wrapEventAsEnvelope` /
  `wrapStateAsEnvelope` primitives plus `migrateInMemoryJournal` /
  `migrateSnapshotStore` bulk-rewriters for repos adopting
  schema-evolution after-the-fact (#9).
- Pluggable codec + in-process schema registry — `Codec<T>`
  interface with `jsonCodec` / `zodCodec` / `composeCodecs`,
  `validatedEventAdapter` / `validatedSnapshotAdapter` wrappers,
  `InMemorySchemaRegistry` with on-register compatibility checks
  (`'none'` / `'backward'` / `'sample'`) (#6).

### Added — production-grade brokers & WebSocket server-side

- Kafka exactly-once via manual offset-commit mode — opt-in
  `commitMode: 'manual'` pumps each message into a pending-promise
  map until the handler sends `commit` / `nack` / timeout fires;
  `commitOffsets` uses BigInt arithmetic so 2^53+ offsets stay
  exact (#2).
- NATS JetStream actor — durable streams + push consumer with
  `ack` / `nak` / `term` / `inProgress` handshake; auto-create-or-
  update streams + consumers; idempotent publish via `messageId`
  (`Nats-Msg-Id`) (#3).
- Server-side WebSocket — `ServerWebSocketActor` wraps a pre-
  upgraded socket; `serverWebSocketActorOf` for the `ws`-package
  family (Fastify, Hono); `bunWebSocketHandlers` for `Bun.serve`'s
  callback-style API (#1).

### Fixed

- `DistributedPubSubMediator` — gossip frame trimmed to topic
  names only (#80).  The `entries` field used to be `Record<string,
  string[]>` carrying every local subscriber's actor path per
  topic, but `handleGossip` discarded the path lists; bytes are
  now proportional to topic count, not subscriber count.  Audit
  tests pin the boundedness contract: 100 sub/unsub cycles on
  the same topic leave both `topics` and the gossip frame at
  zero entries.
- `FilesystemObjectStorageBackend` is multi-process safe (#19) —
  drops the in-memory etag map (disk is canonical via
  deterministic FNV-1a content hash) and serialises CAS via
  per-key `<key>.lock` files created with `fs.writeFile(...,
  { flag: 'wx' })`.  Body writes are atomic via temp + rename;
  Windows quirks (`EPERM` / `EBUSY` during NTFS deletion-pending
  states) recognised as benign retry signals; stale locks
  (>30 s default) reclaimed automatically.  Includes a Bun-spawn-
  based multi-process test as the integration check.
- `DistributedPubSubMediator` — eager broadcast on subscribe /
  unsubscribe.  The previous "one random peer per gossip tick"
  scheme had a probabilistic gap (~3 % per 5-tick window) where
  a publish-immediately-after-subscribe could miss the new
  subscriber.  Eager-broadcast on state mutation closes the gap
  deterministically; periodic gossip stays as steady-state
  anti-entropy.  Eliminated CI flake on
  `tests/multi-node/pubsub-cross-node.test.ts` and
  `tests/multi-node/parallel-pubsub.test.ts`.
- `tests/multi-node/cluster-router.test.ts` — replaced the tight
  5 s `waitFor(() => total === 21)` predicate with a "3 readings
  stable" stability check + 15 s timeout, covering CI variance
  when other multi-node test files run in parallel (#76).
- Five small correctness items batched together: `tests/unit/util/
  Option.test.ts` typecheck:dev failure (#17), eager peer-dep
  validation at object-storage plugin-init for every codec
  (#18, #59), `ORSet` / `GSet` element-identity callbacks for
  non-JSON-serialisable values (#57), single-actor-per-pid
  enforcement for `ReplicatedEventSourcedActor` (#58).

## [0.5.0] — 2026-04-27

### Added — I/O & message-broker actors

- `BrokerActor` base with reconnect (exponential backoff + optional
  CircuitBreaker), outbound buffer, subscriber fan-out, lifecycle
  events on the EventStream, and a 3-layer settings resolver
  (constructor → HOCON → defaults).
- Phase 1 actors: `TcpSocketActor`, `UdpSocketActor`, `MqttActor`,
  `WebSocketActor`.
- Phase 2 actors: `KafkaActor`, `AmqpActor`, `GrpcClientActor`,
  `GrpcServerActor`.
- Phase 3 actors: `NatsActor`, `RedisStreamsActor`, `SseActor`.
- Examples: `examples/io/{mqtt-temperature,websocket-feed,grpc-sensor}.ts`.

## [0.4.0] — 2026-04-27

### Added — object-storage + schema migration + caching

- Object-storage persistence: `ObjectStorageBackend` interface,
  `FilesystemObjectStorageBackend` (built-in), `S3ObjectStorageBackend`
  (lazy AWS SDK; works against AWS / MinIO / R2 / Backblaze B2 /
  Wasabi).  `BodyCodec` with manifest header — gzip / zstd
  compression and AES-256-GCM client-side encryption (HKDF-SHA256
  per-pid subkey derivation, compress-then-encrypt).
- `ObjectStorageSnapshotStore` + `ObjectStorageDurableStateStore` with
  per-prefix compression / encryption resolvers and per-actor
  overrides via `PersistenceOptions`.
- Schema migration: `EventAdapter` / `SnapshotAdapter` / `StateAdapter`
  interfaces with a versioned `_v / _t / _e` envelope wire format,
  plus `MigrationChain` for hand-written upcasters and
  `defaultsAdapter` for additive evolution without code.  Hooks
  on `PersistentActor` + `DurableStateActor`.
- Cache abstraction: `Cache` interface (get / set / incr /
  setIfAbsent / delete) + 3 backends (`InMemoryCache`, `RedisCache`
  via lazy ioredis, `MemcachedCache` via lazy memjs).
  `CacheExtension` for named-cache registration.
- HTTP middleware: `rateLimit`, `idempotent` (Stripe-style), `cached`
  (response-cache with stampede protection).
- `CachedSnapshotStore` decorator wrapping any `SnapshotStore` for
  cold-start storms after sharding rebalance.
- Examples: `examples/cache/redis-rest-service.ts`,
  `examples/persistence/{event-migration,event-migration-chain,
  s3-snapshot-bank-account}.ts`.

## [0.3.0] — 2026-04-27

### Added — persistence + HTTP

- Persistence: `Journal`, `SnapshotStore`, `DurableStateStore`
  interfaces.  `PersistentActor` (event sourcing with
  snapshotPolicy + persist callback) and `DurableStateActor`
  (snapshot-only with strict CAS via expectedRevision).
- Three persistence backends ship: `InMemoryJournal` /
  `InMemorySnapshotStore` (default), `SqliteJournal` /
  `SqliteSnapshotStore` (Bun via bun:sqlite, Node via
  better-sqlite3 — abstracted by a `SqliteDriver`), `CassandraJournal`
  / `CassandraSnapshotStore` (lazy cassandra-driver).
- HTTP service stack: directives DSL (get / post / put / del / patch /
  path / pathPrefix / concat) compiling to backend-agnostic
  `CompiledRoute`; three backends — `FastifyBackend` (default),
  `ExpressBackend`, `HonoBackend` (with auto-detection of the right
  serve primitive per runtime).  `HttpClient` for outbound calls.

## [0.2.0] — 2026-04-27

### Added — distributed primitives

- HOCON config (parser + ENV interpolation + Duration / Size types).
- JSON + CBOR serialization (`Serializer<T>` interface with manifest
  tagging; SerializationExtension for plugin registration).
- `CoordinatedShutdown` (12-phase, dependency-ordered task runner) and
  `Lease` abstraction (with InMemoryLease + KubernetesLease impls).
- Cluster fabric: TCP / in-memory / worker-thread transports;
  membership state machine + gossip; failure detection (Phi-Accrual
  default + simple time-threshold variant); `ClusterEvents` on
  EventStream.
- Cluster sharding: `ShardCoordinator`, `ShardRegion`,
  `ClusterSharding` extension; `HashAllocationStrategy` /
  `LeastShardAllocationStrategy`; `Passivate` for entity lifecycle;
  `ShardedDaemonProcess` for fixed N workers across the cluster.
- Distributed pub/sub (`DistributedPubSubMediator`); `Receptionist`
  service-key registry; `ClusterSingleton` (manager + proxy + lease-
  based variant); `ReliableDelivery` (at-least-once point-to-point
  with explicit acks).
- Four split-brain resolvers (KeepMajority / KeepOldest /
  StaticQuorum / KeepReferee).
- Four seed providers (Config / DNS / Kubernetes API / Aggregate),
  with an in-process TTL cache on the DNS provider.
- Management endpoints: `/health`, `/ready`, `/cluster/state`, etc.

## [0.1.0] — 2026-04-27

### Added — minimum viable actor system

- `Actor` base class + lifecycle hooks (preStart / postStop /
  preRestart / postRestart) + `ActorRef` / `ActorContext` /
  `ActorPath` / `ActorSelection`.
- `ActorSystem`, `Props`, `Extension` registry, `SystemMessages` (the
  internal control protocol — Watch / Unwatch / Terminated / Suspend
  / Resume / Stop / …).
- Supervision: `OneForOneStrategy` / `AllForOneStrategy` with Resume
  / Restart / Stop / Escalate directives.
- Mailbox variants: unbounded (default), bounded with three overflow
  policies, priority (with caller-supplied comparator), per-actor
  stash.
- `ActorCell` + `Guardian` + `DeadLetterRef` + `LocalActorRef` +
  `PromiseActorRef`; deathwatch, `ReceiveTimeout`, become / unbecome,
  per-actor `TimerScheduler`.
- `Scheduler` (real timers + `ManualScheduler` for tests),
  `Dispatcher` variants, `Logger` (leveled + Noop), `EventStream`
  (system-wide pub/sub on classes).
- `typed` Behaviors DSL — functional facade over the OO API
  (`Behaviors.receive`, `Behaviors.same`, `Behaviors.stopped`,
  `Behaviors.setup`, supervise + withSupervision).
- TestKit: `TestProbe` (synchronous mailbox with expect-* timeouts),
  `ManualScheduler` (virtual clock).
- Patterns: `ask` (Promise-returning send) + `retry` (exponential
  backoff) + `CircuitBreaker` + `Router` (round-robin / random /
  broadcast) + `after` + `pipeTo`.
- `FSM` DSL — named-state finite-state-machine actor base.
- Utility primitives: `Option<T>`, `Lazy<T>`, `Try<T>`, `Either<L,R>` —
  Scala-style ergonomics, used throughout.
