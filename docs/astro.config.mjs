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
      // Logo is wired in Commit 1.2 once `docs/public/logo.svg` exists.
      // logo: { src: './public/logo.svg', replacesTitle: true },
      customCss: ['./src/styles/custom.css'],
      // Pagefind search is built in — no extra config needed.
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        de: { label: 'Deutsch', lang: 'de' },
      },
      // Sidebar will be populated by Commit 2.3 (after the ~150 stub pages
      // are scaffolded in Commit 2.2).  Empty array here keeps the build
      // green and the chrome visible.
      sidebar: [],
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
