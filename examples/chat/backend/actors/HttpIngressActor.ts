/**
 * Cluster-singleton-managed HTTP front door.
 *
 * The chat sample binds the user-facing HTTP port (default 8080)
 * exactly once cluster-wide.  This actor owns that bind: when the
 * `ClusterSingleton` extension elects a leader the manager spawns
 * one of these instances on the chosen node, `preStart()` opens
 * the listener, `postStop()` releases it.  When the holding node
 * crashes or leaves the cluster, the singleton manager on a
 * surviving node spawns a fresh instance which re-binds the same
 * port — clients reconnect to the same `localhost:8080` URL and
 * keep going.
 *
 * Everything else (sharded `ChatRoomActor`, DistributedPubSub
 * mediator, OnlineUsersActor, the SQLite journal) runs on every
 * node already, so the new ingress comes up with all the
 * infrastructure it needs.  In-flight WebSocket connections to
 * the failed node are lost — clients reconnect, re-login, and the
 * persistent chat history is already there.
 *
 * Trade-off: failover takes about as long as the cluster's
 * `downAfterMs` plus a couple of singleton-handshake hops
 * (~5–10 s with the demo's failure-detector settings).  For real
 * zero-downtime active/active deployments you'd front the cluster
 * with an external load balancer (nginx, HAProxy, K8s Service);
 * that's out of scope for the local sample.
 */
import * as path from 'node:path';
import {
  Actor,
  Props,
  type ActorRef,
  type ActorSystem,
} from '../../../../src/index.js';
import { FastifyBackend } from '../../../../src/http/backend/FastifyBackend.js';
import type { ServerBinding } from '../../../../src/http/backend/HttpServerBackend.js';
import type {
  Subscribe,
  Unsubscribe,
} from '../../../../src/cluster/pubsub/Messages.js';
import { WebsocketIngressActor } from './WebsocketIngressActor.js';
import { buildRoutes } from '../routes.js';
import type { ChatRoomCommand } from './ChatRoomActor.js';
import type { ChatRoomDirectoryCommand } from './ChatRoomDirectoryActor.js';
import type { DmChannelCommand } from './DmChannelActor.js';
import type { OnlineUsersCommand } from './OnlineUsersActor.js';
import type { ReadReceiptsCommand } from './ReadReceiptsActor.js';
import type { SessionStore } from '../auth/sessionStore.js';

/**
 * Optional TLS material — when both `cert` and `key` are present
 * the ingress binds via Fastify's HTTPS mode.  Frontends already
 * pick `wss:` over `ws:` based on `location.protocol`, so a single
 * cert + key flips the whole sample to TLS without any client-side
 * change.  See `backend/config.ts` for the CLI / env wiring and
 * the chat sample README for cert-generation recipes
 * (`mkcert localhost` for local dev, Caddy or nginx in front for
 * production).
 */
export interface TlsMaterial {
  readonly cert: Buffer | string;
  readonly key: Buffer | string;
}

export interface HttpIngressDeps {
  /** Bind interface — typically `127.0.0.1` for the local demo. */
  readonly host: string;
  /** Public port — single value shared cluster-wide. */
  readonly httpPort: number;
  /** Used to compute the static-files root next to `backend/main.ts`. */
  readonly staticDir: string;
  /** ActorSystem reference passed through to the WS plugin. */
  readonly system: ActorSystem;
  /** Sharded ChatRoom region — local ref on any node. */
  readonly chatRoomRegion: ActorRef<ChatRoomCommand>;
  /** Sharded DmChannel region (one per canonical participant pair). */
  readonly dmChannelRegion: ActorRef<DmChannelCommand>;
  /** Local OnlineUsersActor on this node. */
  readonly onlineUsers: ActorRef<OnlineUsersCommand>;
  /** Local DistributedPubSub mediator on this node. */
  readonly mediator: ActorRef<Subscribe | Unsubscribe>;
  /** Cluster-wide session-token store (DD-LWWMap-backed). */
  readonly sessions: SessionStore;
  /** Local ChatRoomDirectoryActor — fan-out for room create/list. */
  readonly roomDirectory: ActorRef<ChatRoomDirectoryCommand>;
  /** Local ReadReceiptsActor — per-room read-up-to pointers. */
  readonly readReceipts: ActorRef<ReadReceiptsCommand>;
  /** Optional TLS — when set, the listener becomes HTTPS + WSS. */
  readonly tls?: TlsMaterial;
}

/**
 * The singleton actor's mailbox is empty by design — it just holds
 * the binding.  Typing as `never` keeps the discipline clear: any
 * tell to this actor is a programming error.
 */
export class HttpIngressActor extends Actor<never> {
  private binding: ServerBinding | null = null;

  constructor(private readonly deps: HttpIngressDeps) { super(); }

  override async preStart(): Promise<void> {
    const { host, httpPort, staticDir, system, tls } = this.deps;
    const scheme = tls ? 'https' : 'http';
    this.log.info(
      `[ingress] this node won the singleton — binding ${scheme}://${host}:${httpPort}`,
    );

    // Fastify's constructor accepts a `https` option — when set it
    // wraps a Node `https.Server` instead of a plain `http.Server`,
    // and `@fastify/websocket` automatically negotiates `wss:` on
    // the same socket.  The framework's `FastifyBackend` already
    // forwards arbitrary opts to Fastify, so a single `https`
    // option is all we need to flip the entire sample to TLS.
    const backend = new FastifyBackend({
      logger: false,
      ...(tls ? { https: { cert: tls.cert, key: tls.key } } : {}),
    });

    // Spawn the WebSocket ingress hub — one actor for the whole `/ws`
    // route; it spawns a UserSessionActor per connection.  The
    // @fastify/websocket plugin is registered automatically by the
    // backend when it sees a websocket() route.
    const ingress = system.spawn(
      Props.create(() => new WebsocketIngressActor({
        chatRoomRegion: this.deps.chatRoomRegion,
        dmChannelRegion: this.deps.dmChannelRegion,
        onlineUsers: this.deps.onlineUsers,
        mediator: this.deps.mediator,
        sessions: this.deps.sessions,
        roomDirectory: this.deps.roomDirectory,
        readReceipts: this.deps.readReceipts,
      })),
      'ws-ingress',
    );

    this.binding = await system.http(httpPort, { host, backend }).bind(buildRoutes(ingress, staticDir));
    this.log.info(
      `[ingress] HTTP server listening on ${scheme}://${this.binding.host}:${this.binding.port}/`,
    );
  }

  override async postStop(): Promise<void> {
    if (!this.binding) return;
    this.log.info(
      `[ingress] giving up HTTP port ${this.binding.port} (failover or shutdown)`,
    );
    try {
      await this.binding.unbind();
    } catch (e) {
      this.log.warn(`[ingress] unbind failed: ${(e as Error).message}`);
    }
    this.binding = null;
  }

  override onReceive(_msg: never): void {
    // Singleton has no protocol — it's just a binding holder.
  }
}

/**
 * Convenience: build a `Props<never>` for the singleton manager.
 * Lives here so `main.ts` doesn't need to know about the actor's
 * dep struct.
 */
export function httpIngressProps(deps: HttpIngressDeps): Props<never> {
  return Props.create<never>(() => new HttpIngressActor(deps));
}

void path; // path is imported for callers that pass through __dirname-style paths.
