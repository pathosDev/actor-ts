/**
 * HTTP routes via the framework's directive DSL.
 *
 * The chat sample is "all WebSocket" — there are no REST endpoints.
 * The DSL serves the landing page at `/`, the built frontends under
 * `/static/*` via the `getFromDirectory` directive (backend-agnostic —
 * no Fastify plugin), and upgrades WebSocket clients at `/ws` via the
 * `websocket()` directive.
 *
 * The selector HTML is inlined as a tagged template — small enough
 * (~3 KB) that splitting it into its own file would just add another
 * read.  Kept dependency-free + framework-free so it works the
 * moment a single node is up.
 */
import {
  complete,
  concat,
  get,
  getFromDirectory,
  rawCodec,
  Status,
  websocket,
  WebSocketRouteOptions,
  type Route,
} from '../../../src/http/index.js';
import type { WsFrame } from '../../../src/http/index.js';
import type { ActorRef } from '../../../src/index.js';
import type { WsServerMessage } from '../../../src/http/index.js';

const SELECTOR_HTML = /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>actor-ts chat sample — pick a frontend</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        max-width: 640px;
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
      .creds {
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
    <h1>actor-ts chat sample</h1>
    <p class="lead">
      Pick a frontend.  All six talk the same WebSocket protocol to
      the same clustered backend — open them in different windows,
      log in as different users, and watch messages converge.
    </p>
    <p style="font-size: 0.85rem; color: #666; margin-top: -0.5rem;">
      You're talking to whichever cluster node currently owns the
      <code>http-ingress</code> singleton on port 8080.  Kill that
      node and a survivor takes over — same URL, same sessions
      after reconnect.
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
      <strong>Test credentials</strong> (this is a demo — passwords visible by design):
      <ul style="margin: 0.5rem 0 0 0; padding-left: 1.25rem;">
        <li><code>alice</code> / <code>wonderland</code></li>
        <li><code>bob</code> / <code>builder</code></li>
        <li><code>charlie</code> / <code>chaplin</code></li>
        <li><code>diana</code> / <code>prince</code></li>
      </ul>
    </div>
    <p style="margin-top: 2rem; color: #888; font-size: 0.85rem;">
      Backend: 3-node TCP cluster · HTTP front door = ClusterSingleton
      (one bind cluster-wide, automatic failover) · ChatRoom = sharded
      PersistentActor · history persisted to SQLite · cross-node
      fan-out via DistributedPubSub · presence via DistributedData ORSet.
    </p>
  </body>
</html>
`;

/**
 * Route tree: `GET /` returns the selector HTML, `getFromDirectory` serves
 * the built frontends under `/static/*` from `staticDir`, and
 * `websocket('/ws', ingress)` upgrades WebSocket clients (rawCodec — the
 * chat protocol is JSON-over-text the session actor encodes itself).
 */
export function buildRoutes(
  ingress: ActorRef<WsServerMessage<WsFrame, WsFrame>>,
  staticDir: string,
): Route {
  const wsRouteOptions = WebSocketRouteOptions.create().withCodec(rawCodec());
  return concat(
    get(() =>
      complete(Status.OK, SELECTOR_HTML, { 'content-type': 'text/html; charset=utf-8' }),
    ),
    getFromDirectory('static', staticDir),
    websocket('/ws', ingress, wsRouteOptions),
  );
}
