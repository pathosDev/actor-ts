# Angular frontend

Angular 21 (latest Major) + Standalone APIs + Signals.  No NgModules,
no NgRx — Signals make the chat state flat enough that the bundled
`ChatService` is one file you can read top-to-bottom.

## Build

```bash
npm install
npm run build
```

The build script writes to `../static/angular/` so the running chat
backend (`backend/main.ts`) serves it under `/static/angular/`
without any extra config.

```bash
# Open in a browser after the cluster is up:
http://localhost:8081/static/angular/
```

## Source layout

```
src/
├── index.html             ← Angular's host page; the actor-ts
│                            backend never serves this directly,
│                            it only serves the built bundle.
├── main.ts                ← bootstrapApplication(AppComponent)
├── styles.css             ← global theme variables (--accent, ...)
└── app/
    ├── app.component.ts       ← root: login / chat switch
    ├── login.component.ts     ← reactive form; calls ChatService.connect()
    ├── chat.component.ts      ← three-column layout, control-flow @for/@if
    ├── chat.service.ts        ← WS + signals (state)
    └── protocol.ts            ← local copy of shared/protocol.ts (see notes)
```

The protocol types are duplicated under `src/app/protocol.ts` rather
than imported from `../../shared/`.  Reaching outside the Angular
project's source root would require relaxing `rootDir` and the
strict-mode settings the Angular compiler relies on; duplicating a
~50-line file keeps the project self-contained.

## What this demonstrates

- **Standalone components** — no `NgModule`, all `imports` live on
  the component itself.
- **Signals** — `signal()` / `computed()` for chat state, drives
  Angular's change-detection without manual `ChangeDetectorRef`
  calls.
- **Built-in control flow** — `@for`, `@if` in templates instead of
  `*ngFor`, `*ngIf`.
- **`viewChild()` function** — modern alternative to the
  `@ViewChild` decorator.

## Versions

- Angular >= 21
- TypeScript ~5.9
- RxJS ~7.8
- zone.js ~0.15
