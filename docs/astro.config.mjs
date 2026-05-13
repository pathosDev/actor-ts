/**
 * Astro Starlight configuration for the actor-ts documentation site.
 *
 * Site lives at `https://actor-ts.dev/` — custom domain served by
 * GitHub Pages.  The CNAME file under `docs/public/CNAME` carries the
 * domain into the Pages build; the GH Pages repo setting must point at
 * the same domain (Settings → Pages → Custom domain → actor-ts.dev).
 * No `base` is set because the docs live at the domain root.
 *
 * **Sidebar** is intentionally minimal at this commit (1.1).  The full IA
 * (12 Parts × ~150 pages) lands in Commit 2.3 once the skeleton pages exist;
 * Starlight refuses to render sidebar items that point at non-existent
 * files, so we wire up the sidebar only after the scaffold script has
 * created the stubs.
 *
 * **Theme** lives in `src/styles/custom.css`, derived from the logo's
 * Tailwind palette.  Indigo as primary accent, slate as text/bg basis.
 *
 * **Fonts** are pulled via `@fontsource(-variable)` packages — see
 * `custom.css` for the `@import` calls and the variable overrides.
 *
 * **i18n** ships with EN as the default locale and DE as a second
 * locale.  Pages without a DE translation transparently fall back to EN.
 */
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { createStarlightTypeDocPlugin } from 'starlight-typedoc';
import rehypeMermaid from 'rehype-mermaid';

// TypeDoc → Starlight bridge.  Generates the API reference from
// JSDoc comments in `../src/`, writes Markdown pages under
// `src/content/docs/api/`, and exposes a `typeDocSidebarGroup` we
// can drop into the sidebar config (once the sidebar is wired up in
// Commit 2.3 — for now the group sits at the top-level until then).
const [starlightTypeDoc, typeDocSidebarGroup] = createStarlightTypeDocPlugin();

export default defineConfig({
  site: 'https://actor-ts.dev',
  // Mermaid SSR.  `rehype-mermaid` runs Playwright/Chromium headless at
  // build time to render each ```mermaid``` block into an inline SVG.
  // Result: no client-side JS, no flash-of-unrendered-text, accessible
  // SVG markup, works with the static GitHub Pages host.
  //
  // We tell Shiki (Starlight's default syntax highlighter) to NOT touch
  // mermaid code blocks — otherwise it would consume them as plain code
  // and our rehype plugin would see nothing to render.
  markdown: {
    syntaxHighlight: {
      type: 'shiki',
      excludeLangs: ['mermaid', 'math'],
    },
    rehypePlugins: [
      [
        rehypeMermaid,
        {
          // 'inline-svg' inlines the rendered SVG directly into the HTML.
          // Other options: 'img-svg' (SVG in <img>), 'img-png' (PNG in
          // <img>), 'pre-mermaid' (no SSR, client-side render).  Inline
          // is the cleanest for theming + accessibility.
          strategy: 'inline-svg',
          // Match our dark/light palette.  Mermaid's 'dark' theme uses a
          // dark background which fits Starlight's default dark mode;
          // light pages get re-themed via CSS variables on the SVG.
          mermaidConfig: {
            theme: 'dark',
            themeVariables: {
              // Indigo accents, slate base — same palette as the logo.
              primaryColor:       '#1e293b',  // slate-800   — node bg
              primaryTextColor:   '#f1f5f9',  // slate-100   — node text
              primaryBorderColor: '#6366f1',  // indigo-500  — node border
              lineColor:          '#94a3b8',  // slate-400   — connection lines
              secondaryColor:     '#312e81',  // indigo-900  — alt node bg
              tertiaryColor:      '#0f172a',  // slate-900   — bg
              fontFamily:         "'JetBrains Mono', ui-monospace, monospace",
              fontSize:           '14px',
            },
            flowchart:  { htmlLabels: true, curve: 'basis' },
            sequence:   { actorMargin: 50 },
          },
        },
      ],
    ],
  },
  integrations: [
    starlight({
      title: 'actor-ts',
      description:
        'Akka-style actor model for TypeScript. Runs on Bun, Node, and Deno. ' +
        'Cluster sharding, event sourcing, distributed data, persistence, and ' +
        'observability — all in idiomatic TS.',
      // Logo in the top-nav uses the PNG variant without the tagline —
      // the tagline would be unreadable at navbar height, and PNG avoids
      // font-fallback drift on systems without JetBrains Mono.  The full
      // logo with tagline is reserved for the splash hero + README.
      logo: { src: './public/logo-header.png', replacesTitle: true },
      // Favicons — SVG for modern browsers, PNG fallbacks for older ones.
      head: [
        {
          tag: 'link',
          attrs: {
            rel: 'icon',
            type: 'image/svg+xml',
            href: '/favicon.svg',
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'icon',
            type: 'image/png',
            sizes: '32x32',
            href: '/favicon-32.png',
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'icon',
            type: 'image/png',
            sizes: '192x192',
            href: '/favicon-192.png',
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'apple-touch-icon',
            sizes: '192x192',
            href: '/favicon-192.png',
          },
        },
      ],
      customCss: ['./src/styles/custom.css'],
      plugins: [
        starlightTypeDoc({
          // Public API surface lives in `src/index.ts` — that barrel
          // re-exports everything users are supposed to import.
          // Sub-paths like `src/cluster/index.ts` could be added as
          // additional entry points if we want them as separate API
          // sections; today the single barrel is enough.
          entryPoints: ['../src/index.ts'],
          tsconfig: '../tsconfig.json',
          // Output lives under `src/content/docs/api/` so Starlight's
          // content-collection picks it up.  Pages are auto-generated
          // on every build — output is gitignored (`docs/.gitignore`).
          output: 'api',
          sidebar: {
            label: 'API Reference',
            collapsed: true,
          },
          typeDoc: {
            // Reasonable defaults for a library — show every export,
            // resolve external links to GitHub for non-actor-ts types.
            excludePrivate: true,
            excludeInternal: true,
            // Skip the rotating-circle "this signature was generated"
            // footer that TypeDoc adds — Starlight has its own footer.
            hideGenerator: true,
          },
        }),
      ],
      // Pagefind search is built in — no extra config needed.
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        de: { label: 'Deutsch', lang: 'de' },
      },
      // Sidebar matches the 12-Part IA defined in the project plan.
      // Each Part is a top-level group; sub-groups (e.g. `cluster/
      // sharding/`) are nested groups.  All top-level Parts are
      // `collapsed: true` by default — Starlight auto-expands the
      // group containing the current page, so navigation stays light
      // while every concept is one click away.
      //
      // Ordering inside a group is **explicit** (slug-by-slug),
      // matching the scaffold table in `scripts/scaffold.mjs`.
      // Future page additions: add the file, then add the slug here
      // and in `scaffold.mjs`'s PAGES table — both have to agree.
      sidebar: [
        {
          label: '🚀 Get Started',
          collapsed: false, // first impression: keep this one open
          items: [
            { label: 'What is actor-ts?',     slug: 'intro/what-is-actor-ts' },
            { label: 'Why actors?',           slug: 'intro/why-actors' },
            { label: 'Installation',          slug: 'intro/installation' },
            { label: 'Quickstart',            slug: 'intro/quickstart' },
            { label: 'Learning path',         slug: 'intro/learning-path' },
            { label: 'Glossary',              slug: 'intro/glossary' },
          ],
        },
        {
          label: '🎭 Build Actors',
          collapsed: true,
          items: [
            {
              label: 'Fundamentals',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'fundamentals/overview' },
                { label: 'Actor',                   slug: 'fundamentals/actor' },
                { label: 'Messages',                slug: 'fundamentals/messages' },
                { label: 'Ask pattern',             slug: 'fundamentals/ask-pattern' },
                { label: 'ActorSystem',             slug: 'fundamentals/actor-system' },
                { label: 'Actor paths',             slug: 'fundamentals/actor-paths' },
                { label: 'Props',                   slug: 'fundamentals/props' },
                { label: 'Become and stash',        slug: 'fundamentals/become-and-stash' },
                { label: 'Death watch',             slug: 'fundamentals/death-watch' },
                { label: 'Supervision',             slug: 'fundamentals/supervision' },
                { label: 'Dispatchers',             slug: 'fundamentals/dispatchers' },
                { label: 'Mailboxes',               slug: 'fundamentals/mailboxes' },
                { label: 'Timers and scheduling',   slug: 'fundamentals/timers-and-scheduling' },
                { label: 'Receive timeout',         slug: 'fundamentals/receive-timeout' },
                { label: 'Coordinated shutdown',    slug: 'fundamentals/coordinated-shutdown' },
                { label: 'Event stream',            slug: 'fundamentals/event-stream' },
                { label: 'Logging',                 slug: 'fundamentals/logging' },
                { label: 'PoisonPill and Kill',     slug: 'fundamentals/poison-pill-and-kill' },
                { label: 'Pattern matching',        slug: 'fundamentals/pattern-matching' },
              ],
            },
            {
              label: 'Typed actors',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'typed/overview' },
                { label: 'TypedActor',              slug: 'typed/typed-actor' },
                { label: 'Behaviors',               slug: 'typed/behaviors' },
                { label: 'Spawning typed',          slug: 'typed/spawn-typed' },
              ],
            },
            {
              label: 'Routing',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'routing/overview' },
                { label: 'Router',                  slug: 'routing/router' },
                { label: 'Strategies',              slug: 'routing/strategies' },
                { label: 'Pool vs group',           slug: 'routing/pool-vs-group' },
              ],
            },
            {
              label: 'Patterns',
              collapsed: true,
              items: [
                { label: 'Circuit breaker',         slug: 'patterns/circuit-breaker' },
                { label: 'Backoff supervisor',      slug: 'patterns/backoff-supervisor' },
                { label: 'Backoff policy',          slug: 'patterns/backoff-policy' },
                { label: 'Retry',                   slug: 'patterns/retry' },
                { label: 'Future patterns',         slug: 'patterns/futures-patterns' },
              ],
            },
          ],
        },
        {
          label: '🌐 Distribute',
          collapsed: true,
          items: [
            {
              label: 'Cluster',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'cluster/overview' },
                { label: 'Joining and seeds',       slug: 'cluster/joining-and-seeds' },
                { label: 'Failure detector',        slug: 'cluster/failure-detector' },
                { label: 'Downing strategies',      slug: 'cluster/downing-strategies' },
                { label: 'Transports',              slug: 'cluster/transports' },
                { label: 'Weakly-up',               slug: 'cluster/weakly-up' },
                { label: 'Refs across nodes',       slug: 'cluster/refs-across-nodes' },
                { label: 'Distributed PubSub',      slug: 'cluster/pubsub' },
                {
                  label: 'Singleton',
                  collapsed: true,
                  items: [
                    { label: 'Overview',            slug: 'cluster/singleton/overview' },
                    { label: 'Manager',             slug: 'cluster/singleton/manager' },
                    { label: 'With lease',          slug: 'cluster/singleton/with-lease' },
                  ],
                },
                {
                  label: 'Sharding',
                  collapsed: true,
                  items: [
                    { label: 'Overview',            slug: 'cluster/sharding/overview' },
                    { label: 'Allocation strategy', slug: 'cluster/sharding/allocation-strategy' },
                    { label: 'Rebalance',           slug: 'cluster/sharding/rebalance' },
                    { label: 'Remember entities',   slug: 'cluster/sharding/remember-entities' },
                    { label: 'With lease',          slug: 'cluster/sharding/with-lease' },
                    { label: 'Sharded daemon',      slug: 'cluster/sharding/sharded-daemon-process' },
                  ],
                },
                { label: 'Cluster router',          slug: 'cluster/cluster-router' },
                { label: 'Cluster client',          slug: 'cluster/cluster-client' },
                { label: 'Cluster security',        slug: 'cluster/cluster-security' },
                { label: 'Worker mesh',             slug: 'cluster/worker-mesh' },
              ],
            },
            {
              label: 'Distributed Data',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'distributed-data/overview' },
                {
                  label: 'CRDT types',
                  collapsed: true,
                  items: [
                    { label: 'Counters',            slug: 'distributed-data/crdt-types/counters' },
                    { label: 'Registers',           slug: 'distributed-data/crdt-types/registers' },
                    { label: 'Sets',                slug: 'distributed-data/crdt-types/sets' },
                    { label: 'Maps',                slug: 'distributed-data/crdt-types/maps' },
                    { label: 'Designing data',      slug: 'distributed-data/crdt-types/designing-data' },
                  ],
                },
                { label: 'Replication',             slug: 'distributed-data/replication' },
                { label: 'Quorum reads/writes',     slug: 'distributed-data/quorum-reads-writes' },
                { label: 'Durable storage',         slug: 'distributed-data/durable-storage' },
              ],
            },
            {
              label: 'Coordination',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'coordination/overview' },
                { label: 'Lease API',               slug: 'coordination/lease-api' },
                { label: 'In-memory lease',         slug: 'coordination/in-memory-lease' },
                { label: 'Kubernetes lease',        slug: 'coordination/kubernetes-lease' },
              ],
            },
            {
              label: 'Discovery',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'discovery/overview' },
                {
                  label: 'Seed providers',
                  collapsed: true,
                  items: [
                    { label: 'Config',              slug: 'discovery/seed-providers/config' },
                    { label: 'DNS',                 slug: 'discovery/seed-providers/dns' },
                    { label: 'Kubernetes API',      slug: 'discovery/seed-providers/kubernetes-api' },
                    { label: 'Aggregate',           slug: 'discovery/seed-providers/aggregate' },
                  ],
                },
                { label: 'Receptionist',            slug: 'discovery/receptionist' },
              ],
            },
          ],
        },
        {
          label: '💾 Persist',
          collapsed: true,
          items: [
            {
              label: 'Event sourcing',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'persistence/overview' },
                { label: 'PersistentActor',         slug: 'persistence/persistent-actor' },
                { label: 'Event dispatcher',        slug: 'persistence/event-dispatcher' },
                { label: 'Snapshots',               slug: 'persistence/snapshots' },
                { label: 'Durable state',           slug: 'persistence/durable-state' },
                { label: 'Projections',             slug: 'persistence/projections' },
                { label: 'Persistence query',       slug: 'persistence/persistence-query' },
                { label: 'Push-based query',        slug: 'persistence/push-based-query' },
              ],
            },
            {
              label: 'Journals',
              collapsed: true,
              items: [
                { label: 'In-memory',               slug: 'persistence/journals/in-memory' },
                { label: 'SQLite',                  slug: 'persistence/journals/sqlite' },
                { label: 'Cassandra',               slug: 'persistence/journals/cassandra' },
              ],
            },
            {
              label: 'Snapshot stores',
              collapsed: true,
              items: [
                { label: 'In-memory',               slug: 'persistence/snapshot-stores/in-memory' },
                { label: 'SQLite',                  slug: 'persistence/snapshot-stores/sqlite' },
                { label: 'Cached snapshot store',   slug: 'persistence/snapshot-stores/cached-snapshot-store' },
              ],
            },
            {
              label: 'Replicated event sourcing',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'persistence/replicated-event-sourcing/overview' },
                { label: 'Single-writer lease',     slug: 'persistence/replicated-event-sourcing/single-writer-lease' },
                { label: 'Vector clocks',           slug: 'persistence/replicated-event-sourcing/vector-clocks' },
                { label: 'Conflict resolver',       slug: 'persistence/replicated-event-sourcing/conflict-resolver' },
                { label: 'Snapshotting',            slug: 'persistence/replicated-event-sourcing/snapshotting' },
              ],
            },
            {
              label: 'Object storage',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'persistence/object-storage/overview' },
                { label: 'Compression',             slug: 'persistence/object-storage/compression' },
                { label: 'Encryption',              slug: 'persistence/object-storage/encryption' },
                { label: 'Key rotation',            slug: 'persistence/object-storage/key-rotation' },
                { label: 'Per-actor policies',      slug: 'persistence/object-storage/per-actor-policies' },
                { label: 'Snapshot store backend',  slug: 'persistence/object-storage/snapshot-store-backend' },
              ],
            },
            {
              label: 'Migration',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'persistence/migration/overview' },
                { label: 'Recipes',                 slug: 'persistence/migration/recipes' },
                { label: 'Schema registry',         slug: 'persistence/migration/schema-registry' },
                { label: 'Envelope format',         slug: 'persistence/migration/envelope-format' },
                { label: 'Defaults adapter',        slug: 'persistence/migration/default-adapter' },
                { label: 'Migrating adapter',       slug: 'persistence/migration/migrating-adapter' },
                { label: 'Wrap legacy',             slug: 'persistence/migration/wrap-legacy' },
              ],
            },
            {
              label: 'FSM',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'persistence/fsm/overview' },
                { label: 'In-memory FSM',           slug: 'persistence/fsm/fsm' },
                { label: 'Persistent FSM',          slug: 'persistence/fsm/persistent-fsm' },
              ],
            },
            {
              label: 'Delivery',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'delivery/overview' },
                { label: 'Producer controller',     slug: 'delivery/producer-controller' },
                { label: 'Consumer controller',     slug: 'delivery/consumer-controller' },
                { label: 'Ack semantics',           slug: 'delivery/ack-semantics' },
              ],
            },
          ],
        },
        {
          label: '🔌 Integrate',
          collapsed: true,
          items: [
            {
              label: 'IO (brokers)',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'io/overview' },
                { label: 'BrokerActor base',        slug: 'io/broker-actor-base' },
                { label: 'Kafka',                   slug: 'io/kafka' },
                { label: 'MQTT',                    slug: 'io/mqtt' },
                { label: 'AMQP',                    slug: 'io/amqp' },
                { label: 'NATS',                    slug: 'io/nats' },
                { label: 'Redis Streams',           slug: 'io/redis-streams' },
                { label: 'gRPC',                    slug: 'io/grpc' },
                { label: 'SSE',                     slug: 'io/sse' },
                { label: 'WebSocket client',        slug: 'io/websocket' },
                { label: 'WebSocket server',        slug: 'io/server-websocket' },
                { label: 'TCP',                     slug: 'io/tcp' },
                { label: 'UDP',                     slug: 'io/udp' },
              ],
            },
            {
              label: 'HTTP',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'http/overview' },
                { label: 'Route DSL',               slug: 'http/route-dsl' },
                { label: 'Marshalling',             slug: 'http/marshalling' },
                {
                  label: 'Backends',
                  collapsed: true,
                  items: [
                    { label: 'Fastify',             slug: 'http/backends/fastify' },
                    { label: 'Express',             slug: 'http/backends/express' },
                    { label: 'Hono',                slug: 'http/backends/hono' },
                  ],
                },
                {
                  label: 'Middleware',
                  collapsed: true,
                  items: [
                    { label: 'Response cache',      slug: 'http/middleware/response-cache' },
                    { label: 'Rate limit',          slug: 'http/middleware/rate-limit' },
                    { label: 'Idempotency key',     slug: 'http/middleware/idempotency-key' },
                  ],
                },
              ],
            },
            {
              label: 'Cache',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'cache/overview' },
                { label: 'In-memory',               slug: 'cache/in-memory' },
                { label: 'Memcached',               slug: 'cache/memcached' },
                { label: 'Redis',                   slug: 'cache/redis' },
              ],
            },
            {
              label: 'Serialization',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'serialization/overview' },
                { label: 'JSON',                    slug: 'serialization/json' },
                { label: 'CBOR',                    slug: 'serialization/cbor' },
                { label: 'Custom serializers',      slug: 'serialization/custom' },
              ],
            },
          ],
        },
        {
          label: '📊 Observe',
          collapsed: true,
          items: [
            { label: 'Overview',                    slug: 'observability/overview' },
            {
              label: 'Metrics',
              collapsed: true,
              items: [
                { label: 'Core metrics',            slug: 'observability/metrics/core-metrics' },
                { label: 'Prometheus exporter',     slug: 'observability/metrics/prometheus-exporter' },
                { label: 'prom-client adapter',     slug: 'observability/metrics/prom-client-adapter' },
                { label: 'OTel adapter',            slug: 'observability/metrics/otel-adapter' },
                { label: 'Stock metrics',           slug: 'observability/metrics/stock-metrics' },
              ],
            },
            {
              label: 'Tracing',
              collapsed: true,
              items: [
                { label: 'Tracer API',              slug: 'observability/tracing/tracer-api' },
                { label: 'OTel adapter',            slug: 'observability/tracing/otel-adapter' },
                { label: 'Recording tracer',        slug: 'observability/tracing/recording-tracer' },
                { label: 'Actor tracing',           slug: 'observability/tracing/actor-tracing' },
              ],
            },
            {
              label: 'Management',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'observability/management/overview' },
                { label: 'Health checks',           slug: 'observability/management/health-checks' },
                { label: 'HTTP endpoints',          slug: 'observability/management/http-endpoints' },
              ],
            },
          ],
        },
        {
          label: '✅ Test',
          collapsed: true,
          items: [
            { label: 'Overview',                    slug: 'testing/overview' },
            { label: 'TestKit',                     slug: 'testing/testkit' },
            { label: 'TestProbe',                   slug: 'testing/test-probe' },
            { label: 'ManualScheduler',             slug: 'testing/manual-scheduler' },
            { label: 'MultiNodeSpec',               slug: 'testing/multi-node-spec' },
            { label: 'ParallelMultiNodeSpec',       slug: 'testing/parallel-multi-node' },
          ],
        },
        {
          label: '⚙️ Operate',
          collapsed: true,
          items: [
            { label: 'Overview',                    slug: 'operations/overview' },
            {
              label: 'Deployment',
              collapsed: true,
              items: [
                { label: 'Kubernetes',              slug: 'operations/deployment/kubernetes' },
                { label: 'Docker Compose',          slug: 'operations/deployment/docker-compose' },
                { label: 'Process manager',         slug: 'operations/deployment/process-manager' },
              ],
            },
            {
              label: 'Tuning',
              collapsed: true,
              items: [
                { label: 'Gossip cadence',          slug: 'operations/tuning/gossip-cadence' },
                { label: 'Failure detector',        slug: 'operations/tuning/failure-detector' },
                { label: 'Mailbox sizing',          slug: 'operations/tuning/mailbox-sizing' },
                { label: 'Dispatcher tuning',       slug: 'operations/tuning/dispatcher-tuning' },
              ],
            },
            {
              label: 'Security',
              collapsed: true,
              items: [
                { label: 'Cluster security',        slug: 'operations/security/cluster-security' },
                { label: 'Master key rotation',     slug: 'operations/security/master-key-rotation' },
                { label: 'TLS everywhere',          slug: 'operations/security/tls-everywhere' },
              ],
            },
            {
              label: 'Upgrades',
              collapsed: true,
              items: [
                { label: 'Rolling migration',       slug: 'operations/upgrades/rolling-migration' },
                { label: 'Upgrade strategies',      slug: 'operations/upgrades/upgrade-strategies' },
              ],
            },
            { label: 'Troubleshooting',             slug: 'operations/troubleshooting' },
            {
              label: 'Runtime',
              collapsed: true,
              items: [
                { label: 'Overview',                slug: 'runtime/overview' },
                { label: 'Compatibility matrix',    slug: 'runtime/compatibility-matrix' },
                { label: 'Bun',                     slug: 'runtime/bun' },
                { label: 'Node',                    slug: 'runtime/node' },
                { label: 'Deno',                    slug: 'runtime/deno' },
              ],
            },
          ],
        },
        {
          label: '💡 Examples',
          collapsed: true,
          items: [
            { label: 'Overview',                    slug: 'examples/overview' },
            { label: 'Chat sample',                 slug: 'examples/chat-sample' },
            { label: 'Voice sample',                slug: 'examples/voice-sample' },
            { label: 'Stand-alone snippets',        slug: 'examples/stand-alone-snippets' },
          ],
        },
        {
          label: '🚚 Migration',
          collapsed: true,
          items: [
            { label: 'Overview',                    slug: 'migration/overview' },
            { label: 'From Akka (JVM)',             slug: 'migration/from-akka-jvm' },
            { label: 'From Pekko',                  slug: 'migration/from-pekko' },
            { label: 'From Orleans',                slug: 'migration/from-orleans' },
            { label: 'From Akka.NET',               slug: 'migration/from-akka-net' },
            { label: 'From vanilla TS',             slug: 'migration/from-vanilla-ts' },
          ],
        },
        {
          label: '📖 Reference',
          collapsed: true,
          items: [
            { label: 'Configuration',               slug: 'reference/configuration' },
            { label: 'Version policy',              slug: 'reference/version-policy' },
            { label: 'FAQ',                         slug: 'reference/faq' },
            { label: 'Glossary',                    slug: 'reference/glossary' },
          ],
        },
        // API Reference group is registered by the starlight-typedoc
        // plugin — appears below the manual IA groups.
        typeDocSidebarGroup,
        {
          label: '🎁 Extras',
          collapsed: true,
          items: [
            { label: 'Design decisions',            slug: 'extras/design-decisions' },
            { label: 'Architecture Decision Records', slug: 'extras/architecture-decision-records' },
          ],
        },
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/pathosDev/actor-ts',
        },
      ],
      // EditLink lets readers propose docs edits with one click.  Useful
      // for catching typos / drift from a public site.
      editLink: {
        baseUrl: 'https://github.com/pathosDev/actor-ts/edit/main/docs/',
      },
      lastUpdated: true,
      // Show "Previous" / "Next" footer arrows on each page — Starlight
      // derives them from sidebar order, so they only appear once the
      // sidebar is wired (Commit 2.3).
      pagination: true,
    }),
  ],
});
