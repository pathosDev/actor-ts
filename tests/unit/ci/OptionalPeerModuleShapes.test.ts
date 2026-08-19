import { describe, expect, test } from 'bun:test';
import { compressorFor, resetCompressionCache } from '../../../src/persistence/object-storage/Compression.js';

/**
 * The optional peers whose only dependency context is the ROOT manifest,
 * checked against the real installed package (#676).
 *
 * These live beside `OptionalPeerDeclarations.test.ts` rather than beside their
 * adapters because they are the other half of one rule, not three unrelated
 * adapter tests. AGENTS.md says a root `devDependencies` entry is justified by
 * a suite that imports the REAL module and asserts the shape the adapter
 * destructures; this file is that justification, and the guard next door is
 * what makes it mandatory. Splitting them across `tests/unit/http`,
 * `tests/unit/cache` and `tests/unit/persistence` would hide the pattern from
 * the next person adding an optional peer.
 *
 * `cassandra-driver` is the fourth package #676 named and is deliberately NOT
 * here: it cannot be installed at the root without failing `bun run
 * lint:audit`. Its newest release (4.9.0) hard-pins `adm-zip: ~0.5.10` and
 * GHSA-xcpc-8h2w-3j85 is fixed only in 0.6.0, so no version of the driver
 * clears the gate. See `DELIBERATELY_UNDECLARED` in the guard next door, which
 * records the gap rather than hiding it.
 *
 * What they are for is worth stating precisely, because the obvious answer is
 * wrong. Installing a package does not make any existing suite exercise it —
 * nothing in `tests/` is conditioned on module availability, and every adapter
 * path runs against a hand-rolled fake (`FakeCassandraClient`, `FakeMemcached`,
 * `mock.module('@aws-sdk/client-s3', …)`). That is the right shape for fast
 * feedback and it stays. What it leaves uncovered is the seam between the fake
 * and reality: each adapter reaches its peer through a hand-written structural
 * type — `MemjsClientStatic`, `CassandraDriver`, `WebsocketServerLike`, the
 * inline `{ decompress }` — and a fake satisfies the stub by construction, so
 * the stub is checked against nothing. Upstream renames an export and every
 * suite stays green while production breaks on first use.
 *
 * So each case below asserts the *destructured* surface, and nothing more. It
 * deliberately does not test adapter behaviour, does not open a socket, and
 * does not construct a client that would.
 *
 * Every import here uses a LITERAL specifier, which is load-bearing twice
 * over. It is the only form that actually pins the package name at the install
 * (the adapters use `const name = 'ws'; await import(name)` on purpose, so a
 * missing optional peer surfaces as a caught error with an install hint rather
 * than a hard resolution failure) — and it is the form `knip` can attribute to
 * a manifest entry, which is what keeps `memjs` and `fzstd` out of
 * `knip.jsonc`'s `ignoreDependencies`. That file's own comment is the reason to
 * care: "an ignore entry that is not needed hides a finding later." `ws` is the
 * measured exception: knip attributes neither it nor `@types/ws` from this file,
 * dynamic or static, so both keep an ignore entry — see the note there.
 */

describe('ws — Express backend WebSocket upgrade', () => {
  /**
   * The load-bearing one. `ws` sat in `node_modules` from the initial scaffold
   * until #676 with no root declaration, pulled in only by `@fastify/websocket` and
   * `@hono/node-ws` through their own `dependencies` — so
   * `ExpressWebsocket.test.ts` and `tests/smoke/cases/20-express-upgrade-middleware.mjs`
   * both passed on hoisting luck. This asserts the three members
   * `WebsocketServerLike` in `src/http/backend/ExpressBackend.ts` declares, which
   * is the stub the whole Express upgrade path is typed against.
   */
  test('exports a WebSocketServer with the members ExpressBackend calls', async () => {
    const websocketModule = await import('ws');
    expect(
      typeof websocketModule.WebSocketServer,
      'ExpressBackend resolves `mod.WebSocketServer ?? mod.default.WebSocketServer` '
      + 'and throws "ws: WebSocketServer not exported" when neither is there.',
    ).toBe('function');

    // Only the named export is asserted, and the omission is deliberate.
    // ExpressBackend also accepts `mod.default.WebSocketServer`, which does
    // exist at runtime — `ws` is CJS, so the interop `default` is the whole
    // `module.exports` — but `@types/ws` models `default` as the bare
    // `WebSocket` class, which carries no `WebSocketServer`. Asserting it would
    // mean casting past the types to check a fallback that only ever fires for
    // a bundler-shaped `ws` that does not exist.

    // `noServer: true` is exactly how ExpressBackend constructs it — no port is
    // bound and no listener is attached, so there is no handle to leak. Closed
    // anyway, so this stays true if a future `ws` allocates something eagerly.
    const server = new websocketModule.WebSocketServer({ noServer: true, maxPayload: 1024 });
    try {
      expect(typeof server.handleUpgrade).toBe('function');
      expect(typeof server.emit).toBe('function');
      // `clients` is optional on the stub but is what the shutdown path
      // iterates to terminate live sockets.
      expect(server.clients).toBeDefined();
    } finally {
      server.close();
    }
  });
});

describe('memjs — Memcached cache client', () => {
  /**
   * `MemcachedCache` reaches memjs through `MemjsClientStatic`, whose single
   * member is `Client.create(servers, settings)`. `create` is a STATIC on the
   * exported class, which is the part a fake cannot check: `FakeMemcached`
   * implements `MemcachedClientLike` (the instance side) and never touches the
   * factory the adapter actually calls.
   */
  test('exports a Client with a static create factory', async () => {
    const memjsModule = await import('memjs');
    const Client = memjsModule.Client ?? memjsModule.default?.Client;
    expect(typeof Client).toBe('function');
    expect(
      typeof Client!.create,
      'MemcachedCache calls `Client.create(servers, { username, password })`. '
      + 'A renamed or instance-side factory would leave every FakeMemcached '
      + 'test green.',
    ).toBe('function');
    // Not called: `create` resolves servers eagerly and would open a socket to
    // localhost:11211. The factory's existence is the whole contract here.
  });
});

describe('fzstd — pure-JS zstd read fallback', () => {
  /**
   * `Compression.ts` documents fzstd as the reason "a runtime without native
   * zstd can still READ zstd bodies written elsewhere", and until #676 that
   * promise rested on nothing: the package had no devDependency, so its branch
   * was never installed, let alone run. The source comment said so outright —
   * "#780 blocks testing it — fzstd has no devDependency, so it is never
   * installed here".
   *
   * The claim under test is interoperability, which is the part a shape check
   * would miss: bytes actor-ts WROTE through its native compress path must
   * decode through fzstd. A round-trip inside fzstd alone would pass even if
   * the two disagreed about framing.
   */
  test('decodes a zstd frame written by the native compress path', async () => {
    const { decompress } = await import('fzstd');
    expect(typeof decompress).toBe('function');

    resetCompressionCache();
    const payload = new TextEncoder().encode('actor-ts zstd interoperability '.repeat(64));
    const frame = await compressorFor('zstd').compress(payload, 3);
    expect(frame.length).toBeLessThan(payload.length);

    // `decompress` takes no output bound and sizes its own buffer — which is
    // why the zstd read path keeps the post-decode assertion in
    // `decompressWithinCap` for this branch.
    const decoded = decompress(frame);
    expect(decoded).toEqual(payload);
  });

  /**
   * The same 17-byte frame `Compression.ts` uses to accept or reject a
   * candidate decoder. The zstd resolver deliberately does NOT canary-check
   * fzstd — "fzstd is pure JS with no native binding to be missing, so a
   * successful import already answers 'does it work?'" — and that shortcut is
   * an assumption about the package, not about our code. This is where it gets
   * checked.
   */
  test('decodes the resolver canary frame that fzstd is trusted to skip', async () => {
    const { decompress } = await import('fzstd');
    const canaryFrame = new Uint8Array([
      0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x08, 0x41, 0x00, 0x00,
      0x41, 0x54, 0x53, 0x31, 0x7a, 0x73, 0x74, 0x64,
    ]);
    expect(new TextDecoder().decode(decompress(canaryFrame))).toBe('ATS1zstd');
  });
});
