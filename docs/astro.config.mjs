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
      // Replace Starlight's native-<select> language dropdown with a
      // custom popover that renders inline SVG flags next to each
      // locale's native-name label.  Native unicode flag emojis don't
      // render reliably on Windows (Chrome / Firefox show boxed letter
      // pairs instead of actual flags), so we ship our own SVGs via
      // the `country-flag-icons` package.  See the component file for
      // the keyboard / accessibility wiring.
      components: {
        LanguageSelect: './src/components/LanguageSelect.astro',
      },
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
                      return { ...item, translations: { de: '🧰 API-Referenz', es: '🧰 Referencia de API', fr: '🧰 Référence API', ja: '🧰 API リファレンス', ko: '🧰 API 참조', 'pt-BR': '🧰 Referência da API', ru: '🧰 Справочник API', 'zh-CN': '🧰 API 参考' } };
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
      // Nine locales: EN (root) + DE (full content) + seven pre-staged
      // locales for which only the sidebar + Starlight UI strings are
      // translated.  Page content for the pre-staged locales falls back
      // to the root EN content automatically; future translation PRs
      // can drop files under `docs/src/content/docs/<locale>/` without
      // any config change.
      locales: {
        root:    { label: 'English',              lang: 'en' },
        de:      { label: 'Deutsch',              lang: 'de' },
        es:      { label: 'Español',              lang: 'es' },
        fr:      { label: 'Français',             lang: 'fr' },
        ja:      { label: '日本語',                lang: 'ja' },
        ko:      { label: '한국어',                lang: 'ko' },
        'pt-BR': { label: 'Português (BR)',       lang: 'pt-BR' },
        ru:      { label: 'Русский',              lang: 'ru' },
        'zh-CN': { label: '简体中文',              lang: 'zh-CN' },
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
          translations: { de: '🚀 Erste Schritte', es: '🚀 Empezar', fr: '🚀 Démarrer', ja: '🚀 はじめに', ko: '🚀 시작하기', 'pt-BR': '🚀 Começando', ru: '🚀 Начало работы', 'zh-CN': '🚀 快速开始' },
          collapsed: false, // first impression: keep this one open
          items: [
            { label: 'What is actor-ts?', slug: 'intro/what-is-actor-ts', translations: { de: 'Was ist actor-ts?', es: '¿Qué es actor-ts?', fr: 'Qu’est-ce qu’actor-ts ?', ja: 'actor-ts とは？', ko: 'actor-ts란?', 'pt-BR': 'O que é actor-ts?', ru: 'Что такое actor-ts?', 'zh-CN': '什么是 actor-ts?' } },
            { label: 'Why actors?',       slug: 'intro/why-actors',       translations: { de: 'Warum Actors?', es: '¿Por qué actores?', fr: 'Pourquoi les Actors ?', ja: 'なぜアクターか？', ko: '왜 액터인가?', 'pt-BR': 'Por que atores?', ru: 'Зачем акторы?', 'zh-CN': '为什么选择 Actor?' } },
            { label: 'Installation',      slug: 'intro/installation',     translations: { de: 'Installation', es: 'Instalación', fr: 'Installation', ja: 'インストール', ko: '설치', 'pt-BR': 'Instalação', ru: 'Установка', 'zh-CN': '安装' } },
            { label: 'Quickstart',        slug: 'intro/quickstart',       translations: { de: 'Schnellstart', es: 'Inicio rápido', fr: 'Démarrage rapide', ja: 'クイックスタート', ko: '빠른 시작', 'pt-BR': 'Início rápido', ru: 'Быстрый старт', 'zh-CN': '快速上手' } },
            { label: 'Learning path',     slug: 'intro/learning-path',    translations: { de: 'Lernpfad', es: 'Ruta de aprendizaje', fr: 'Parcours d’apprentissage', ja: '学習パス', ko: '학습 경로', 'pt-BR': 'Trilha de aprendizado', ru: 'Путь обучения', 'zh-CN': '学习路径' } },
            { label: 'Glossary',          slug: 'intro/glossary',         translations: { de: 'Glossar', es: 'Glosario', fr: 'Glossaire', ja: '用語集', ko: '용어집', 'pt-BR': 'Glossário', ru: 'Глоссарий', 'zh-CN': '术语表' } },
          ],
        },
        {
          label: '🎭 Build Actors',
          translations: { de: '🎭 Aktoren entwickeln', es: '🎭 Construir actores', fr: '🎭 Construire des Actors', ja: '🎭 アクターの構築', ko: '🎭 액터 만들기', 'pt-BR': '🎭 Construir Atores', ru: '🎭 Создание акторов', 'zh-CN': '🎭 构建 Actor' },
          collapsed: true,
          items: [
            {
              label: 'Fundamentals',
              translations: { de: 'Grundlagen', es: 'Fundamentos', fr: 'Fondamentaux', ja: '基礎', ko: '기본 개념', 'pt-BR': 'Fundamentos', ru: 'Основы', 'zh-CN': '基础' },
              collapsed: true,
              items: [
                { label: 'Overview',              slug: 'fundamentals/overview',              translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'Actor',                 slug: 'fundamentals/actor',                 translations: { de: 'Actor', es: 'Actor', fr: 'Actor', ja: 'Actor', ko: 'Actor', 'pt-BR': 'Actor', ru: 'Actor', 'zh-CN': 'Actor' } },
                { label: 'Messages',              slug: 'fundamentals/messages',              translations: { de: 'Nachrichten', es: 'Mensajes', fr: 'Messages', ja: 'メッセージ', ko: '메시지', 'pt-BR': 'Mensagens', ru: 'Сообщения', 'zh-CN': '消息' } },
                { label: 'Ask pattern',           slug: 'fundamentals/ask-pattern',           translations: { de: 'Ask-Pattern', es: 'Patrón Ask', fr: 'Ask pattern', ja: 'Ask パターン', ko: 'Ask 패턴', 'pt-BR': 'Padrão ask', ru: 'Паттерн Ask', 'zh-CN': 'Ask 模式' } },
                { label: 'ActorSystem',           slug: 'fundamentals/actor-system',          translations: { de: 'ActorSystem', es: 'ActorSystem', fr: 'ActorSystem', ja: 'ActorSystem', ko: 'ActorSystem', 'pt-BR': 'ActorSystem', ru: 'ActorSystem', 'zh-CN': 'ActorSystem' } },
                { label: 'Actor paths',           slug: 'fundamentals/actor-paths',           translations: { de: 'Actor-Pfade', es: 'Rutas de Actor', fr: 'Chemins d’Actor', ja: 'アクターパス', ko: '액터 경로', 'pt-BR': 'Caminhos de atores', ru: 'Пути акторов', 'zh-CN': 'Actor 路径' } },
                { label: 'Props',                 slug: 'fundamentals/props',                 translations: { de: 'Props', es: 'Props', fr: 'Props', ja: 'Props', ko: 'Props', 'pt-BR': 'Props', ru: 'Props', 'zh-CN': 'Props' } },
                { label: 'Become and stash',     slug: 'fundamentals/become-and-stash',      translations: { de: 'Become und Stash', es: 'Become y Stash', fr: 'Become et Stash', ja: 'Become と Stash', ko: 'Become과 Stash', 'pt-BR': 'Become e Stash', ru: 'Become и Stash', 'zh-CN': 'Become 与 Stash' } },
                { label: 'Death watch',           slug: 'fundamentals/death-watch',           translations: { de: 'Death Watch', es: 'Death watch', fr: 'Death watch', ja: 'Death watch', ko: 'Death watch', 'pt-BR': 'Death watch', ru: 'Death watch', 'zh-CN': 'Death watch' } },
                { label: 'Supervision',           slug: 'fundamentals/supervision',           translations: { de: 'Supervision', es: 'Supervisión', fr: 'Supervision', ja: 'スーパービジョン', ko: '슈퍼비전', 'pt-BR': 'Supervisão', ru: 'Супервизия', 'zh-CN': '监督' } },
                { label: 'Dispatchers',           slug: 'fundamentals/dispatchers',           translations: { de: 'Dispatcher', es: 'Dispatchers', fr: 'Dispatchers', ja: 'Dispatchers', ko: 'Dispatchers', 'pt-BR': 'Dispatchers', ru: 'Dispatchers', 'zh-CN': 'Dispatchers' } },
                { label: 'Mailboxes',             slug: 'fundamentals/mailboxes',             translations: { de: 'Mailboxes', es: 'Mailboxes', fr: 'Mailboxes', ja: 'Mailboxes', ko: 'Mailboxes', 'pt-BR': 'Mailboxes', ru: 'Mailboxes', 'zh-CN': 'Mailboxes' } },
                { label: 'Timers and scheduling', slug: 'fundamentals/timers-and-scheduling', translations: { de: 'Timer und Scheduling', es: 'Timers y planificación', fr: 'Timers et planification', ja: 'タイマーとスケジューリング', ko: '타이머와 스케줄링', 'pt-BR': 'Timers e agendamento', ru: 'Таймеры и планирование', 'zh-CN': '定时器与调度' } },
                { label: 'Receive timeout',       slug: 'fundamentals/receive-timeout',       translations: { de: 'Receive-Timeout', es: 'Receive timeout', fr: 'Receive timeout', ja: 'Receive timeout', ko: 'Receive timeout', 'pt-BR': 'Receive timeout', ru: 'Receive timeout', 'zh-CN': 'Receive timeout' } },
                { label: 'Coordinated shutdown',  slug: 'fundamentals/coordinated-shutdown',  translations: { de: 'Koordinierter Shutdown', es: 'Apagado coordinado', fr: 'Arrêt coordonné', ja: '協調シャットダウン', ko: '코디네이트 셧다운', 'pt-BR': 'Desligamento coordenado', ru: 'Координированное завершение', 'zh-CN': '协调关闭' } },
                { label: 'Event stream',          slug: 'fundamentals/event-stream',          translations: { de: 'Event-Stream', es: 'Event stream', fr: 'Flux d’événements', ja: 'イベントストリーム', ko: '이벤트 스트림', 'pt-BR': 'Stream de eventos', ru: 'Поток событий', 'zh-CN': '事件流' } },
                { label: 'Logging',               slug: 'fundamentals/logging',               translations: { de: 'Logging', es: 'Logging', fr: 'Journalisation', ja: 'ロギング', ko: '로깅', 'pt-BR': 'Logging', ru: 'Логирование', 'zh-CN': '日志' } },
                { label: 'PoisonPill and Kill',   slug: 'fundamentals/poison-pill-and-kill',  translations: { de: 'PoisonPill und Kill', es: 'PoisonPill y Kill', fr: 'PoisonPill et Kill', ja: 'PoisonPill と Kill', ko: 'PoisonPill과 Kill', 'pt-BR': 'PoisonPill e Kill', ru: 'PoisonPill и Kill', 'zh-CN': 'PoisonPill 与 Kill' } },
                { label: 'Pattern matching',      slug: 'fundamentals/pattern-matching',      translations: { de: 'Pattern Matching', es: 'Pattern matching', fr: 'Pattern matching', ja: 'パターンマッチング', ko: '패턴 매칭', 'pt-BR': 'Casamento de padrões', ru: 'Сопоставление с образцом', 'zh-CN': '模式匹配' } },
              ],
            },
            {
              label: 'Typed actors',
              translations: { de: 'Typisierte Actors', es: 'Actores tipados', fr: 'Actors typés', ja: '型付きアクター', ko: '타입 액터', 'pt-BR': 'Atores tipados', ru: 'Типизированные акторы', 'zh-CN': '类型化 Actor' },
              collapsed: true,
              items: [
                { label: 'Overview',       slug: 'typed/overview',     translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'TypedActor',     slug: 'typed/typed-actor',  translations: { de: 'TypedActor', es: 'TypedActor', fr: 'TypedActor', ja: 'TypedActor', ko: 'TypedActor', 'pt-BR': 'TypedActor', ru: 'TypedActor', 'zh-CN': 'TypedActor' } },
                { label: 'Behaviors',      slug: 'typed/behaviors',    translations: { de: 'Behaviors', es: 'Behaviors', fr: 'Behaviors', ja: 'Behaviors', ko: 'Behaviors', 'pt-BR': 'Behaviors', ru: 'Behaviors', 'zh-CN': 'Behaviors' } },
                { label: 'Spawning typed', slug: 'typed/spawn-typed',  translations: { de: 'Typisierte erstellen', es: 'Spawning tipado', fr: 'Spawn typé', ja: '型付きアクターの生成', ko: '타입 액터 스폰', 'pt-BR': 'Spawning tipado', ru: 'Создание типизированных', 'zh-CN': '创建类型化 Actor' } },
              ],
            },
            {
              label: 'Routing',
              translations: { de: 'Routing', es: 'Enrutamiento', fr: 'Routage', ja: 'ルーティング', ko: '라우팅', 'pt-BR': 'Roteamento', ru: 'Маршрутизация', 'zh-CN': '路由' },
              collapsed: true,
              items: [
                { label: 'Overview',      slug: 'routing/overview',      translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'Router',        slug: 'routing/router',        translations: { de: 'Router', es: 'Router', fr: 'Router', ja: 'Router', ko: 'Router', 'pt-BR': 'Router', ru: 'Router', 'zh-CN': 'Router' } },
                { label: 'Strategies',    slug: 'routing/strategies',    translations: { de: 'Strategien', es: 'Estrategias', fr: 'Stratégies', ja: '戦略', ko: '전략', 'pt-BR': 'Estratégias', ru: 'Стратегии', 'zh-CN': '策略' } },
                { label: 'Pool vs group', slug: 'routing/pool-vs-group', translations: { de: 'Pool vs. Group', es: 'Pool vs group', fr: 'Pool vs groupe', ja: 'プール vs グループ', ko: '풀 vs 그룹', 'pt-BR': 'Pool vs grupo', ru: 'Pool против group', 'zh-CN': 'Pool 与 Group' } },
              ],
            },
            {
              label: 'Patterns',
              translations: { de: 'Patterns', es: 'Patrones', fr: 'Patterns', ja: 'パターン', ko: '패턴', 'pt-BR': 'Padrões', ru: 'Паттерны', 'zh-CN': '模式' },
              collapsed: true,
              items: [
                { label: 'Circuit breaker',    slug: 'patterns/circuit-breaker',    translations: { de: 'Circuit Breaker', es: 'Circuit Breaker', fr: 'Circuit Breaker', ja: 'Circuit Breaker', ko: 'Circuit Breaker', 'pt-BR': 'Circuit Breaker', ru: 'Circuit Breaker', 'zh-CN': 'Circuit Breaker' } },
                { label: 'Backoff supervisor', slug: 'patterns/backoff-supervisor', translations: { de: 'Backoff Supervisor', es: 'Supervisor Backoff', fr: 'Superviseur Backoff', ja: 'Backoff スーパーバイザ', ko: 'Backoff 슈퍼바이저', 'pt-BR': 'Supervisor com Backoff', ru: 'Backoff-супервизор', 'zh-CN': 'Backoff 监督者' } },
                { label: 'Backoff policy',     slug: 'patterns/backoff-policy',     translations: { de: 'Backoff-Policy', es: 'Política Backoff', fr: 'Politique de Backoff', ja: 'Backoff ポリシー', ko: 'Backoff 정책', 'pt-BR': 'Política de Backoff', ru: 'Политика Backoff', 'zh-CN': 'Backoff 策略' } },
                { label: 'Retry',              slug: 'patterns/retry',              translations: { de: 'Retry', es: 'Retry', fr: 'Retry', ja: 'Retry', ko: 'Retry', 'pt-BR': 'Retry', ru: 'Retry', 'zh-CN': 'Retry' } },
                { label: 'Future patterns',    slug: 'patterns/futures-patterns',   translations: { de: 'Future-Patterns', es: 'Patrones Future', fr: 'Patterns Future', ja: 'Future パターン', ko: 'Future 패턴', 'pt-BR': 'Padrões com Future', ru: 'Паттерны Future', 'zh-CN': 'Future 模式' } },
              ],
            },
          ],
        },
        {
          label: '🌐 Distribute',
          translations: { de: '🌐 Verteilen', es: '🌐 Distribuir', fr: '🌐 Distribuer', ja: '🌐 分散', ko: '🌐 분산 처리', 'pt-BR': '🌐 Distribuir', ru: '🌐 Распределение', 'zh-CN': '🌐 分布式' },
          collapsed: true,
          items: [
            {
              label: 'Cluster',
              translations: { de: 'Cluster', es: 'Cluster', fr: 'Cluster', ja: 'Cluster', ko: 'Cluster', 'pt-BR': 'Cluster', ru: 'Cluster', 'zh-CN': 'Cluster' },
              collapsed: true,
              items: [
                { label: 'Overview',           slug: 'cluster/overview',           translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'Joining and seeds',  slug: 'cluster/joining-and-seeds',  translations: { de: 'Beitritt und Seeds', es: 'Joining y seeds', fr: 'Adhésion et seeds', ja: '参加とシード', ko: '조인과 시드', 'pt-BR': 'Joining e seeds', ru: 'Присоединение и seeds', 'zh-CN': '加入集群与种子节点' } },
                { label: 'Failure detector',   slug: 'cluster/failure-detector',   translations: { de: 'Failure Detector', es: 'Failure detector', fr: 'Failure detector', ja: 'Failure detector', ko: 'Failure detector', 'pt-BR': 'Failure detector', ru: 'Failure detector', 'zh-CN': 'Failure detector' } },
                { label: 'Downing strategies', slug: 'cluster/downing-strategies', translations: { de: 'Downing-Strategien', es: 'Estrategias de downing', fr: 'Stratégies de downing', ja: 'ダウン戦略', ko: '다운 전략', 'pt-BR': 'Estratégias de downing', ru: 'Стратегии downing', 'zh-CN': '下线策略' } },
                { label: 'Transports',         slug: 'cluster/transports',         translations: { de: 'Transporte', es: 'Transportes', fr: 'Transports', ja: 'トランスポート', ko: '트랜스포트', 'pt-BR': 'Transportes', ru: 'Транспорты', 'zh-CN': '传输层' } },
                { label: 'Weakly-up',          slug: 'cluster/weakly-up',          translations: { de: 'Weakly-Up', es: 'Weakly-up', fr: 'Weakly-up', ja: 'Weakly-up', ko: 'Weakly-up', 'pt-BR': 'Weakly-up', ru: 'Weakly-up', 'zh-CN': 'Weakly-up' } },
                { label: 'Refs across nodes',  slug: 'cluster/refs-across-nodes',  translations: { de: 'Refs über Nodes hinweg', es: 'Refs entre nodos', fr: 'Refs entre nœuds', ja: 'ノード間の参照', ko: '노드 간 ActorRef', 'pt-BR': 'Refs entre nós', ru: 'Ссылки между узлами', 'zh-CN': '跨节点引用' } },
                { label: 'Distributed PubSub', slug: 'cluster/pubsub',             translations: { de: 'Distributed PubSub', es: 'Distributed PubSub', fr: 'Distributed PubSub', ja: 'Distributed PubSub', ko: 'Distributed PubSub', 'pt-BR': 'Distributed PubSub', ru: 'Distributed PubSub', 'zh-CN': 'Distributed PubSub' } },
                {
                  label: 'Singleton',
                  translations: { de: 'Singleton', es: 'Singleton', fr: 'Singleton', ja: 'Singleton', ko: 'Singleton', 'pt-BR': 'Singleton', ru: 'Singleton', 'zh-CN': 'Singleton' },
                  collapsed: true,
                  items: [
                    { label: 'Overview',   slug: 'cluster/singleton/overview',   translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                    { label: 'Manager',    slug: 'cluster/singleton/manager',    translations: { de: 'Manager', es: 'Manager', fr: 'Gestionnaire', ja: 'マネージャ', ko: '매니저', 'pt-BR': 'Gerenciador', ru: 'Менеджер', 'zh-CN': '管理器' } },
                    { label: 'With lease', slug: 'cluster/singleton/with-lease', translations: { de: 'Mit Lease', es: 'Con Lease', fr: 'Avec Lease', ja: 'Lease 付き', ko: 'Lease 사용', 'pt-BR': 'Com Lease', ru: 'С Lease', 'zh-CN': '基于 Lease' } },
                  ],
                },
                {
                  label: 'Sharding',
                  translations: { de: 'Sharding', es: 'Sharding', fr: 'Sharding', ja: 'Sharding', ko: 'Sharding', 'pt-BR': 'Sharding', ru: 'Sharding', 'zh-CN': 'Sharding' },
                  collapsed: true,
                  items: [
                    { label: 'Overview',            slug: 'cluster/sharding/overview',                translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                    { label: 'Allocation strategy', slug: 'cluster/sharding/allocation-strategy',     translations: { de: 'Allocation-Strategie', es: 'Estrategia de asignación', fr: 'Stratégie d’allocation', ja: '配置戦略', ko: '할당 전략', 'pt-BR': 'Estratégia de alocação', ru: 'Стратегия размещения', 'zh-CN': '分配策略' } },
                    { label: 'Rebalance',           slug: 'cluster/sharding/rebalance',               translations: { de: 'Rebalance', es: 'Rebalance', fr: 'Rééquilibrage', ja: 'リバランス', ko: '리밸런스', 'pt-BR': 'Rebalanceamento', ru: 'Ребалансировка', 'zh-CN': '再平衡' } },
                    { label: 'Remember entities',   slug: 'cluster/sharding/remember-entities',       translations: { de: 'Entities merken', es: 'Remember entities', fr: 'Mémorisation des entités', ja: 'エンティティ記憶', ko: '엔티티 기억', 'pt-BR': 'Remember entities', ru: 'Запоминание сущностей', 'zh-CN': '记住实体' } },
                    { label: 'With lease',          slug: 'cluster/sharding/with-lease',              translations: { de: 'Mit Lease', es: 'Con Lease', fr: 'Avec Lease', ja: 'Lease 付き', ko: 'Lease 사용', 'pt-BR': 'Com Lease', ru: 'С Lease', 'zh-CN': '基于 Lease' } },
                    { label: 'Sharded daemon',      slug: 'cluster/sharding/sharded-daemon-process',  translations: { de: 'Sharded Daemon', es: 'Sharded daemon', fr: 'Daemon shardé', ja: 'シャードデーモン', ko: '샤딩 데몬', 'pt-BR': 'Sharded daemon', ru: 'Шардированный демон', 'zh-CN': '分片守护进程' } },
                  ],
                },
                { label: 'Cluster router',   slug: 'cluster/cluster-router',   translations: { de: 'Cluster-Router', es: 'Cluster router', fr: 'Cluster router', ja: 'Cluster router', ko: 'Cluster router', 'pt-BR': 'Cluster router', ru: 'Cluster router', 'zh-CN': 'Cluster router' } },
                { label: 'Cluster client',   slug: 'cluster/cluster-client',   translations: { de: 'Cluster-Client', es: 'Cluster client', fr: 'Cluster client', ja: 'Cluster client', ko: 'Cluster client', 'pt-BR': 'Cluster client', ru: 'Cluster client', 'zh-CN': 'Cluster client' } },
                { label: 'Cluster security', slug: 'cluster/cluster-security', translations: { de: 'Cluster-Sicherheit', es: 'Seguridad del Cluster', fr: 'Sécurité du Cluster', ja: 'クラスタセキュリティ', ko: '클러스터 보안', 'pt-BR': 'Segurança do Cluster', ru: 'Безопасность кластера', 'zh-CN': '集群安全' } },
                { label: 'Worker mesh',      slug: 'cluster/worker-mesh',      translations: { de: 'Worker-Mesh', es: 'Worker mesh', fr: 'Maillage de workers', ja: 'ワーカーメッシュ', ko: '워커 메시', 'pt-BR': 'Malha de workers', ru: 'Worker mesh', 'zh-CN': '工作节点网格' } },
              ],
            },
            {
              label: 'Distributed Data',
              translations: { de: 'Distributed Data', es: 'Distributed Data', fr: 'Distributed Data', ja: 'Distributed Data', ko: 'Distributed Data', 'pt-BR': 'Distributed Data', ru: 'Distributed Data', 'zh-CN': 'Distributed Data' },
              collapsed: true,
              items: [
                { label: 'Overview', slug: 'distributed-data/overview', translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                {
                  label: 'CRDT types',
                  translations: { de: 'CRDT-Typen', es: 'Tipos CRDT', fr: 'Types CRDT', ja: 'CRDT 型', ko: 'CRDT 타입', 'pt-BR': 'Tipos de CRDT', ru: 'Типы CRDT', 'zh-CN': 'CRDT 类型' },
                  collapsed: true,
                  items: [
                    { label: 'Counters',       slug: 'distributed-data/crdt-types/counters',       translations: { de: 'Counter', es: 'Counters', fr: 'Counters', ja: 'Counters', ko: 'Counters', 'pt-BR': 'Counters', ru: 'Counters', 'zh-CN': 'Counters' } },
                    { label: 'Registers',      slug: 'distributed-data/crdt-types/registers',      translations: { de: 'Register', es: 'Registers', fr: 'Registers', ja: 'Registers', ko: 'Registers', 'pt-BR': 'Registers', ru: 'Registers', 'zh-CN': 'Registers' } },
                    { label: 'Sets',           slug: 'distributed-data/crdt-types/sets',           translations: { de: 'Sets', es: 'Sets', fr: 'Sets', ja: 'Sets', ko: 'Sets', 'pt-BR': 'Sets', ru: 'Sets', 'zh-CN': 'Sets' } },
                    { label: 'Maps',           slug: 'distributed-data/crdt-types/maps',           translations: { de: 'Maps', es: 'Maps', fr: 'Maps', ja: 'Maps', ko: 'Maps', 'pt-BR': 'Maps', ru: 'Maps', 'zh-CN': 'Maps' } },
                    { label: 'Designing data', slug: 'distributed-data/crdt-types/designing-data', translations: { de: 'Datenmodellierung', es: 'Diseño de datos', fr: 'Conception des données', ja: 'データ設計', ko: '데이터 설계', 'pt-BR': 'Modelagem de dados', ru: 'Проектирование данных', 'zh-CN': '数据设计' } },
                  ],
                },
                { label: 'Replication',         slug: 'distributed-data/replication',         translations: { de: 'Replikation', es: 'Replicación', fr: 'Réplication', ja: 'レプリケーション', ko: '복제', 'pt-BR': 'Replicação', ru: 'Репликация', 'zh-CN': '复制' } },
                { label: 'Quorum reads/writes', slug: 'distributed-data/quorum-reads-writes', translations: { de: 'Quorum-Reads/Writes', es: 'Lecturas/escrituras de quórum', fr: 'Lectures/écritures quorum', ja: 'クォーラム読み書き', ko: '쿼럼 읽기/쓰기', 'pt-BR': 'Leituras/escritas com quórum', ru: 'Кворумные чтения/записи', 'zh-CN': 'Quorum 读写' } },
                { label: 'Durable storage',     slug: 'distributed-data/durable-storage',     translations: { de: 'Durable Storage', es: 'Almacenamiento duradero', fr: 'Stockage durable', ja: '永続ストレージ', ko: '영속 스토리지', 'pt-BR': 'Armazenamento durável', ru: 'Долговременное хранилище', 'zh-CN': '持久化存储' } },
              ],
            },
            {
              label: 'Coordination',
              translations: { de: 'Koordination', es: 'Coordinación', fr: 'Coordination', ja: '協調', ko: '코디네이션', 'pt-BR': 'Coordenação', ru: 'Координация', 'zh-CN': '协调' },
              collapsed: true,
              items: [
                { label: 'Overview',         slug: 'coordination/overview',         translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'Lease API',        slug: 'coordination/lease-api',        translations: { de: 'Lease-API', es: 'Lease API', fr: 'API Lease', ja: 'Lease API', ko: 'Lease API', 'pt-BR': 'API de Lease', ru: 'Lease API', 'zh-CN': 'Lease API' } },
                { label: 'In-memory lease',  slug: 'coordination/in-memory-lease',  translations: { de: 'In-Memory-Lease', es: 'Lease en memoria', fr: 'Lease en mémoire', ja: 'インメモリ Lease', ko: '인메모리 Lease', 'pt-BR': 'Lease em memória', ru: 'In-memory Lease', 'zh-CN': '内存 Lease' } },
                { label: 'Kubernetes lease', slug: 'coordination/kubernetes-lease', translations: { de: 'Kubernetes-Lease', es: 'Lease de Kubernetes', fr: 'Lease Kubernetes', ja: 'Kubernetes Lease', ko: 'Kubernetes Lease', 'pt-BR': 'Lease no Kubernetes', ru: 'Kubernetes Lease', 'zh-CN': 'Kubernetes Lease' } },
              ],
            },
            {
              label: 'Discovery',
              translations: { de: 'Discovery', es: 'Descubrimiento', fr: 'Découverte', ja: 'ディスカバリ', ko: '디스커버리', 'pt-BR': 'Descoberta', ru: 'Обнаружение', 'zh-CN': '服务发现' },
              collapsed: true,
              items: [
                { label: 'Overview', slug: 'discovery/overview', translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                {
                  label: 'Seed providers',
                  translations: { de: 'Seed-Provider', es: 'Proveedores de seeds', fr: 'Fournisseurs de seeds', ja: 'シードプロバイダ', ko: '시드 프로바이더', 'pt-BR': 'Provedores de seed', ru: 'Seed-провайдеры', 'zh-CN': '种子节点提供者' },
                  collapsed: true,
                  items: [
                    { label: 'Config',         slug: 'discovery/seed-providers/config',         translations: { de: 'Config', es: 'Configuración', fr: 'Configuration', ja: '設定', ko: '설정', 'pt-BR': 'Configuração', ru: 'Конфигурация', 'zh-CN': '配置' } },
                    { label: 'DNS',            slug: 'discovery/seed-providers/dns',            translations: { de: 'DNS', es: 'DNS', fr: 'DNS', ja: 'DNS', ko: 'DNS', 'pt-BR': 'DNS', ru: 'DNS', 'zh-CN': 'DNS' } },
                    { label: 'Kubernetes API', slug: 'discovery/seed-providers/kubernetes-api', translations: { de: 'Kubernetes-API', es: 'Kubernetes API', fr: 'Kubernetes API', ja: 'Kubernetes API', ko: 'Kubernetes API', 'pt-BR': 'Kubernetes API', ru: 'Kubernetes API', 'zh-CN': 'Kubernetes API' } },
                    { label: 'Aggregate',      slug: 'discovery/seed-providers/aggregate',      translations: { de: 'Aggregate', es: 'Agregado', fr: 'Agrégat', ja: '集約', ko: '애그리거트', 'pt-BR': 'Agregado', ru: 'Агрегация', 'zh-CN': '聚合' } },
                  ],
                },
                { label: 'Receptionist', slug: 'discovery/receptionist', translations: { de: 'Receptionist', es: 'Receptionist', fr: 'Receptionist', ja: 'Receptionist', ko: 'Receptionist', 'pt-BR': 'Receptionist', ru: 'Receptionist', 'zh-CN': 'Receptionist' } },
              ],
            },
          ],
        },
        {
          label: '💾 Persist',
          translations: { de: '💾 Persistieren', es: '💾 Persistir', fr: '💾 Persister', ja: '💾 永続化', ko: '💾 영속화', 'pt-BR': '💾 Persistir', ru: '💾 Персистентность', 'zh-CN': '💾 持久化' },
          collapsed: true,
          items: [
            {
              label: 'Event sourcing',
              translations: { de: 'Event Sourcing', es: 'Event sourcing', fr: 'Event sourcing', ja: 'イベントソーシング', ko: '이벤트 소싱', 'pt-BR': 'Event sourcing', ru: 'Event sourcing', 'zh-CN': '事件溯源' },
              collapsed: true,
              items: [
                { label: 'Overview',          slug: 'persistence/overview',          translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'PersistentActor',   slug: 'persistence/persistent-actor',  translations: { de: 'PersistentActor', es: 'PersistentActor', fr: 'PersistentActor', ja: 'PersistentActor', ko: 'PersistentActor', 'pt-BR': 'PersistentActor', ru: 'PersistentActor', 'zh-CN': 'PersistentActor' } },
                { label: 'Event dispatcher',  slug: 'persistence/event-dispatcher',  translations: { de: 'Event-Dispatcher', es: 'Dispatcher de eventos', fr: 'Dispatcher d’événements', ja: 'イベントディスパッチャ', ko: '이벤트 디스패처', 'pt-BR': 'Dispatcher de eventos', ru: 'Диспетчер событий', 'zh-CN': '事件分发器' } },
                { label: 'Snapshots',         slug: 'persistence/snapshots',         translations: { de: 'Snapshots', es: 'Snapshots', fr: 'Snapshots', ja: 'Snapshots', ko: 'Snapshots', 'pt-BR': 'Snapshots', ru: 'Snapshots', 'zh-CN': 'Snapshots' } },
                { label: 'Durable state',     slug: 'persistence/durable-state',     translations: { de: 'Durable State', es: 'Estado duradero', fr: 'État durable', ja: '永続状態', ko: '영속 상태', 'pt-BR': 'Estado durável', ru: 'Долговременное состояние', 'zh-CN': '持久化状态' } },
                { label: 'Projections',       slug: 'persistence/projections',       translations: { de: 'Projektionen', es: 'Proyecciones', fr: 'Projections', ja: 'プロジェクション', ko: '프로젝션', 'pt-BR': 'Projeções', ru: 'Проекции', 'zh-CN': '投影' } },
                { label: 'Persistence query', slug: 'persistence/persistence-query', translations: { de: 'Persistence-Query', es: 'Persistence query', fr: 'Requête de persistance', ja: '永続化クエリ', ko: '퍼시스턴스 쿼리', 'pt-BR': 'Consulta de persistência', ru: 'Persistence query', 'zh-CN': '持久化查询' } },
                { label: 'Push-based query',  slug: 'persistence/push-based-query',  translations: { de: 'Push-basierte Query', es: 'Query basada en push', fr: 'Requête push', ja: 'プッシュ型クエリ', ko: '푸시 기반 쿼리', 'pt-BR': 'Consulta baseada em push', ru: 'Push-запросы', 'zh-CN': '基于推送的查询' } },
              ],
            },
            {
              label: 'Journals',
              translations: { de: 'Journals', es: 'Journals', fr: 'Journaux', ja: 'ジャーナル', ko: '저널', 'pt-BR': 'Journals', ru: 'Журналы', 'zh-CN': '事件日志' },
              collapsed: true,
              items: [
                { label: 'In-memory', slug: 'persistence/journals/in-memory', translations: { de: 'In-Memory', es: 'En memoria', fr: 'En mémoire', ja: 'インメモリ', ko: '인메모리', 'pt-BR': 'Em memória', ru: 'In-memory', 'zh-CN': '内存' } },
                { label: 'SQLite',    slug: 'persistence/journals/sqlite',    translations: { de: 'SQLite', es: 'SQLite', fr: 'SQLite', ja: 'SQLite', ko: 'SQLite', 'pt-BR': 'SQLite', ru: 'SQLite', 'zh-CN': 'SQLite' } },
                { label: 'Cassandra', slug: 'persistence/journals/cassandra', translations: { de: 'Cassandra', es: 'Cassandra', fr: 'Cassandra', ja: 'Cassandra', ko: 'Cassandra', 'pt-BR': 'Cassandra', ru: 'Cassandra', 'zh-CN': 'Cassandra' } },
                { label: 'PostgreSQL', slug: 'persistence/journals/postgres', translations: { de: 'PostgreSQL', es: 'PostgreSQL', fr: 'PostgreSQL', ja: 'PostgreSQL', ko: 'PostgreSQL', 'pt-BR': 'PostgreSQL', ru: 'PostgreSQL', 'zh-CN': 'PostgreSQL' } },
                { label: 'MariaDB',    slug: 'persistence/journals/mariadb',   translations: { de: 'MariaDB', es: 'MariaDB', fr: 'MariaDB', ja: 'MariaDB', ko: 'MariaDB', 'pt-BR': 'MariaDB', ru: 'MariaDB', 'zh-CN': 'MariaDB' } },
              ],
            },
            {
              label: 'Snapshot stores',
              translations: { de: 'Snapshot Stores', es: 'Snapshot stores', fr: 'Magasins de Snapshots', ja: 'スナップショットストア', ko: '스냅샷 스토어', 'pt-BR': 'Snapshot stores', ru: 'Хранилища Snapshots', 'zh-CN': '快照存储' },
              collapsed: true,
              items: [
                { label: 'In-memory',             slug: 'persistence/snapshot-stores/in-memory',             translations: { de: 'In-Memory', es: 'En memoria', fr: 'En mémoire', ja: 'インメモリ', ko: '인메모리', 'pt-BR': 'Em memória', ru: 'In-memory', 'zh-CN': '内存' } },
                { label: 'SQLite',                slug: 'persistence/snapshot-stores/sqlite',                translations: { de: 'SQLite', es: 'SQLite', fr: 'SQLite', ja: 'SQLite', ko: 'SQLite', 'pt-BR': 'SQLite', ru: 'SQLite', 'zh-CN': 'SQLite' } },
                { label: 'Cached snapshot store', slug: 'persistence/snapshot-stores/cached-snapshot-store', translations: { de: 'Cached Snapshot Store', es: 'Snapshot store con caché', fr: 'Magasin de Snapshots avec cache', ja: 'キャッシュ付きスナップショットストア', ko: '캐시드 스냅샷 스토어', 'pt-BR': 'Snapshot store com cache', ru: 'Кэшированное хранилище Snapshots', 'zh-CN': '带缓存的快照存储' } },
              ],
            },
            {
              label: 'Replicated event sourcing',
              translations: { de: 'Replicated Event Sourcing', es: 'Event sourcing replicado', fr: 'Event sourcing répliqué', ja: 'レプリケーションイベントソーシング', ko: '복제 이벤트 소싱', 'pt-BR': 'Event sourcing replicado', ru: 'Реплицированный event sourcing', 'zh-CN': '复制式事件溯源' },
              collapsed: true,
              items: [
                { label: 'Overview',            slug: 'persistence/replicated-event-sourcing/overview',            translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'Single-writer lease', slug: 'persistence/replicated-event-sourcing/single-writer-lease', translations: { de: 'Single-Writer-Lease', es: 'Lease de escritor único', fr: 'Lease single-writer', ja: 'シングルライター Lease', ko: '단일 라이터 Lease', 'pt-BR': 'Lease de escritor único', ru: 'Lease единственного писателя', 'zh-CN': '单写者 Lease' } },
                { label: 'Vector clocks',       slug: 'persistence/replicated-event-sourcing/vector-clocks',       translations: { de: 'Vector Clocks', es: 'Vector clocks', fr: 'Vector clocks', ja: 'Vector clocks', ko: 'Vector clocks', 'pt-BR': 'Vector clocks', ru: 'Vector clocks', 'zh-CN': 'Vector clocks' } },
                { label: 'Conflict resolver',   slug: 'persistence/replicated-event-sourcing/conflict-resolver',   translations: { de: 'Conflict Resolver', es: 'Resolutor de conflictos', fr: 'Résolveur de conflits', ja: '競合リゾルバ', ko: '충돌 해결자', 'pt-BR': 'Resolvedor de conflitos', ru: 'Разрешение конфликтов', 'zh-CN': '冲突解决器' } },
                { label: 'Snapshotting',        slug: 'persistence/replicated-event-sourcing/snapshotting',        translations: { de: 'Snapshotting', es: 'Snapshotting', fr: 'Snapshotting', ja: 'Snapshotting', ko: 'Snapshotting', 'pt-BR': 'Snapshotting', ru: 'Snapshotting', 'zh-CN': '快照机制' } },
              ],
            },
            {
              label: 'Object storage',
              translations: { de: 'Object Storage', es: 'Almacenamiento de objetos', fr: 'Stockage objet', ja: 'オブジェクトストレージ', ko: '오브젝트 스토리지', 'pt-BR': 'Armazenamento de objetos', ru: 'Объектное хранилище', 'zh-CN': '对象存储' },
              collapsed: true,
              items: [
                { label: 'Overview',               slug: 'persistence/object-storage/overview',               translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'Compression',            slug: 'persistence/object-storage/compression',            translations: { de: 'Kompression', es: 'Compresión', fr: 'Compression', ja: '圧縮', ko: '압축', 'pt-BR': 'Compressão', ru: 'Сжатие', 'zh-CN': '压缩' } },
                { label: 'Encryption',             slug: 'persistence/object-storage/encryption',             translations: { de: 'Verschlüsselung', es: 'Cifrado', fr: 'Chiffrement', ja: '暗号化', ko: '암호화', 'pt-BR': 'Criptografia', ru: 'Шифрование', 'zh-CN': '加密' } },
                { label: 'Key rotation',           slug: 'persistence/object-storage/key-rotation',           translations: { de: 'Key-Rotation', es: 'Rotación de claves', fr: 'Rotation des clés', ja: '鍵ローテーション', ko: '키 로테이션', 'pt-BR': 'Rotação de chaves', ru: 'Ротация ключей', 'zh-CN': '密钥轮换' } },
                { label: 'Per-actor policies',     slug: 'persistence/object-storage/per-actor-policies',     translations: { de: 'Per-Actor-Policies', es: 'Políticas por actor', fr: 'Politiques par Actor', ja: 'アクターごとのポリシー', ko: '액터별 정책', 'pt-BR': 'Políticas por ator', ru: 'Политики по акторам', 'zh-CN': '按 Actor 策略' } },
                { label: 'Snapshot store backend', slug: 'persistence/object-storage/snapshot-store-backend', translations: { de: 'Snapshot-Store-Backend', es: 'Backend del Snapshot store', fr: 'Backend du magasin de Snapshots', ja: 'スナップショットストアバックエンド', ko: '스냅샷 스토어 백엔드', 'pt-BR': 'Backend de snapshot store', ru: 'Бэкенд хранилища Snapshots', 'zh-CN': '快照存储后端' } },
              ],
            },
            {
              label: 'Migration',
              translations: { de: 'Migration', es: 'Migración', fr: 'Migration', ja: '移行', ko: '마이그레이션', 'pt-BR': 'Migração', ru: 'Миграция', 'zh-CN': '迁移' },
              collapsed: true,
              items: [
                { label: 'Overview',          slug: 'persistence/migration/overview',          translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'Recipes',           slug: 'persistence/migration/recipes',           translations: { de: 'Rezepte', es: 'Recetas', fr: 'Recettes', ja: 'レシピ', ko: '레시피', 'pt-BR': 'Receitas', ru: 'Рецепты', 'zh-CN': '实用方案' } },
                { label: 'Schema registry',   slug: 'persistence/migration/schema-registry',   translations: { de: 'Schema-Registry', es: 'Registro de esquemas', fr: 'Registre de schémas', ja: 'スキーマレジストリ', ko: '스키마 레지스트리', 'pt-BR': 'Registro de schemas', ru: 'Реестр схем', 'zh-CN': 'Schema 注册中心' } },
                { label: 'Envelope format',   slug: 'persistence/migration/envelope-format',   translations: { de: 'Envelope-Format', es: 'Formato de envelope', fr: 'Format d’enveloppe', ja: 'エンベロープ形式', ko: '엔벨로프 포맷', 'pt-BR': 'Formato de envelope', ru: 'Формат конверта', 'zh-CN': '信封格式' } },
                { label: 'Defaults adapter',  slug: 'persistence/migration/default-adapter',   translations: { de: 'Default-Adapter', es: 'Adaptador por defecto', fr: 'Adaptateur par défaut', ja: 'デフォルトアダプタ', ko: '기본 어댑터', 'pt-BR': 'Adaptador padrão', ru: 'Адаптер значений по умолчанию', 'zh-CN': '默认适配器' } },
                { label: 'Migrating adapter', slug: 'persistence/migration/migrating-adapter', translations: { de: 'Migrating-Adapter', es: 'Adaptador de migración', fr: 'Adaptateur de migration', ja: 'マイグレーションアダプタ', ko: '마이그레이션 어댑터', 'pt-BR': 'Adaptador de migração', ru: 'Адаптер миграции', 'zh-CN': '迁移适配器' } },
                { label: 'Wrap legacy',       slug: 'persistence/migration/wrap-legacy',       translations: { de: 'Legacy wrappen', es: 'Envolver legacy', fr: 'Encapsuler le legacy', ja: 'レガシーのラップ', ko: '레거시 래핑', 'pt-BR': 'Encapsular código legado', ru: 'Обёртка устаревшего кода', 'zh-CN': '包装遗留代码' } },
              ],
            },
            {
              label: 'FSM',
              translations: { de: 'FSM', es: 'FSM', fr: 'FSM', ja: 'FSM', ko: 'FSM', 'pt-BR': 'FSM', ru: 'FSM', 'zh-CN': 'FSM' },
              collapsed: true,
              items: [
                { label: 'Overview',       slug: 'persistence/fsm/overview',       translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'In-memory FSM',  slug: 'persistence/fsm/fsm',            translations: { de: 'In-Memory-FSM', es: 'FSM en memoria', fr: 'FSM en mémoire', ja: 'インメモリ FSM', ko: '인메모리 FSM', 'pt-BR': 'FSM em memória', ru: 'In-memory FSM', 'zh-CN': '内存 FSM' } },
                { label: 'Persistent FSM', slug: 'persistence/fsm/persistent-fsm', translations: { de: 'Persistent FSM', es: 'FSM persistente', fr: 'FSM persistante', ja: '永続 FSM', ko: '영속 FSM', 'pt-BR': 'FSM persistente', ru: 'Persistent FSM', 'zh-CN': '持久化 FSM' } },
              ],
            },
            {
              label: 'Delivery',
              translations: { de: 'Delivery', es: 'Entrega', fr: 'Livraison', ja: '配信', ko: '전달 보장', 'pt-BR': 'Entrega', ru: 'Доставка', 'zh-CN': '投递' },
              collapsed: true,
              items: [
                { label: 'Overview',            slug: 'delivery/overview',            translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'Producer controller', slug: 'delivery/producer-controller', translations: { de: 'Producer Controller', es: 'Controlador productor', fr: 'Contrôleur de producteur', ja: 'プロデューサコントローラ', ko: '프로듀서 컨트롤러', 'pt-BR': 'Controlador de produtor', ru: 'Контроллер продюсера', 'zh-CN': '生产者控制器' } },
                { label: 'Consumer controller', slug: 'delivery/consumer-controller', translations: { de: 'Consumer Controller', es: 'Controlador consumidor', fr: 'Contrôleur de consommateur', ja: 'コンシューマコントローラ', ko: '컨슈머 컨트롤러', 'pt-BR': 'Controlador de consumidor', ru: 'Контроллер консюмера', 'zh-CN': '消费者控制器' } },
                { label: 'Ack semantics',       slug: 'delivery/ack-semantics',       translations: { de: 'Ack-Semantik', es: 'Semántica de ack', fr: 'Sémantique d’Ack', ja: 'Ack セマンティクス', ko: 'Ack 시맨틱', 'pt-BR': 'Semântica de ack', ru: 'Семантика Ack', 'zh-CN': 'Ack 语义' } },
              ],
            },
          ],
        },
        {
          label: '🔌 Integrate',
          translations: { de: '🔌 Integrieren', es: '🔌 Integrar', fr: '🔌 Intégrer', ja: '🔌 統合', ko: '🔌 통합', 'pt-BR': '🔌 Integrar', ru: '🔌 Интеграция', 'zh-CN': '🔌 集成' },
          collapsed: true,
          items: [
            {
              label: 'IO (brokers)',
              translations: { de: 'IO (Broker)', es: 'IO (brokers)', fr: 'IO (brokers)', ja: 'IO (ブローカー)', ko: 'IO (브로커)', 'pt-BR': 'IO (brokers)', ru: 'IO (брокеры)', 'zh-CN': 'IO (消息代理)' },
              collapsed: true,
              items: [
                { label: 'Overview',         slug: 'io/overview',          translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'BrokerActor base', slug: 'io/broker-actor-base', translations: { de: 'BrokerActor-Basis', es: 'BrokerActor base', fr: 'BrokerActor base', ja: 'BrokerActor base', ko: 'BrokerActor base', 'pt-BR': 'BrokerActor base', ru: 'BrokerActor base', 'zh-CN': 'BrokerActor base' } },
                { label: 'Kafka',            slug: 'io/kafka',             translations: { de: 'Kafka', es: 'Kafka', fr: 'Kafka', ja: 'Kafka', ko: 'Kafka', 'pt-BR': 'Kafka', ru: 'Kafka', 'zh-CN': 'Kafka' } },
                { label: 'MQTT',             slug: 'io/mqtt',              translations: { de: 'MQTT', es: 'MQTT', fr: 'MQTT', ja: 'MQTT', ko: 'MQTT', 'pt-BR': 'MQTT', ru: 'MQTT', 'zh-CN': 'MQTT' } },
                { label: 'AMQP',             slug: 'io/amqp',              translations: { de: 'AMQP', es: 'AMQP', fr: 'AMQP', ja: 'AMQP', ko: 'AMQP', 'pt-BR': 'AMQP', ru: 'AMQP', 'zh-CN': 'AMQP' } },
                { label: 'NATS',             slug: 'io/nats',              translations: { de: 'NATS', es: 'NATS', fr: 'NATS', ja: 'NATS', ko: 'NATS', 'pt-BR': 'NATS', ru: 'NATS', 'zh-CN': 'NATS' } },
                { label: 'Redis Streams',    slug: 'io/redis-streams',     translations: { de: 'Redis Streams', es: 'Redis Streams', fr: 'Redis Streams', ja: 'Redis Streams', ko: 'Redis Streams', 'pt-BR': 'Redis Streams', ru: 'Redis Streams', 'zh-CN': 'Redis Streams' } },
                { label: 'gRPC',             slug: 'io/grpc',              translations: { de: 'gRPC', es: 'gRPC', fr: 'gRPC', ja: 'gRPC', ko: 'gRPC', 'pt-BR': 'gRPC', ru: 'gRPC', 'zh-CN': 'gRPC' } },
                { label: 'SSE',              slug: 'io/sse',               translations: { de: 'SSE', es: 'SSE', fr: 'SSE', ja: 'SSE', ko: 'SSE', 'pt-BR': 'SSE', ru: 'SSE', 'zh-CN': 'SSE' } },
                { label: 'WebSocket client', slug: 'io/websocket',         translations: { de: 'WebSocket-Client', es: 'Cliente WebSocket', fr: 'Client WebSocket', ja: 'WebSocket クライアント', ko: 'WebSocket 클라이언트', 'pt-BR': 'Cliente WebSocket', ru: 'WebSocket-клиент', 'zh-CN': 'WebSocket 客户端' } },
                { label: 'WebSocket server', slug: 'io/server-websocket',  translations: { de: 'WebSocket-Server', es: 'Servidor WebSocket', fr: 'Serveur WebSocket', ja: 'WebSocket サーバ', ko: 'WebSocket 서버', 'pt-BR': 'Servidor WebSocket', ru: 'WebSocket-сервер', 'zh-CN': 'WebSocket 服务端' } },
                { label: 'TCP',              slug: 'io/tcp',               translations: { de: 'TCP', es: 'TCP', fr: 'TCP', ja: 'TCP', ko: 'TCP', 'pt-BR': 'TCP', ru: 'TCP', 'zh-CN': 'TCP' } },
                { label: 'UDP',              slug: 'io/udp',               translations: { de: 'UDP', es: 'UDP', fr: 'UDP', ja: 'UDP', ko: 'UDP', 'pt-BR': 'UDP', ru: 'UDP', 'zh-CN': 'UDP' } },
              ],
            },
            {
              label: 'HTTP',
              translations: { de: 'HTTP', es: 'HTTP', fr: 'HTTP', ja: 'HTTP', ko: 'HTTP', 'pt-BR': 'HTTP', ru: 'HTTP', 'zh-CN': 'HTTP' },
              collapsed: true,
              items: [
                { label: 'Overview',    slug: 'http/overview',    translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'Route DSL',   slug: 'http/route-dsl',   translations: { de: 'Route-DSL', es: 'DSL de rutas', fr: 'DSL de routes', ja: 'ルート DSL', ko: '라우트 DSL', 'pt-BR': 'DSL de rotas', ru: 'DSL маршрутов', 'zh-CN': '路由 DSL' } },
                { label: 'Marshalling', slug: 'http/marshalling', translations: { de: 'Marshalling', es: 'Marshalling', fr: 'Marshalling', ja: 'マーシャリング', ko: '마샬링', 'pt-BR': 'Marshalling', ru: 'Маршалинг', 'zh-CN': '编解码' } },
                {
                  label: 'Backends',
                  translations: { de: 'Backends', es: 'Backends', fr: 'Backends', ja: 'バックエンド', ko: '백엔드', 'pt-BR': 'Backends', ru: 'Бэкенды', 'zh-CN': '后端' },
                  collapsed: true,
                  items: [
                    { label: 'Fastify', slug: 'http/backends/fastify', translations: { de: 'Fastify', es: 'Fastify', fr: 'Fastify', ja: 'Fastify', ko: 'Fastify', 'pt-BR': 'Fastify', ru: 'Fastify', 'zh-CN': 'Fastify' } },
                    { label: 'Express', slug: 'http/backends/express', translations: { de: 'Express', es: 'Express', fr: 'Express', ja: 'Express', ko: 'Express', 'pt-BR': 'Express', ru: 'Express', 'zh-CN': 'Express' } },
                    { label: 'Hono',    slug: 'http/backends/hono',    translations: { de: 'Hono', es: 'Hono', fr: 'Hono', ja: 'Hono', ko: 'Hono', 'pt-BR': 'Hono', ru: 'Hono', 'zh-CN': 'Hono' } },
                  ],
                },
                {
                  label: 'Middleware',
                  translations: { de: 'Middleware', es: 'Middleware', fr: 'Middleware', ja: 'ミドルウェア', ko: '미들웨어', 'pt-BR': 'Middleware', ru: 'Middleware', 'zh-CN': '中间件' },
                  collapsed: true,
                  items: [
                    { label: 'Response cache',  slug: 'http/middleware/response-cache',  translations: { de: 'Response-Cache', es: 'Cache de respuestas', fr: 'Cache de réponses', ja: 'レスポンスキャッシュ', ko: '응답 캐시', 'pt-BR': 'Cache de respostas', ru: 'Кэш ответов', 'zh-CN': '响应缓存' } },
                    { label: 'Rate limit',      slug: 'http/middleware/rate-limit',      translations: { de: 'Rate-Limit', es: 'Rate limit', fr: 'Limitation de débit', ja: 'レート制限', ko: '레이트 리밋', 'pt-BR': 'Rate limit', ru: 'Ограничение частоты', 'zh-CN': '限流' } },
                    { label: 'Idempotency key', slug: 'http/middleware/idempotency-key', translations: { de: 'Idempotency-Key', es: 'Clave de idempotencia', fr: 'Clé d’idempotence', ja: '冪等性キー', ko: '멱등성 키', 'pt-BR': 'Chave de idempotência', ru: 'Ключ идемпотентности', 'zh-CN': '幂等键' } },
                  ],
                },
              ],
            },
            {
              label: 'Cache',
              translations: { de: 'Cache', es: 'Cache', fr: 'Cache', ja: 'キャッシュ', ko: '캐시', 'pt-BR': 'Cache', ru: 'Кэш', 'zh-CN': '缓存' },
              collapsed: true,
              items: [
                { label: 'Overview',  slug: 'cache/overview',  translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'In-memory', slug: 'cache/in-memory', translations: { de: 'In-Memory', es: 'En memoria', fr: 'En mémoire', ja: 'インメモリ', ko: '인메모리', 'pt-BR': 'Em memória', ru: 'In-memory', 'zh-CN': '内存' } },
                { label: 'Memcached', slug: 'cache/memcached', translations: { de: 'Memcached', es: 'Memcached', fr: 'Memcached', ja: 'Memcached', ko: 'Memcached', 'pt-BR': 'Memcached', ru: 'Memcached', 'zh-CN': 'Memcached' } },
                { label: 'Redis',     slug: 'cache/redis',     translations: { de: 'Redis', es: 'Redis', fr: 'Redis', ja: 'Redis', ko: 'Redis', 'pt-BR': 'Redis', ru: 'Redis', 'zh-CN': 'Redis' } },
              ],
            },
            {
              label: 'Serialization',
              translations: { de: 'Serialisierung', es: 'Serialización', fr: 'Sérialisation', ja: 'シリアライゼーション', ko: '직렬화', 'pt-BR': 'Serialização', ru: 'Сериализация', 'zh-CN': '序列化' },
              collapsed: true,
              items: [
                { label: 'Overview',           slug: 'serialization/overview', translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'JSON',               slug: 'serialization/json',     translations: { de: 'JSON', es: 'JSON', fr: 'JSON', ja: 'JSON', ko: 'JSON', 'pt-BR': 'JSON', ru: 'JSON', 'zh-CN': 'JSON' } },
                { label: 'CBOR',               slug: 'serialization/cbor',     translations: { de: 'CBOR', es: 'CBOR', fr: 'CBOR', ja: 'CBOR', ko: 'CBOR', 'pt-BR': 'CBOR', ru: 'CBOR', 'zh-CN': 'CBOR' } },
                { label: 'Custom serializers', slug: 'serialization/custom',   translations: { de: 'Eigene Serializer', es: 'Serializadores personalizados', fr: 'Sérialiseurs personnalisés', ja: 'カスタムシリアライザ', ko: '커스텀 직렬화기', 'pt-BR': 'Serializadores personalizados', ru: 'Пользовательские сериализаторы', 'zh-CN': '自定义序列化器' } },
              ],
            },
          ],
        },
        {
          label: '📊 Observe',
          translations: { de: '📊 Beobachten', es: '📊 Observar', fr: '📊 Observer', ja: '📊 観測', ko: '📊 관측', 'pt-BR': '📊 Observar', ru: '📊 Наблюдаемость', 'zh-CN': '📊 可观测性' },
          collapsed: true,
          items: [
            { label: 'Overview', slug: 'observability/overview', translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
            {
              label: 'Metrics',
              translations: { de: 'Metriken', es: 'Métricas', fr: 'Métriques', ja: 'メトリクス', ko: '메트릭', 'pt-BR': 'Métricas', ru: 'Метрики', 'zh-CN': '指标' },
              collapsed: true,
              items: [
                { label: 'Core metrics',        slug: 'observability/metrics/core-metrics',        translations: { de: 'Core-Metriken', es: 'Métricas principales', fr: 'Métriques principales', ja: 'コアメトリクス', ko: '코어 메트릭', 'pt-BR': 'Métricas principais', ru: 'Базовые метрики', 'zh-CN': '核心指标' } },
                { label: 'Prometheus exporter', slug: 'observability/metrics/prometheus-exporter', translations: { de: 'Prometheus-Exporter', es: 'Exportador Prometheus', fr: 'Exporteur Prometheus', ja: 'Prometheus エクスポータ', ko: 'Prometheus 익스포터', 'pt-BR': 'Exportador Prometheus', ru: 'Экспортёр Prometheus', 'zh-CN': 'Prometheus 导出器' } },
                { label: 'prom-client adapter', slug: 'observability/metrics/prom-client-adapter', translations: { de: 'prom-client-Adapter', es: 'Adaptador prom-client', fr: 'Adaptateur prom-client', ja: 'prom-client アダプタ', ko: 'prom-client 어댑터', 'pt-BR': 'Adaptador prom-client', ru: 'Адаптер prom-client', 'zh-CN': 'prom-client 适配器' } },
                { label: 'Stock metrics',       slug: 'observability/metrics/stock-metrics',       translations: { de: 'Stock-Metriken', es: 'Métricas estándar', fr: 'Métriques standards', ja: '標準メトリクス', ko: '기본 제공 메트릭', 'pt-BR': 'Métricas padrão', ru: 'Стандартные метрики', 'zh-CN': '内置指标' } },
              ],
            },
            {
              label: 'Tracing',
              translations: { de: 'Tracing', es: 'Trazado', fr: 'Tracing', ja: 'トレーシング', ko: '트레이싱', 'pt-BR': 'Tracing', ru: 'Трассировка', 'zh-CN': '链路追踪' },
              collapsed: true,
              items: [
                { label: 'Tracer API',       slug: 'observability/tracing/tracer-api',       translations: { de: 'Tracer-API', es: 'Tracer API', fr: 'API Tracer', ja: 'Tracer API', ko: 'Tracer API', 'pt-BR': 'API de Tracer', ru: 'Tracer API', 'zh-CN': 'Tracer API' } },
                { label: 'OTel adapter',     slug: 'observability/tracing/otel-adapter',     translations: { de: 'OTel-Adapter', es: 'Adaptador OTel', fr: 'Adaptateur OTel', ja: 'OTel アダプタ', ko: 'OTel 어댑터', 'pt-BR': 'Adaptador OTel', ru: 'Адаптер OTel', 'zh-CN': 'OTel 适配器' } },
                { label: 'Recording tracer', slug: 'observability/tracing/recording-tracer', translations: { de: 'Recording-Tracer', es: 'Tracer de grabación', fr: 'Tracer d’enregistrement', ja: '記録トレーサ', ko: '레코딩 트레이서', 'pt-BR': 'Tracer de gravação', ru: 'Записывающий трассировщик', 'zh-CN': '记录式 Tracer' } },
                { label: 'Actor tracing',    slug: 'observability/tracing/actor-tracing',    translations: { de: 'Actor-Tracing', es: 'Trazado de Actor', fr: 'Tracing d’Actor', ja: 'アクタートレーシング', ko: '액터 트레이싱', 'pt-BR': 'Tracing de atores', ru: 'Трассировка акторов', 'zh-CN': 'Actor 追踪' } },
              ],
            },
            {
              label: 'Management',
              translations: { de: 'Management', es: 'Gestión', fr: 'Gestion', ja: '管理', ko: '매니지먼트', 'pt-BR': 'Gerenciamento', ru: 'Управление', 'zh-CN': '管理' },
              collapsed: true,
              items: [
                { label: 'Overview',       slug: 'observability/management/overview',       translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'Health checks',  slug: 'observability/management/health-checks',  translations: { de: 'Health-Checks', es: 'Health checks', fr: 'Health checks', ja: 'ヘルスチェック', ko: '헬스 체크', 'pt-BR': 'Health checks', ru: 'Проверки работоспособности', 'zh-CN': '健康检查' } },
                { label: 'HTTP endpoints', slug: 'observability/management/http-endpoints', translations: { de: 'HTTP-Endpoints', es: 'Endpoints HTTP', fr: 'Endpoints HTTP', ja: 'HTTP エンドポイント', ko: 'HTTP 엔드포인트', 'pt-BR': 'Endpoints HTTP', ru: 'HTTP-эндпоинты', 'zh-CN': 'HTTP 端点' } },
              ],
            },
          ],
        },
        {
          label: '✅ Test',
          translations: { de: '✅ Testen', es: '✅ Probar', fr: '✅ Tester', ja: '✅ テスト', ko: '✅ 테스트', 'pt-BR': '✅ Testar', ru: '✅ Тестирование', 'zh-CN': '✅ 测试' },
          collapsed: true,
          items: [
            { label: 'Overview',              slug: 'testing/overview',            translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
            { label: 'TestKit',               slug: 'testing/testkit',             translations: { de: 'TestKit', es: 'TestKit', fr: 'TestKit', ja: 'TestKit', ko: 'TestKit', 'pt-BR': 'TestKit', ru: 'TestKit', 'zh-CN': 'TestKit' } },
            { label: 'TestProbe',             slug: 'testing/test-probe',          translations: { de: 'TestProbe', es: 'TestProbe', fr: 'TestProbe', ja: 'TestProbe', ko: 'TestProbe', 'pt-BR': 'TestProbe', ru: 'TestProbe', 'zh-CN': 'TestProbe' } },
            { label: 'ManualScheduler',       slug: 'testing/manual-scheduler',    translations: { de: 'ManualScheduler', es: 'ManualScheduler', fr: 'ManualScheduler', ja: 'ManualScheduler', ko: 'ManualScheduler', 'pt-BR': 'ManualScheduler', ru: 'ManualScheduler', 'zh-CN': 'ManualScheduler' } },
            { label: 'MultiNodeSpec',         slug: 'testing/multi-node-spec',     translations: { de: 'MultiNodeSpec', es: 'MultiNodeSpec', fr: 'MultiNodeSpec', ja: 'MultiNodeSpec', ko: 'MultiNodeSpec', 'pt-BR': 'MultiNodeSpec', ru: 'MultiNodeSpec', 'zh-CN': 'MultiNodeSpec' } },
            { label: 'ParallelMultiNodeSpec', slug: 'testing/parallel-multi-node', translations: { de: 'ParallelMultiNodeSpec', es: 'ParallelMultiNodeSpec', fr: 'ParallelMultiNodeSpec', ja: 'ParallelMultiNodeSpec', ko: 'ParallelMultiNodeSpec', 'pt-BR': 'ParallelMultiNodeSpec', ru: 'ParallelMultiNodeSpec', 'zh-CN': 'ParallelMultiNodeSpec' } },
          ],
        },
        {
          label: '⚙️ Operate',
          translations: { de: '⚙️ Betreiben', es: '⚙️ Operar', fr: '⚙️ Exploiter', ja: '⚙️ 運用', ko: '⚙️ 운영', 'pt-BR': '⚙️ Operar', ru: '⚙️ Эксплуатация', 'zh-CN': '⚙️ 运维' },
          collapsed: true,
          items: [
            { label: 'Overview', slug: 'operations/overview', translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
            {
              label: 'Deployment',
              translations: { de: 'Deployment', es: 'Despliegue', fr: 'Déploiement', ja: 'デプロイ', ko: '배포', 'pt-BR': 'Implantação', ru: 'Развёртывание', 'zh-CN': '部署' },
              collapsed: true,
              items: [
                { label: 'Kubernetes',      slug: 'operations/deployment/kubernetes',      translations: { de: 'Kubernetes', es: 'Kubernetes', fr: 'Kubernetes', ja: 'Kubernetes', ko: 'Kubernetes', 'pt-BR': 'Kubernetes', ru: 'Kubernetes', 'zh-CN': 'Kubernetes' } },
                { label: 'Docker Compose',  slug: 'operations/deployment/docker-compose',  translations: { de: 'Docker Compose', es: 'Docker Compose', fr: 'Docker Compose', ja: 'Docker Compose', ko: 'Docker Compose', 'pt-BR': 'Docker Compose', ru: 'Docker Compose', 'zh-CN': 'Docker Compose' } },
                { label: 'Process manager', slug: 'operations/deployment/process-manager', translations: { de: 'Process-Manager', es: 'Gestor de procesos', fr: 'Gestionnaire de processus', ja: 'プロセスマネージャ', ko: '프로세스 매니저', 'pt-BR': 'Gerenciador de processos', ru: 'Менеджер процессов', 'zh-CN': '进程管理器' } },
              ],
            },
            {
              label: 'Tuning',
              translations: { de: 'Tuning', es: 'Ajuste', fr: 'Optimisation', ja: 'チューニング', ko: '튜닝', 'pt-BR': 'Ajuste de desempenho', ru: 'Тюнинг', 'zh-CN': '调优' },
              collapsed: true,
              items: [
                { label: 'Gossip cadence',    slug: 'operations/tuning/gossip-cadence',    translations: { de: 'Gossip-Kadenz', es: 'Cadencia de gossip', fr: 'Cadence de gossip', ja: 'Gossip ケイデンス', ko: '가십 주기', 'pt-BR': 'Cadência de gossip', ru: 'Частота gossip', 'zh-CN': 'Gossip 频率' } },
                { label: 'Failure detector',  slug: 'operations/tuning/failure-detector',  translations: { de: 'Failure Detector', es: 'Failure detector', fr: 'Failure detector', ja: 'Failure detector', ko: 'Failure detector', 'pt-BR': 'Failure detector', ru: 'Failure detector', 'zh-CN': 'Failure detector' } },
                { label: 'Mailbox sizing',    slug: 'operations/tuning/mailbox-sizing',    translations: { de: 'Mailbox-Sizing', es: 'Dimensionado de Mailbox', fr: 'Dimensionnement des Mailboxes', ja: 'Mailbox サイジング', ko: 'Mailbox 사이징', 'pt-BR': 'Dimensionamento de Mailbox', ru: 'Размер Mailbox', 'zh-CN': 'Mailbox 容量配置' } },
                { label: 'Dispatcher tuning', slug: 'operations/tuning/dispatcher-tuning', translations: { de: 'Dispatcher-Tuning', es: 'Ajuste de Dispatcher', fr: 'Optimisation des Dispatchers', ja: 'Dispatcher チューニング', ko: 'Dispatcher 튜닝', 'pt-BR': 'Ajuste de Dispatcher', ru: 'Настройка Dispatcher', 'zh-CN': 'Dispatcher 调优' } },
              ],
            },
            {
              label: 'Security',
              translations: { de: 'Sicherheit', es: 'Seguridad', fr: 'Sécurité', ja: 'セキュリティ', ko: '보안', 'pt-BR': 'Segurança', ru: 'Безопасность', 'zh-CN': '安全' },
              collapsed: true,
              items: [
                { label: 'Cluster security',    slug: 'operations/security/cluster-security',    translations: { de: 'Cluster-Sicherheit', es: 'Seguridad del Cluster', fr: 'Sécurité du Cluster', ja: 'クラスタセキュリティ', ko: '클러스터 보안', 'pt-BR': 'Segurança do Cluster', ru: 'Безопасность кластера', 'zh-CN': '集群安全' } },
                { label: 'Master key rotation', slug: 'operations/security/master-key-rotation', translations: { de: 'Master-Key-Rotation', es: 'Rotación de clave maestra', fr: 'Rotation de la clé maître', ja: 'マスターキーローテーション', ko: '마스터 키 로테이션', 'pt-BR': 'Rotação de chave mestra', ru: 'Ротация мастер-ключа', 'zh-CN': '主密钥轮换' } },
                { label: 'TLS everywhere',      slug: 'operations/security/tls-everywhere',      translations: { de: 'TLS überall', es: 'TLS en todas partes', fr: 'TLS partout', ja: 'TLS everywhere', ko: '전 구간 TLS', 'pt-BR': 'TLS em todos os lugares', ru: 'TLS везде', 'zh-CN': '全链路 TLS' } },
              ],
            },
            {
              label: 'Upgrades',
              translations: { de: 'Upgrades', es: 'Actualizaciones', fr: 'Mises à niveau', ja: 'アップグレード', ko: '업그레이드', 'pt-BR': 'Atualizações', ru: 'Обновления', 'zh-CN': '升级' },
              collapsed: true,
              items: [
                { label: 'Rolling migration',  slug: 'operations/upgrades/rolling-migration',  translations: { de: 'Rolling Migration', es: 'Migración rolling', fr: 'Migration progressive', ja: 'ローリング移行', ko: '롤링 마이그레이션', 'pt-BR': 'Migração rolling', ru: 'Плавающая миграция', 'zh-CN': '滚动迁移' } },
                { label: 'Upgrade strategies', slug: 'operations/upgrades/upgrade-strategies', translations: { de: 'Upgrade-Strategien', es: 'Estrategias de actualización', fr: 'Stratégies de mise à niveau', ja: 'アップグレード戦略', ko: '업그레이드 전략', 'pt-BR': 'Estratégias de atualização', ru: 'Стратегии обновления', 'zh-CN': '升级策略' } },
              ],
            },
            { label: 'Troubleshooting', slug: 'operations/troubleshooting', translations: { de: 'Troubleshooting', es: 'Solución de problemas', fr: 'Dépannage', ja: 'トラブルシューティング', ko: '트러블슈팅', 'pt-BR': 'Solução de problemas', ru: 'Устранение неполадок', 'zh-CN': '故障排查' } },
            {
              label: 'Runtime',
              translations: { de: 'Runtime', es: 'Runtime', fr: 'Runtime', ja: 'ランタイム', ko: '런타임', 'pt-BR': 'Runtime', ru: 'Среда выполнения', 'zh-CN': '运行时' },
              collapsed: true,
              items: [
                { label: 'Overview',             slug: 'runtime/overview',             translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
                { label: 'Compatibility matrix', slug: 'runtime/compatibility-matrix', translations: { de: 'Kompatibilitätsmatrix', es: 'Matriz de compatibilidad', fr: 'Matrice de compatibilité', ja: '互換性マトリクス', ko: '호환성 매트릭스', 'pt-BR': 'Matriz de compatibilidade', ru: 'Матрица совместимости', 'zh-CN': '兼容性矩阵' } },
                { label: 'Bun',                  slug: 'runtime/bun',                  translations: { de: 'Bun', es: 'Bun', fr: 'Bun', ja: 'Bun', ko: 'Bun', 'pt-BR': 'Bun', ru: 'Bun', 'zh-CN': 'Bun' } },
                { label: 'Node',                 slug: 'runtime/node',                 translations: { de: 'Node', es: 'Node', fr: 'Node', ja: 'Node', ko: 'Node', 'pt-BR': 'Node', ru: 'Node', 'zh-CN': 'Node' } },
                { label: 'Deno',                 slug: 'runtime/deno',                 translations: { de: 'Deno', es: 'Deno', fr: 'Deno', ja: 'Deno', ko: 'Deno', 'pt-BR': 'Deno', ru: 'Deno', 'zh-CN': 'Deno' } },
              ],
            },
          ],
        },
        {
          label: '💡 Examples',
          translations: { de: '💡 Beispiele', es: '💡 Ejemplos', fr: '💡 Exemples', ja: '💡 例', ko: '💡 예제', 'pt-BR': '💡 Exemplos', ru: '💡 Примеры', 'zh-CN': '💡 示例' },
          collapsed: true,
          items: [
            { label: 'Overview',             slug: 'examples/overview',             translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
            { label: 'Chat sample',          slug: 'examples/chat-sample',          translations: { de: 'Chat-Beispiel', es: 'Ejemplo de chat', fr: 'Exemple de chat', ja: 'チャットサンプル', ko: '채팅 샘플', 'pt-BR': 'Exemplo de chat', ru: 'Пример чата', 'zh-CN': '聊天示例' } },
            { label: 'Voice sample',         slug: 'examples/voice-sample',         translations: { de: 'Voice-Beispiel', es: 'Ejemplo de voz', fr: 'Exemple vocal', ja: '音声サンプル', ko: '음성 샘플', 'pt-BR': 'Exemplo de voz', ru: 'Голосовой пример', 'zh-CN': '语音示例' } },
            { label: 'Stand-alone snippets', slug: 'examples/stand-alone-snippets', translations: { de: 'Standalone-Snippets', es: 'Fragmentos independientes', fr: 'Snippets autonomes', ja: 'スタンドアロンスニペット', ko: '독립 실행 스니펫', 'pt-BR': 'Snippets independentes', ru: 'Отдельные сниппеты', 'zh-CN': '独立代码片段' } },
          ],
        },
        {
          label: '🚚 Migration',
          translations: { de: '🚚 Migration', es: '🚚 Migración', fr: '🚚 Migration', ja: '🚚 移行', ko: '🚚 마이그레이션', 'pt-BR': '🚚 Migração', ru: '🚚 Миграция', 'zh-CN': '🚚 迁移' },
          collapsed: true,
          items: [
            { label: 'Overview',        slug: 'migration/overview',        translations: { de: 'Überblick', es: 'Visión general', fr: 'Vue d’ensemble', ja: '概要', ko: '개요', 'pt-BR': 'Visão geral', ru: 'Обзор', 'zh-CN': '概览' } },
            { label: 'From Akka (JVM)', slug: 'migration/from-akka-jvm',   translations: { de: 'Von Akka (JVM)', es: 'Desde Akka (JVM)', fr: 'Depuis Akka (JVM)', ja: 'Akka (JVM) から', ko: 'Akka (JVM)에서', 'pt-BR': 'De Akka (JVM)', ru: 'С Akka (JVM)', 'zh-CN': '从 Akka (JVM) 迁移' } },
            { label: 'From Pekko',      slug: 'migration/from-pekko',      translations: { de: 'Von Pekko', es: 'Desde Pekko', fr: 'Depuis Pekko', ja: 'Pekko から', ko: 'Pekko에서', 'pt-BR': 'De Pekko', ru: 'С Pekko', 'zh-CN': '从 Pekko 迁移' } },
            { label: 'From Orleans',    slug: 'migration/from-orleans',    translations: { de: 'Von Orleans', es: 'Desde Orleans', fr: 'Depuis Orleans', ja: 'Orleans から', ko: 'Orleans에서', 'pt-BR': 'De Orleans', ru: 'С Orleans', 'zh-CN': '从 Orleans 迁移' } },
            { label: 'From Akka.NET',   slug: 'migration/from-akka-net',   translations: { de: 'Von Akka.NET', es: 'Desde Akka.NET', fr: 'Depuis Akka.NET', ja: 'Akka.NET から', ko: 'Akka.NET에서', 'pt-BR': 'De Akka.NET', ru: 'С Akka.NET', 'zh-CN': '从 Akka.NET 迁移' } },
            { label: 'From vanilla TS', slug: 'migration/from-vanilla-ts', translations: { de: 'Von Vanilla-TS', es: 'Desde vanilla TS', fr: 'Depuis TS vanilla', ja: 'バニラ TS から', ko: '바닐라 TS에서', 'pt-BR': 'De vanilla TS', ru: 'С vanilla TS', 'zh-CN': '从原生 TypeScript 迁移' } },
          ],
        },
        {
          label: '📖 Reference',
          translations: { de: '📖 Referenz', es: '📖 Referencia', fr: '📖 Référence', ja: '📖 リファレンス', ko: '📖 레퍼런스', 'pt-BR': '📖 Referência', ru: '📖 Справочник', 'zh-CN': '📖 参考' },
          collapsed: true,
          items: [
            { label: 'Configuration',  slug: 'reference/configuration',  translations: { de: 'Konfiguration', es: 'Configuración', fr: 'Configuration', ja: '設定', ko: '설정', 'pt-BR': 'Configuração', ru: 'Конфигурация', 'zh-CN': '配置' } },
            { label: 'Version policy', slug: 'reference/version-policy', translations: { de: 'Versionsrichtlinie', es: 'Política de versiones', fr: 'Politique de versions', ja: 'バージョンポリシー', ko: '버전 정책', 'pt-BR': 'Política de versionamento', ru: 'Политика версионирования', 'zh-CN': '版本策略' } },
            { label: 'FAQ',            slug: 'reference/faq',            translations: { de: 'FAQ', es: 'FAQ', fr: 'FAQ', ja: 'FAQ', ko: 'FAQ', 'pt-BR': 'FAQ', ru: 'FAQ', 'zh-CN': 'FAQ' } },
            { label: 'Glossary',       slug: 'reference/glossary',       translations: { de: 'Glossar', es: 'Glosario', fr: 'Glossaire', ja: '用語集', ko: '용어집', 'pt-BR': 'Glossário', ru: 'Глоссарий', 'zh-CN': '术语表' } },
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
          translations: { de: '🎁 Extras', es: '🎁 Extras', fr: '🎁 Extras', ja: '🎁 追加機能', ko: '🎁 부가 기능', 'pt-BR': '🎁 Extras', ru: '🎁 Дополнительно', 'zh-CN': '🎁 附加内容' },
          collapsed: true,
          items: [
            { label: 'Design decisions',              slug: 'extras/design-decisions',              translations: { de: 'Design-Entscheidungen', es: 'Decisiones de diseño', fr: 'Décisions de conception', ja: '設計判断', ko: '설계 결정', 'pt-BR': 'Decisões de design', ru: 'Проектные решения', 'zh-CN': '设计决策' } },
            { label: 'Architecture Decision Records', slug: 'extras/architecture-decision-records', translations: { de: 'Architecture Decision Records', es: 'Architecture Decision Records', fr: 'Architecture Decision Records', ja: 'Architecture Decision Records', ko: 'Architecture Decision Records', 'pt-BR': 'Architecture Decision Records', ru: 'Architecture Decision Records', 'zh-CN': '架构决策记录' } },
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
