# React + Vite frontend

React 19 + Vite — a single-page application demonstrating chat
without any meta-framework.  The contrast with the Next.js variant
is deliberate: same React, but here the project is a pure SPA with
no SSR / RSC / file-based routing.

## Build

```bash
npm install
npm run build
```

The build script writes to `../static/react/` so the chat backend's
`@fastify/static` serves it at `/static/react/`.

```bash
# Open after the cluster is up:
http://localhost:8081/static/react/
```

## Source layout

```
src/
├── main.tsx          ← createRoot(...).render(<App />)
├── App.tsx           ← LoginView / ChatView phase split
├── useChat.ts        ← WebSocket + state via useReducer
├── protocol.ts       ← local copy of shared/protocol.ts
└── styles.css        ← global theme
```

## What this demonstrates

- **React 19** functional components, hooks (`useReducer`,
  `useCallback`, `useEffect`).
- **`useReducer`** for multi-room state — atomic updates across
  `messagesByRoom` + `unreadByRoom` per `message` action.
- **WS lifecycle** owned by a custom hook (`useChat`); UI only sees
  plain values + dispatch-like actions.
- **Vite** build — fast, ESBuild-based, tiny config.

## Why a local protocol mirror?

The shared protocol types under `examples/chat/shared/` aren't
imported directly because Vite's strict-mode TS settings expect a
single source root.  Reaching into `../shared` adds friction without
real value for a 50-line file — same approach as the Angular and
Lit variants.

## Versions

- React 19, React-DOM 19
- Vite 8, @vitejs/plugin-react 6
- TypeScript ~5.9
