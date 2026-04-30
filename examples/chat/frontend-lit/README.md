# Lit frontend

The shipped Lit frontend is the same `index.html` already present
under `examples/chat/static/lit/index.html` — Lit is loaded as ES
modules from a CDN (`https://esm.sh/lit@3`), so no build step or
`node_modules` is required.

For a production deployment you'd typically:

1. Drop the inline `<script type="module">` block into a `src/main.ts`.
2. Use Vite + `@vite-bundler` to produce a small bundle.
3. Output to `../static/lit/`.

```bash
npm create vite@latest frontend-lit -- --template lit-ts
cd frontend-lit
npm install
npm run build -- --outDir ../static/lit
```

The shipped CDN-based version stays self-contained for the demo.
