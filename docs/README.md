# actor-ts documentation site

This directory hosts the Astro Starlight documentation site for
**actor-ts**.  It's a self-contained sub-project — its own `package.json`,
`node_modules/`, and build pipeline.  CI under
`.github/workflows/docs.yml` builds it on every push to `main` and
deploys the result to **GitHub Pages**:

> https://pathosDev.github.io/actor-ts/

## Local development

```bash
cd docs
bun install        # one-time
bun run dev        # starts the Astro dev server at http://localhost:4321/actor-ts/
```

## Local build

```bash
cd docs
bun run build      # produces docs/dist/, identical to what CI deploys
bun run preview    # serves docs/dist/ at http://localhost:4321/actor-ts/ for inspection
```

## Project layout

```
docs/
├── astro.config.mjs          ← Starlight integration: theme, sidebar, i18n, …
├── package.json              ← Astro + @astrojs/starlight + @fontsource deps
├── tsconfig.json             ← Strict Astro TS config
├── public/                   ← Static assets served as-is (logo, favicon)
├── src/
│   ├── content/
│   │   ├── config.ts         ← Starlight collection schema
│   │   └── docs/             ← All Markdown pages (organized by IA Part)
│   ├── styles/
│   │   └── custom.css        ← Logo-derived theme + font setup
│   └── env.d.ts              ← Astro client types
└── README.md                 ← (this file)
```

## Theme / fonts

- **Colors**: Tailwind palette derived from the logo (Indigo primary,
  Slate background basis, Red for cautions).  Full palette in
  `src/styles/custom.css`.
- **Body font**: Inter Variable (via `@fontsource-variable/inter`).
- **Code font**: JetBrains Mono (via `@fontsource/jetbrains-mono`) —
  matches the `font-family` already specified in `public/logo.svg`'s
  wordmark.

## Writing docs

Pages follow a three-tier reading model: *Was du damit machen kannst →
Minimales Beispiel → Wie es funktioniert → Wann (nicht) anwenden →
Häufige Fallstricke → Verwandte Konzepte → API-Referenz*.  Reader can
stop after any tier and have learned something useful — keeps
newcomers oriented while still carrying technical depth for
experienced users.
