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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { createStarlightTypeDocPlugin } from 'starlight-typedoc';
import rehypeMermaid from 'rehype-mermaid';

// Make JetBrains Mono available inside Playwright/Chromium during
// Mermaid SSR so the headless browser measures text with the same
// font the user's runtime browser renders with (loaded via
// `@fontsource` in `custom.css`).  Without this, SSR falls back to a
// narrow sans-serif, computes too-small bboxes, and labels like
// "routee-1" get clipped to "routee-:" at runtime.
//
// The font is base64-embedded into a `@font-face` declaration so
// Playwright doesn't need network access or knowledge of our
// `node_modules` layout — it just sees plain CSS.  `rehype-mermaid`'s
// `css` option accepts a path to a CSS file, so we write the
// generated CSS to a build-time temp file the plugin picks up.
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const jetbrainsMonoB64 = readFileSync(
  resolve(__dirname, 'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2'),
).toString('base64');

// Custom Shiki grammars for languages that Starlight's bundled Shiki
// doesn't ship out of the box but that this codebase uses:
//   - HOCON (`.conf`)  — used in configuration + tuning + migration
//     docs; the canonical config format for JVM-style actor toolkits.
//   - PromQL            — used in observability + troubleshooting
//     docs for Prometheus example queries.
// Without these, expressive-code falls back to plain text and emits
// build-time warnings ("could not find language X").  The TextMate
// grammars live under `src/grammars/` and cover the syntactic surface
// each language actually exercises in the docs (comments, strings,
// keywords, numbers, durations, identifiers).
const hoconGrammar = JSON.parse(readFileSync(
  resolve(__dirname, 'src/grammars/hocon.tmLanguage.json'), 'utf-8',
));
const promqlGrammar = JSON.parse(readFileSync(
  resolve(__dirname, 'src/grammars/promql.tmLanguage.json'), 'utf-8',
));

const mermaidCssDir  = resolve(__dirname, '.astro');
const mermaidCssPath = resolve(mermaidCssDir, 'mermaid-fonts.css');
mkdirSync(mermaidCssDir, { recursive: true });
writeFileSync(
  mermaidCssPath,
  `@font-face {
  font-family: 'JetBrains Mono';
  font-weight: 400;
  font-style: normal;
  font-display: block;
  src: url(data:font/woff2;base64,${jetbrainsMonoB64}) format('woff2');
}
`,
);

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
          // Inject JetBrains Mono into the Playwright/Chromium page so
          // SSR text-measurement matches the runtime browser (which
          // also loads JetBrains Mono via @fontsource).  Without this
          // the headless Chromium falls back to a narrow sans-serif,
          // computes a too-small bbox, and node labels like "routee-1"
          // get clipped to "routee-:" at runtime.  The plugin's `css`
          // option expects a file PATH (not inline CSS) — generated
          // above into `.astro/mermaid-fonts.css`.
          css: mermaidCssPath,
          // Match our dark/light palette.  Mermaid's 'dark' theme uses a
          // dark background which fits Starlight's default dark mode;
          // light pages get re-themed via CSS variables on the SVG.
          mermaidConfig: {
            theme: 'dark',
            themeVariables: {
              // ---- Flowchart + state-diagram palette ----
              // Indigo accents, slate base — same palette as the logo.
              primaryColor:       '#1e293b',  // slate-800   — node bg
              primaryTextColor:   '#f1f5f9',  // slate-100   — node text
              primaryBorderColor: '#6366f1',  // indigo-500  — node border
              lineColor:          '#94a3b8',  // slate-400   — connection lines
              secondaryColor:     '#312e81',  // indigo-900  — alt node bg
              tertiaryColor:      '#0f172a',  // slate-900   — bg

              // ---- Sequence-diagram palette ----
              // Mermaid uses an entirely separate set of variables for
              // sequence diagrams — the flowchart `primaryColor` etc.
              // are NOT picked up there.  Mirror the indigo/slate look
              // explicitly so sequence diagrams don't render as plain
              // grey while the rest of the docs use the brand palette.
              actorBkg:              '#1e293b',  // slate-800  — actor box bg
              actorBorder:           '#6366f1',  // indigo-500 — actor box border
              actorTextColor:        '#f1f5f9',  // slate-100  — actor name
              actorLineColor:        '#475569',  // slate-600  — vertical lifelines
              signalColor:           '#94a3b8',  // slate-400  — arrows
              signalTextColor:       '#cbd5e1',  // slate-300  — arrow labels
              noteBkgColor:          '#312e81',  // indigo-900 — note bg
              noteBorderColor:       '#818cf8',  // indigo-400 — note border
              noteTextColor:         '#f1f5f9',  // slate-100  — note text
              labelBoxBkgColor:      '#0f172a',  // slate-900  — sequence-numbered loop labels
              labelBoxBorderColor:   '#6366f1',  // indigo-500
              labelTextColor:        '#f1f5f9',
              loopTextColor:         '#cbd5e1',  // slate-300
              activationBkgColor:    '#312e81',  // indigo-900 — activation bar bg
              activationBorderColor: '#818cf8',  // indigo-400
              sequenceNumberColor:   '#0f172a',  // slate-900  — sequence-step circles

              // JetBrains Mono matches the rest of the site's code-block
              // font + the logo wordmark — keeps diagrams visually
              // unified with the surrounding docs.  Loaded into
              // Playwright via the `css` option above so SSR and
              // runtime measure with the same font.
              fontFamily:         "'JetBrains Mono', ui-monospace, monospace",
              fontSize:           '14px',
            },
            flowchart:  { htmlLabels: true, curve: 'basis', padding: 12 },
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
        'Actor model for TypeScript. Runs on Bun, Node, and Deno. ' +
        'Cluster sharding, event sourcing, distributed data, persistence, and ' +
        'observability — all in idiomatic TS.',
      // Logo in the top-nav uses the PNG variant without the tagline —
      // the tagline would be unreadable at navbar height, and PNG avoids
      // font-fallback drift on systems without JetBrains Mono.  The full
      // logo with tagline is reserved for the splash hero + README.
      logo: { src: './public/logo-header.png', replacesTitle: true },
      // Register custom Shiki grammars so HOCON + PromQL code blocks
      // get proper syntax highlighting instead of falling back to
      // plain text + emitting "language not found" build warnings.
      // Grammars live under `src/grammars/`; loaded above.
      expressiveCode: {
        shiki: {
          langs: [hoconGrammar, promqlGrammar],
        },
      },
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
        // Order matters: starlight-typedoc runs first and replaces its
        // sidebar-group placeholder with the auto-generated API tree.
        // The patch plugin below then walks the resulting sidebar and
        // injects a `translations.de` field on the API Reference group
        // — required because starlight-typedoc only preserves `badge`
        // (not `translations`) when substituting its placeholder.
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
            label: '🧰 API Reference',
            // `translations` is applied at the sidebar level below
            // (`{ ...typeDocSidebarGroup, translations: { de: ... } }`)
            // because the plugin's sidebar option doesn't propagate
            // the `translations` key into the generated SidebarItem.
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
        // Patch the API Reference group label with a German translation.
        // starlight-typedoc's placeholder-substitution drops everything
        // except `label`/`collapsed`/`items`/`badge` — `translations`
        // can't be passed through its plugin options, so we walk the
        // sidebar here AFTER it has run and inject the DE label.
        {
          name: 'patch-typedoc-sidebar-translations',
          hooks: {
            'config:setup'({ config, updateConfig }) {
              const patchSidebar = (items) => {
                if (!Array.isArray(items)) return items;
                return items.map((item) => {
                  if (item && typeof item === 'object' && 'label' in item) {
                    if (item.label === '🧰 API Reference') {
                      return { ...item, translations: { de: '🧰 API-Referenz' } };
                    }
                    if ('items' in item && Array.isArray(item.items)) {
                      return { ...item, items: patchSidebar(item.items) };
                    }
                  }
                  return item;
                });
              };
              updateConfig({ sidebar: patchSidebar(config.sidebar) });
            },
          },
        },
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
          translations: { de: '🚀 Erste Schritte' },
          collapsed: false, // first impression: keep this one open
          items: [
            { label: 'What is actor-ts?', slug: 'intro/what-is-actor-ts', translations: { de: 'Was ist actor-ts?' } },
            { label: 'Why actors?',       slug: 'intro/why-actors',       translations: { de: 'Warum Actors?' } },
            { label: 'Installation',      slug: 'intro/installation',     translations: { de: 'Installation' } },
            { label: 'Quickstart',        slug: 'intro/quickstart',       translations: { de: 'Schnellstart' } },
            { label: 'Learning path',     slug: 'intro/learning-path',    translations: { de: 'Lernpfad' } },
            { label: 'Glossary',          slug: 'intro/glossary',         translations: { de: 'Glossar' } },
          ],
        },
        {
          label: '🎭 Build Actors',
          translations: { de: '🎭 Aktoren entwickeln' },
          collapsed: true,
          items: [
            {
              label: 'Fundamentals',
              translations: { de: 'Grundlagen' },
              collapsed: true,
              items: [
                { label: 'Overview',              slug: 'fundamentals/overview',              translations: { de: 'Überblick' } },
                { label: 'Actor',                 slug: 'fundamentals/actor',                 translations: { de: 'Actor' } },
                { label: 'Messages',              slug: 'fundamentals/messages',              translations: { de: 'Nachrichten' } },
                { label: 'Ask pattern',           slug: 'fundamentals/ask-pattern',           translations: { de: 'Ask-Pattern' } },
                { label: 'ActorSystem',           slug: 'fundamentals/actor-system',          translations: { de: 'ActorSystem' } },
                { label: 'Actor paths',           slug: 'fundamentals/actor-paths',           translations: { de: 'Actor-Pfade' } },
                { label: 'Props',                 slug: 'fundamentals/props',                 translations: { de: 'Props' } },
                { label: 'Become and stash',     slug: 'fundamentals/become-and-stash',      translations: { de: 'Become und Stash' } },
                { label: 'Death watch',           slug: 'fundamentals/death-watch',           translations: { de: 'Death Watch' } },
                { label: 'Supervision',           slug: 'fundamentals/supervision',           translations: { de: 'Supervision' } },
                { label: 'Dispatchers',           slug: 'fundamentals/dispatchers',           translations: { de: 'Dispatcher' } },
                { label: 'Mailboxes',             slug: 'fundamentals/mailboxes',             translations: { de: 'Mailboxes' } },
                { label: 'Timers and scheduling', slug: 'fundamentals/timers-and-scheduling', translations: { de: 'Timer und Scheduling' } },
                { label: 'Receive timeout',       slug: 'fundamentals/receive-timeout',       translations: { de: 'Receive-Timeout' } },
                { label: 'Coordinated shutdown',  slug: 'fundamentals/coordinated-shutdown',  translations: { de: 'Koordinierter Shutdown' } },
                { label: 'Event stream',          slug: 'fundamentals/event-stream',          translations: { de: 'Event-Stream' } },
                { label: 'Logging',               slug: 'fundamentals/logging',               translations: { de: 'Logging' } },
                { label: 'PoisonPill and Kill',   slug: 'fundamentals/poison-pill-and-kill',  translations: { de: 'PoisonPill und Kill' } },
                { label: 'Pattern matching',      slug: 'fundamentals/pattern-matching',      translations: { de: 'Pattern Matching' } },
              ],
            },
            {
              label: 'Typed actors',
              translations: { de: 'Typisierte Actors' },
              collapsed: true,
              items: [
                { label: 'Overview',       slug: 'typed/overview',     translations: { de: 'Überblick' } },
                { label: 'TypedActor',     slug: 'typed/typed-actor',  translations: { de: 'TypedActor' } },
                { label: 'Behaviors',      slug: 'typed/behaviors',    translations: { de: 'Behaviors' } },
                { label: 'Spawning typed', slug: 'typed/spawn-typed',  translations: { de: 'Typisierte erstellen' } },
              ],
            },
            {
              label: 'Routing',
              translations: { de: 'Routing' },
              collapsed: true,
              items: [
                { label: 'Overview',      slug: 'routing/overview',      translations: { de: 'Überblick' } },
                { label: 'Router',        slug: 'routing/router',        translations: { de: 'Router' } },
                { label: 'Strategies',    slug: 'routing/strategies',    translations: { de: 'Strategien' } },
                { label: 'Pool vs group', slug: 'routing/pool-vs-group', translations: { de: 'Pool vs. Group' } },
              ],
            },
            {
              label: 'Patterns',
              translations: { de: 'Patterns' },
              collapsed: true,
              items: [
                { label: 'Circuit breaker',    slug: 'patterns/circuit-breaker',    translations: { de: 'Circuit Breaker' } },
                { label: 'Backoff supervisor', slug: 'patterns/backoff-supervisor', translations: { de: 'Backoff Supervisor' } },
                { label: 'Backoff policy',     slug: 'patterns/backoff-policy',     translations: { de: 'Backoff-Policy' } },
                { label: 'Retry',              slug: 'patterns/retry',              translations: { de: 'Retry' } },
                { label: 'Future patterns',    slug: 'patterns/futures-patterns',   translations: { de: 'Future-Patterns' } },
              ],
            },
          ],
        },
        {
          label: '🌐 Distribute',
          translations: { de: '🌐 Verteilen' },
          collapsed: true,
          items: [
            {
              label: 'Cluster',
              translations: { de: 'Cluster' },
              collapsed: true,
              items: [
                { label: 'Overview',           slug: 'cluster/overview',           translations: { de: 'Überblick' } },
                { label: 'Joining and seeds',  slug: 'cluster/joining-and-seeds',  translations: { de: 'Beitritt und Seeds' } },
                { label: 'Failure detector',   slug: 'cluster/failure-detector',   translations: { de: 'Failure Detector' } },
                { label: 'Downing strategies', slug: 'cluster/downing-strategies', translations: { de: 'Downing-Strategien' } },
                { label: 'Transports',         slug: 'cluster/transports',         translations: { de: 'Transporte' } },
                { label: 'Weakly-up',          slug: 'cluster/weakly-up',          translations: { de: 'Weakly-Up' } },
                { label: 'Refs across nodes',  slug: 'cluster/refs-across-nodes',  translations: { de: 'Refs über Nodes hinweg' } },
                { label: 'Distributed PubSub', slug: 'cluster/pubsub',             translations: { de: 'Distributed PubSub' } },
                {
                  label: 'Singleton',
                  translations: { de: 'Singleton' },
                  collapsed: true,
                  items: [
                    { label: 'Overview',   slug: 'cluster/singleton/overview',   translations: { de: 'Überblick' } },
                    { label: 'Manager',    slug: 'cluster/singleton/manager',    translations: { de: 'Manager' } },
                    { label: 'With lease', slug: 'cluster/singleton/with-lease', translations: { de: 'Mit Lease' } },
                  ],
                },
                {
                  label: 'Sharding',
                  translations: { de: 'Sharding' },
                  collapsed: true,
                  items: [
                    { label: 'Overview',            slug: 'cluster/sharding/overview',                translations: { de: 'Überblick' } },
                    { label: 'Allocation strategy', slug: 'cluster/sharding/allocation-strategy',     translations: { de: 'Allocation-Strategie' } },
                    { label: 'Rebalance',           slug: 'cluster/sharding/rebalance',               translations: { de: 'Rebalance' } },
                    { label: 'Remember entities',   slug: 'cluster/sharding/remember-entities',       translations: { de: 'Entities merken' } },
                    { label: 'With lease',          slug: 'cluster/sharding/with-lease',              translations: { de: 'Mit Lease' } },
                    { label: 'Sharded daemon',      slug: 'cluster/sharding/sharded-daemon-process',  translations: { de: 'Sharded Daemon' } },
                  ],
                },
                { label: 'Cluster router',   slug: 'cluster/cluster-router',   translations: { de: 'Cluster-Router' } },
                { label: 'Cluster client',   slug: 'cluster/cluster-client',   translations: { de: 'Cluster-Client' } },
                { label: 'Cluster security', slug: 'cluster/cluster-security', translations: { de: 'Cluster-Sicherheit' } },
                { label: 'Worker mesh',      slug: 'cluster/worker-mesh',      translations: { de: 'Worker-Mesh' } },
              ],
            },
            {
              label: 'Distributed Data',
              translations: { de: 'Distributed Data' },
              collapsed: true,
              items: [
                { label: 'Overview', slug: 'distributed-data/overview', translations: { de: 'Überblick' } },
                {
                  label: 'CRDT types',
                  translations: { de: 'CRDT-Typen' },
                  collapsed: true,
                  items: [
                    { label: 'Counters',       slug: 'distributed-data/crdt-types/counters',       translations: { de: 'Counter' } },
                    { label: 'Registers',      slug: 'distributed-data/crdt-types/registers',      translations: { de: 'Register' } },
                    { label: 'Sets',           slug: 'distributed-data/crdt-types/sets',           translations: { de: 'Sets' } },
                    { label: 'Maps',           slug: 'distributed-data/crdt-types/maps',           translations: { de: 'Maps' } },
                    { label: 'Designing data', slug: 'distributed-data/crdt-types/designing-data', translations: { de: 'Datenmodellierung' } },
                  ],
                },
                { label: 'Replication',         slug: 'distributed-data/replication',         translations: { de: 'Replikation' } },
                { label: 'Quorum reads/writes', slug: 'distributed-data/quorum-reads-writes', translations: { de: 'Quorum-Reads/Writes' } },
                { label: 'Durable storage',     slug: 'distributed-data/durable-storage',     translations: { de: 'Durable Storage' } },
              ],
            },
            {
              label: 'Coordination',
              translations: { de: 'Koordination' },
              collapsed: true,
              items: [
                { label: 'Overview',         slug: 'coordination/overview',         translations: { de: 'Überblick' } },
                { label: 'Lease API',        slug: 'coordination/lease-api',        translations: { de: 'Lease-API' } },
                { label: 'In-memory lease',  slug: 'coordination/in-memory-lease',  translations: { de: 'In-Memory-Lease' } },
                { label: 'Kubernetes lease', slug: 'coordination/kubernetes-lease', translations: { de: 'Kubernetes-Lease' } },
              ],
            },
            {
              label: 'Discovery',
              translations: { de: 'Discovery' },
              collapsed: true,
              items: [
                { label: 'Overview', slug: 'discovery/overview', translations: { de: 'Überblick' } },
                {
                  label: 'Seed providers',
                  translations: { de: 'Seed-Provider' },
                  collapsed: true,
                  items: [
                    { label: 'Config',         slug: 'discovery/seed-providers/config',         translations: { de: 'Config' } },
                    { label: 'DNS',            slug: 'discovery/seed-providers/dns',            translations: { de: 'DNS' } },
                    { label: 'Kubernetes API', slug: 'discovery/seed-providers/kubernetes-api', translations: { de: 'Kubernetes-API' } },
                    { label: 'Aggregate',      slug: 'discovery/seed-providers/aggregate',      translations: { de: 'Aggregate' } },
                  ],
                },
                { label: 'Receptionist', slug: 'discovery/receptionist', translations: { de: 'Receptionist' } },
              ],
            },
          ],
        },
        {
          label: '💾 Persist',
          translations: { de: '💾 Persistieren' },
          collapsed: true,
          items: [
            {
              label: 'Event sourcing',
              translations: { de: 'Event Sourcing' },
              collapsed: true,
              items: [
                { label: 'Overview',          slug: 'persistence/overview',          translations: { de: 'Überblick' } },
                { label: 'PersistentActor',   slug: 'persistence/persistent-actor',  translations: { de: 'PersistentActor' } },
                { label: 'Event dispatcher',  slug: 'persistence/event-dispatcher',  translations: { de: 'Event-Dispatcher' } },
                { label: 'Snapshots',         slug: 'persistence/snapshots',         translations: { de: 'Snapshots' } },
                { label: 'Durable state',     slug: 'persistence/durable-state',     translations: { de: 'Durable State' } },
                { label: 'Projections',       slug: 'persistence/projections',       translations: { de: 'Projektionen' } },
                { label: 'Persistence query', slug: 'persistence/persistence-query', translations: { de: 'Persistence-Query' } },
                { label: 'Push-based query',  slug: 'persistence/push-based-query',  translations: { de: 'Push-basierte Query' } },
              ],
            },
            {
              label: 'Journals',
              translations: { de: 'Journals' },
              collapsed: true,
              items: [
                { label: 'In-memory', slug: 'persistence/journals/in-memory', translations: { de: 'In-Memory' } },
                { label: 'SQLite',    slug: 'persistence/journals/sqlite',    translations: { de: 'SQLite' } },
                { label: 'Cassandra', slug: 'persistence/journals/cassandra', translations: { de: 'Cassandra' } },
              ],
            },
            {
              label: 'Snapshot stores',
              translations: { de: 'Snapshot Stores' },
              collapsed: true,
              items: [
                { label: 'In-memory',             slug: 'persistence/snapshot-stores/in-memory',             translations: { de: 'In-Memory' } },
                { label: 'SQLite',                slug: 'persistence/snapshot-stores/sqlite',                translations: { de: 'SQLite' } },
                { label: 'Cached snapshot store', slug: 'persistence/snapshot-stores/cached-snapshot-store', translations: { de: 'Cached Snapshot Store' } },
              ],
            },
            {
              label: 'Replicated event sourcing',
              translations: { de: 'Replicated Event Sourcing' },
              collapsed: true,
              items: [
                { label: 'Overview',            slug: 'persistence/replicated-event-sourcing/overview',            translations: { de: 'Überblick' } },
                { label: 'Single-writer lease', slug: 'persistence/replicated-event-sourcing/single-writer-lease', translations: { de: 'Single-Writer-Lease' } },
                { label: 'Vector clocks',       slug: 'persistence/replicated-event-sourcing/vector-clocks',       translations: { de: 'Vector Clocks' } },
                { label: 'Conflict resolver',   slug: 'persistence/replicated-event-sourcing/conflict-resolver',   translations: { de: 'Conflict Resolver' } },
                { label: 'Snapshotting',        slug: 'persistence/replicated-event-sourcing/snapshotting',        translations: { de: 'Snapshotting' } },
              ],
            },
            {
              label: 'Object storage',
              translations: { de: 'Object Storage' },
              collapsed: true,
              items: [
                { label: 'Overview',               slug: 'persistence/object-storage/overview',               translations: { de: 'Überblick' } },
                { label: 'Compression',            slug: 'persistence/object-storage/compression',            translations: { de: 'Kompression' } },
                { label: 'Encryption',             slug: 'persistence/object-storage/encryption',             translations: { de: 'Verschlüsselung' } },
                { label: 'Key rotation',           slug: 'persistence/object-storage/key-rotation',           translations: { de: 'Key-Rotation' } },
                { label: 'Per-actor policies',     slug: 'persistence/object-storage/per-actor-policies',     translations: { de: 'Per-Actor-Policies' } },
                { label: 'Snapshot store backend', slug: 'persistence/object-storage/snapshot-store-backend', translations: { de: 'Snapshot-Store-Backend' } },
              ],
            },
            {
              label: 'Migration',
              translations: { de: 'Migration' },
              collapsed: true,
              items: [
                { label: 'Overview',          slug: 'persistence/migration/overview',          translations: { de: 'Überblick' } },
                { label: 'Recipes',           slug: 'persistence/migration/recipes',           translations: { de: 'Rezepte' } },
                { label: 'Schema registry',   slug: 'persistence/migration/schema-registry',   translations: { de: 'Schema-Registry' } },
                { label: 'Envelope format',   slug: 'persistence/migration/envelope-format',   translations: { de: 'Envelope-Format' } },
                { label: 'Defaults adapter',  slug: 'persistence/migration/default-adapter',   translations: { de: 'Default-Adapter' } },
                { label: 'Migrating adapter', slug: 'persistence/migration/migrating-adapter', translations: { de: 'Migrating-Adapter' } },
                { label: 'Wrap legacy',       slug: 'persistence/migration/wrap-legacy',       translations: { de: 'Legacy wrappen' } },
              ],
            },
            {
              label: 'FSM',
              translations: { de: 'FSM' },
              collapsed: true,
              items: [
                { label: 'Overview',       slug: 'persistence/fsm/overview',       translations: { de: 'Überblick' } },
                { label: 'In-memory FSM',  slug: 'persistence/fsm/fsm',            translations: { de: 'In-Memory-FSM' } },
                { label: 'Persistent FSM', slug: 'persistence/fsm/persistent-fsm', translations: { de: 'Persistent FSM' } },
              ],
            },
            {
              label: 'Delivery',
              translations: { de: 'Delivery' },
              collapsed: true,
              items: [
                { label: 'Overview',            slug: 'delivery/overview',            translations: { de: 'Überblick' } },
                { label: 'Producer controller', slug: 'delivery/producer-controller', translations: { de: 'Producer Controller' } },
                { label: 'Consumer controller', slug: 'delivery/consumer-controller', translations: { de: 'Consumer Controller' } },
                { label: 'Ack semantics',       slug: 'delivery/ack-semantics',       translations: { de: 'Ack-Semantik' } },
              ],
            },
          ],
        },
        {
          label: '🔌 Integrate',
          translations: { de: '🔌 Integrieren' },
          collapsed: true,
          items: [
            {
              label: 'IO (brokers)',
              translations: { de: 'IO (Broker)' },
              collapsed: true,
              items: [
                { label: 'Overview',         slug: 'io/overview',          translations: { de: 'Überblick' } },
                { label: 'BrokerActor base', slug: 'io/broker-actor-base', translations: { de: 'BrokerActor-Basis' } },
                { label: 'Kafka',            slug: 'io/kafka',             translations: { de: 'Kafka' } },
                { label: 'MQTT',             slug: 'io/mqtt',              translations: { de: 'MQTT' } },
                { label: 'AMQP',             slug: 'io/amqp',              translations: { de: 'AMQP' } },
                { label: 'NATS',             slug: 'io/nats',              translations: { de: 'NATS' } },
                { label: 'Redis Streams',    slug: 'io/redis-streams',     translations: { de: 'Redis Streams' } },
                { label: 'gRPC',             slug: 'io/grpc',              translations: { de: 'gRPC' } },
                { label: 'SSE',              slug: 'io/sse',               translations: { de: 'SSE' } },
                { label: 'WebSocket client', slug: 'io/websocket',         translations: { de: 'WebSocket-Client' } },
                { label: 'WebSocket server', slug: 'io/server-websocket',  translations: { de: 'WebSocket-Server' } },
                { label: 'TCP',              slug: 'io/tcp',               translations: { de: 'TCP' } },
                { label: 'UDP',              slug: 'io/udp',               translations: { de: 'UDP' } },
              ],
            },
            {
              label: 'HTTP',
              translations: { de: 'HTTP' },
              collapsed: true,
              items: [
                { label: 'Overview',    slug: 'http/overview',    translations: { de: 'Überblick' } },
                { label: 'Route DSL',   slug: 'http/route-dsl',   translations: { de: 'Route-DSL' } },
                { label: 'Marshalling', slug: 'http/marshalling', translations: { de: 'Marshalling' } },
                {
                  label: 'Backends',
                  translations: { de: 'Backends' },
                  collapsed: true,
                  items: [
                    { label: 'Fastify', slug: 'http/backends/fastify', translations: { de: 'Fastify' } },
                    { label: 'Express', slug: 'http/backends/express', translations: { de: 'Express' } },
                    { label: 'Hono',    slug: 'http/backends/hono',    translations: { de: 'Hono' } },
                  ],
                },
                {
                  label: 'Middleware',
                  translations: { de: 'Middleware' },
                  collapsed: true,
                  items: [
                    { label: 'Response cache',  slug: 'http/middleware/response-cache',  translations: { de: 'Response-Cache' } },
                    { label: 'Rate limit',      slug: 'http/middleware/rate-limit',      translations: { de: 'Rate-Limit' } },
                    { label: 'Idempotency key', slug: 'http/middleware/idempotency-key', translations: { de: 'Idempotency-Key' } },
                  ],
                },
              ],
            },
            {
              label: 'Cache',
              translations: { de: 'Cache' },
              collapsed: true,
              items: [
                { label: 'Overview',  slug: 'cache/overview',  translations: { de: 'Überblick' } },
                { label: 'In-memory', slug: 'cache/in-memory', translations: { de: 'In-Memory' } },
                { label: 'Memcached', slug: 'cache/memcached', translations: { de: 'Memcached' } },
                { label: 'Redis',     slug: 'cache/redis',     translations: { de: 'Redis' } },
              ],
            },
            {
              label: 'Serialization',
              translations: { de: 'Serialisierung' },
              collapsed: true,
              items: [
                { label: 'Overview',           slug: 'serialization/overview', translations: { de: 'Überblick' } },
                { label: 'JSON',               slug: 'serialization/json',     translations: { de: 'JSON' } },
                { label: 'CBOR',               slug: 'serialization/cbor',     translations: { de: 'CBOR' } },
                { label: 'Custom serializers', slug: 'serialization/custom',   translations: { de: 'Eigene Serializer' } },
              ],
            },
          ],
        },
        {
          label: '📊 Observe',
          translations: { de: '📊 Beobachten' },
          collapsed: true,
          items: [
            { label: 'Overview', slug: 'observability/overview', translations: { de: 'Überblick' } },
            {
              label: 'Metrics',
              translations: { de: 'Metriken' },
              collapsed: true,
              items: [
                { label: 'Core metrics',        slug: 'observability/metrics/core-metrics',        translations: { de: 'Core-Metriken' } },
                { label: 'Prometheus exporter', slug: 'observability/metrics/prometheus-exporter', translations: { de: 'Prometheus-Exporter' } },
                { label: 'prom-client adapter', slug: 'observability/metrics/prom-client-adapter', translations: { de: 'prom-client-Adapter' } },
                { label: 'OTel adapter',        slug: 'observability/metrics/otel-adapter',        translations: { de: 'OTel-Adapter' } },
                { label: 'Stock metrics',       slug: 'observability/metrics/stock-metrics',       translations: { de: 'Stock-Metriken' } },
              ],
            },
            {
              label: 'Tracing',
              translations: { de: 'Tracing' },
              collapsed: true,
              items: [
                { label: 'Tracer API',       slug: 'observability/tracing/tracer-api',       translations: { de: 'Tracer-API' } },
                { label: 'OTel adapter',     slug: 'observability/tracing/otel-adapter',     translations: { de: 'OTel-Adapter' } },
                { label: 'Recording tracer', slug: 'observability/tracing/recording-tracer', translations: { de: 'Recording-Tracer' } },
                { label: 'Actor tracing',    slug: 'observability/tracing/actor-tracing',    translations: { de: 'Actor-Tracing' } },
              ],
            },
            {
              label: 'Management',
              translations: { de: 'Management' },
              collapsed: true,
              items: [
                { label: 'Overview',       slug: 'observability/management/overview',       translations: { de: 'Überblick' } },
                { label: 'Health checks',  slug: 'observability/management/health-checks',  translations: { de: 'Health-Checks' } },
                { label: 'HTTP endpoints', slug: 'observability/management/http-endpoints', translations: { de: 'HTTP-Endpoints' } },
              ],
            },
          ],
        },
        {
          label: '✅ Test',
          translations: { de: '✅ Testen' },
          collapsed: true,
          items: [
            { label: 'Overview',              slug: 'testing/overview',            translations: { de: 'Überblick' } },
            { label: 'TestKit',               slug: 'testing/testkit',             translations: { de: 'TestKit' } },
            { label: 'TestProbe',             slug: 'testing/test-probe',          translations: { de: 'TestProbe' } },
            { label: 'ManualScheduler',       slug: 'testing/manual-scheduler',    translations: { de: 'ManualScheduler' } },
            { label: 'MultiNodeSpec',         slug: 'testing/multi-node-spec',     translations: { de: 'MultiNodeSpec' } },
            { label: 'ParallelMultiNodeSpec', slug: 'testing/parallel-multi-node', translations: { de: 'ParallelMultiNodeSpec' } },
          ],
        },
        {
          label: '⚙️ Operate',
          translations: { de: '⚙️ Betreiben' },
          collapsed: true,
          items: [
            { label: 'Overview', slug: 'operations/overview', translations: { de: 'Überblick' } },
            {
              label: 'Deployment',
              translations: { de: 'Deployment' },
              collapsed: true,
              items: [
                { label: 'Kubernetes',      slug: 'operations/deployment/kubernetes',      translations: { de: 'Kubernetes' } },
                { label: 'Docker Compose',  slug: 'operations/deployment/docker-compose',  translations: { de: 'Docker Compose' } },
                { label: 'Process manager', slug: 'operations/deployment/process-manager', translations: { de: 'Process-Manager' } },
              ],
            },
            {
              label: 'Tuning',
              translations: { de: 'Tuning' },
              collapsed: true,
              items: [
                { label: 'Gossip cadence',    slug: 'operations/tuning/gossip-cadence',    translations: { de: 'Gossip-Kadenz' } },
                { label: 'Failure detector',  slug: 'operations/tuning/failure-detector',  translations: { de: 'Failure Detector' } },
                { label: 'Mailbox sizing',    slug: 'operations/tuning/mailbox-sizing',    translations: { de: 'Mailbox-Sizing' } },
                { label: 'Dispatcher tuning', slug: 'operations/tuning/dispatcher-tuning', translations: { de: 'Dispatcher-Tuning' } },
              ],
            },
            {
              label: 'Security',
              translations: { de: 'Sicherheit' },
              collapsed: true,
              items: [
                { label: 'Cluster security',    slug: 'operations/security/cluster-security',    translations: { de: 'Cluster-Sicherheit' } },
                { label: 'Master key rotation', slug: 'operations/security/master-key-rotation', translations: { de: 'Master-Key-Rotation' } },
                { label: 'TLS everywhere',      slug: 'operations/security/tls-everywhere',      translations: { de: 'TLS überall' } },
              ],
            },
            {
              label: 'Upgrades',
              translations: { de: 'Upgrades' },
              collapsed: true,
              items: [
                { label: 'Rolling migration',  slug: 'operations/upgrades/rolling-migration',  translations: { de: 'Rolling Migration' } },
                { label: 'Upgrade strategies', slug: 'operations/upgrades/upgrade-strategies', translations: { de: 'Upgrade-Strategien' } },
              ],
            },
            { label: 'Troubleshooting', slug: 'operations/troubleshooting', translations: { de: 'Troubleshooting' } },
            {
              label: 'Runtime',
              translations: { de: 'Runtime' },
              collapsed: true,
              items: [
                { label: 'Overview',             slug: 'runtime/overview',             translations: { de: 'Überblick' } },
                { label: 'Compatibility matrix', slug: 'runtime/compatibility-matrix', translations: { de: 'Kompatibilitätsmatrix' } },
                { label: 'Bun',                  slug: 'runtime/bun',                  translations: { de: 'Bun' } },
                { label: 'Node',                 slug: 'runtime/node',                 translations: { de: 'Node' } },
                { label: 'Deno',                 slug: 'runtime/deno',                 translations: { de: 'Deno' } },
              ],
            },
          ],
        },
        {
          label: '💡 Examples',
          translations: { de: '💡 Beispiele' },
          collapsed: true,
          items: [
            { label: 'Overview',             slug: 'examples/overview',             translations: { de: 'Überblick' } },
            { label: 'Chat sample',          slug: 'examples/chat-sample',          translations: { de: 'Chat-Beispiel' } },
            { label: 'Voice sample',         slug: 'examples/voice-sample',         translations: { de: 'Voice-Beispiel' } },
            { label: 'Stand-alone snippets', slug: 'examples/stand-alone-snippets', translations: { de: 'Standalone-Snippets' } },
          ],
        },
        {
          label: '🚚 Migration',
          translations: { de: '🚚 Migration' },
          collapsed: true,
          items: [
            { label: 'Overview',        slug: 'migration/overview',        translations: { de: 'Überblick' } },
            { label: 'From Akka (JVM)', slug: 'migration/from-akka-jvm',   translations: { de: 'Von Akka (JVM)' } },
            { label: 'From Pekko',      slug: 'migration/from-pekko',      translations: { de: 'Von Pekko' } },
            { label: 'From Orleans',    slug: 'migration/from-orleans',    translations: { de: 'Von Orleans' } },
            { label: 'From Akka.NET',   slug: 'migration/from-akka-net',   translations: { de: 'Von Akka.NET' } },
            { label: 'From vanilla TS', slug: 'migration/from-vanilla-ts', translations: { de: 'Von Vanilla-TS' } },
          ],
        },
        {
          label: '📖 Reference',
          translations: { de: '📖 Referenz' },
          collapsed: true,
          items: [
            { label: 'Configuration',  slug: 'reference/configuration',  translations: { de: 'Konfiguration' } },
            { label: 'Version policy', slug: 'reference/version-policy', translations: { de: 'Versionsrichtlinie' } },
            { label: 'FAQ',            slug: 'reference/faq',            translations: { de: 'FAQ' } },
            { label: 'Glossary',       slug: 'reference/glossary',       translations: { de: 'Glossar' } },
          ],
        },
        // API Reference group is registered by the starlight-typedoc
        // plugin — appears below the manual IA groups.  The German
        // label is injected by the `patch-typedoc-sidebar-translations`
        // plugin below, because starlight-typedoc replaces this
        // placeholder with its own generated group (preserving only
        // `badge`, not `translations`).
        typeDocSidebarGroup,
        {
          label: '🎁 Extras',
          translations: { de: '🎁 Extras' },
          collapsed: true,
          items: [
            { label: 'Design decisions',              slug: 'extras/design-decisions',              translations: { de: 'Design-Entscheidungen' } },
            { label: 'Architecture Decision Records', slug: 'extras/architecture-decision-records', translations: { de: 'Architecture Decision Records' } },
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
