# Angular frontend (TODO — followup issue)

Stub directory.  The Angular variant of the chat sample is tracked
as a followup issue and not yet implemented.

## Scaffolding plan

```bash
ng new frontend-angular --standalone --style=css --routing
cd frontend-angular
npm install
ng build --output-path=../static/angular
```

Components to write:
- `LoginComponent` — reactive form, calls `AuthService.login()`.
- `ChatComponent` — three-column layout (`<rooms-panel>`, `<chat-window>`, `<users-panel>`).
- `ChatService` — `WebSocketSubject<ServerMessage>` + signals.

State management: Signals + RxJS interop for the WebSocket.  Latest
Angular major (>= 19) ships with stable signals.

Protocol types are imported from `../shared/protocol.ts` — set up a
Vite/Webpack alias so the build resolves the shared folder.
