# React + Vite frontend — voice sample

Pure React 19 SPA, no meta-framework, Vite build.  Mirrors
`examples/chat/frontend-react/` in shape; adapts for voice
(`useVoice` instead of `useChat`, MediaRecorder + per-sender
MediaSource instead of text broadcast).

```bash
cd examples/voice/frontend-react
npm install
npm run build
```

Build emits to `examples/voice/static/react/` where the voice
backend's `@fastify/static` plugin picks it up.  Open
`http://localhost:8081/static/react/` after starting the cluster.

The audio plumbing is identical to the plain HTML reference;
this version threads it through React's hook + reducer pattern.
