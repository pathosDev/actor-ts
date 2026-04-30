# React + Vite frontend (TODO — followup issue)

Stub directory.  The React variant of the chat sample is tracked as
a followup issue and not yet implemented.

## Scaffolding plan

```bash
npm create vite@latest frontend-react -- --template react-ts
cd frontend-react
npm install
npm run build -- --outDir ../static/react
```

Components to write:
- `<LoginPage />` — controlled form, posts to `useAuth()`.
- `<ChatPage />` — three-column CSS-Grid layout.
- `<RoomsPanel />`, `<ChatWindow />`, `<UsersPanel />`.
- `useWebSocket()` — custom hook owning the `WebSocket`,
  buffers messages until React state is ready.

State: `useReducer` for multi-room state, `useEffect` for the WS.
React >= 19 (use-Hook + Actions optional, not required).

Shared protocol types via relative import from `../shared/`.  Vite's
default config handles parent imports out of the box.
