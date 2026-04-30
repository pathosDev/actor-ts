# Next.js frontend (TODO — followup issue)

Stub directory.  The Next.js variant of the chat sample is tracked
as a followup issue and not yet implemented.

## Scaffolding plan

```bash
npx create-next-app@latest frontend-next --typescript --app
cd frontend-next
npm install
# Configure for static export
# next.config.js: { output: 'export' }
npm run build
cp -r out/* ../static/next/
```

Pages to write:
- `app/login/page.tsx` — Server Component shell + Client form.
- `app/chat/page.tsx` — `'use client'`, three-column layout.
- `app/chat/_components/{rooms-panel,chat-window,users-panel}.tsx`.
- `app/chat/_lib/websocket.ts` — Client-side WS hook.

State: `useReducer` + Context for cross-component WS access.
Next.js >= 15, App Router, RSC for the static parts.

Shared protocol via relative import; Next.js + Vite resolve
`../shared/protocol` without extra config when the `tsconfig.json`
includes `"baseUrl": ".."`.
