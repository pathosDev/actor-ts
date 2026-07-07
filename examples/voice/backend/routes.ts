/**
 * HTTP routes via the framework's directive DSL.  Voice variant.
 *
 * Like the chat sample, the only DSL-routed path is `GET /` for the
 * frontend-selector landing page.  Static-files (`/static/*`) and
 * the WebSocket upgrade (`/ws`) are mounted as Fastify plugins via
 * `backend.withPlugin(...)`.
 *
 * The selector lists all six frontends; URLs match the build
 * outputs under `examples/voice/static/<framework>/`.  The page
 * also doubles as a brief "what this sample demonstrates" pitch
 * since voice differs from chat in primitive choice.
 */
import {
  complete,
  concat,
  get,
  rawCodec,
  Status,
  websocket,
  WebSocketRouteOptions,
  type Route,
  type WsFrame,
  type WsServerMessage,
} from '../../../src/http/index.js';
import type { ActorRef } from '../../../src/index.js';

const SELECTOR_HTML = /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>actor-ts voice sample — pick a frontend</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        max-width: 680px;
        margin: 3rem auto;
        padding: 0 1rem;
        line-height: 1.6;
      }
      h1 { margin-bottom: 0.25rem; }
      .lead { color: #888; margin-top: 0; }
      ul.frontends { list-style: none; padding: 0; }
      ul.frontends li {
        margin: 0.5rem 0;
        padding: 0.75rem 1rem;
        border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
        border-radius: 6px;
      }
      ul.frontends li a {
        font-weight: 600;
        text-decoration: none;
        color: inherit;
      }
      ul.frontends li a:hover { text-decoration: underline; }
      ul.frontends li small { color: #888; display: block; margin-top: 0.25rem; }
      .creds, .arch {
        margin-top: 2rem;
        font-size: 0.9rem;
        background: color-mix(in srgb, currentColor 5%, transparent);
        border-radius: 6px;
        padding: 0.75rem 1rem;
      }
      code {
        background: color-mix(in srgb, currentColor 10%, transparent);
        padding: 0 0.25rem;
        border-radius: 3px;
      }
    </style>
  </head>
  <body>
    <h1>actor-ts voice sample</h1>
    <p class="lead">
      Three voice modes over one WebSocket per client: 1:1
      push-to-talk, 1:N group megaphone, and N:N rooms (Teams-style).
      Headphones recommended.
    </p>
    <p style="font-size: 0.85rem; color: #666; margin-top: -0.5rem;">
      Talking to whichever cluster node currently owns the
      <code>http-ingress</code> singleton on port 8081.  Chat sample
      uses 8080 — both samples can run side-by-side.
    </p>
    <ul class="frontends">
      <li><a href="/static/plain/">Plain HTML</a><small>vanilla — no build, no framework</small></li>
      <li><a href="/static/angular/">Angular</a><small>standalone components, signals</small></li>
      <li><a href="/static/react/">React + Vite</a><small>pure React SPA, no meta-framework</small></li>
      <li><a href="/static/next/">Next.js</a><small>App Router, RSC</small></li>
      <li><a href="/static/svelte/">SvelteKit</a><small>Svelte 5 runes, adapter-static</small></li>
      <li><a href="/static/lit/">Lit</a><small>Web Components, standards-based</small></li>
    </ul>
    <div class="creds">
      <strong>Test credentials</strong> (demo — passwords visible by design):
      <ul style="margin: 0.5rem 0 0 0; padding-left: 1.25rem;">
        <li><code>alice</code> / <code>wonderland</code></li>
        <li><code>bob</code> / <code>builder</code></li>
        <li><code>charlie</code> / <code>chaplin</code></li>
        <li><code>diana</code> / <code>prince</code></li>
      </ul>
    </div>
    <div class="arch">
      <strong>What this exercises</strong> — vs. the chat sample:
      <ul style="margin: 0.5rem 0 0 0; padding-left: 1.25rem;">
        <li><code>Receptionist</code> for 1:1 user-ref lookup (chat doesn't need this).</li>
        <li><code>DistributedPubSub</code> per-group / per-room topics
            for audio fan-out — one wire frame per remote node, not per subscriber.</li>
        <li><code>DistributedData</code> ORSets for online + per-room presence.</li>
        <li><strong>No</strong> sharded entities, <strong>no</strong> persistence —
            voice is ephemeral by design.</li>
      </ul>
    </div>
  </body>
</html>
`;

export function buildRoutes(ingress: ActorRef<WsServerMessage<WsFrame, WsFrame>>): Route {
  const wsRouteOptions = WebSocketRouteOptions.create()
    .withCodec(rawCodec());
  return concat(
    get(() =>
      complete(Status.OK, SELECTOR_HTML, { 'content-type': 'text/html; charset=utf-8' }),
    ),
    websocket('/ws', ingress, wsRouteOptions),
  );
}
