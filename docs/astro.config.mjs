/**
 * Astro Starlight configuration for the actor-ts documentation site.
 *
 * Site lives at:
 *   - `https://pathosDev.github.io/actor-ts/` during the `pathosDev.github.io`
 *     subpath phase (current), hence `site` + `base` set to the repo path.
 *   - Move to a custom domain later by clearing `base`, setting `site` to
 *     the new origin, and configuring the CNAME under repo Settings -> Pages.
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

// TypeDoc → Starlight bridge.  Generates the API reference from
// JSDoc comments in `../src/`, writes Markdown pages under
// `src/content/docs/api/`, and exposes a `typeDocSidebarGroup` we
// can drop into the sidebar config (once the sidebar is wired up in
// Commit 2.3 — for now the group sits at the top-level until then).
const [starlightTypeDoc, typeDocSidebarGroup] = createStarlightTypeDocPlugin();

export default defineConfig({
  site: 'https://pathosDev.github.io',
  base: '/actor-ts',
  integrations: [
    starlight({
      title: 'actor-ts',
      description:
        'Akka-style actor model for TypeScript. Runs on Bun, Node, and Deno. ' +
        'Cluster sharding, event sourcing, distributed data, persistence, and ' +
        'observability — all in idiomatic TS.',
      // Logo replaces the textual title in the top-nav.  Source file lives
      // under `public/` so the build serves it at `/<base>/logo.svg`.
      logo: { src: './public/logo.svg', replacesTitle: true },
      // Favicon is auto-detected from `public/favicon.svg`; explicit
      // `head` entry below pins the SVG MIME-type for older browsers.
      head: [
        {
          tag: 'link',
          attrs: {
            rel: 'icon',
            type: 'image/svg+xml',
            href: '/actor-ts/favicon.svg',
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
      // Sidebar will be expanded by Commit 2.3 (after the ~150 stub
      // pages are scaffolded in Commit 2.2).  The TypeDoc-generated
      // API group already wires itself in via `typeDocSidebarGroup`
      // — that's the only non-empty sidebar entry at this commit.
      sidebar: [typeDocSidebarGroup],
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
