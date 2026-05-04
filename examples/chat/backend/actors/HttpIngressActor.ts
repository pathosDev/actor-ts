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
import { HttpExtensionId } from '../../../../src/http/index.js';
import { FastifyBackend } from '../../../../src/http/backend/FastifyBackend.js';
import type { ServerBinding } from '../../../../src/http/backend/HttpServerBackend.js';
import type {
  Subscribe,
  Unsubscribe,
} from '../../../../src/cluster/pubsub/Messages.js';
import { registerStaticFiles } from '../plugins/staticFilesPlugin.js';
import {
  registerWebSocketSupport,
  webSocketRoutePlugin,
} from '../plugins/webSocketPlugin.js';
import { buildRoutes } from '../routes.js';
import type { ChatRoomCmd } from './ChatRoomActor.js';
import type { OnlineUsersCmd } from './OnlineUsersActor.js';
import type { SessionStore } from '../auth/sessionStore.js';

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
  readonly chatRoomRegion: ActorRef<ChatRoomCmd>;
  /** Local OnlineUsersActor on this node. */
  readonly onlineUsers: ActorRef<OnlineUsersCmd>;
  /** Local DistributedPubSub mediator on this node. */
  readonly mediator: ActorRef<Subscribe | Unsubscribe>;
  /** Cluster-wide session-token store (DD-LWWMap-backed). */
  readonly sessions: SessionStore;
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
    const { host, httpPort, staticDir, system } = this.deps;
    this.log.info(
      `[ingress] this node won the singleton — binding ${host}:${httpPort}`,
    );

    const backend = new FastifyBackend();
    await registerStaticFiles(backend, {
      root: staticDir,
      prefix: '/static/',
    });
    // Two-stage WS registration; see plugins/webSocketPlugin.ts.
    await registerWebSocketSupport(backend);
    await backend.withPlugin(webSocketRoutePlugin, {
      system,
      chatRoomRegion: this.deps.chatRoomRegion,
      onlineUsers: this.deps.onlineUsers,
      mediator: this.deps.mediator,
      sessions: this.deps.sessions,
    });

    const http = system.extension(HttpExtensionId);
    this.binding = await http
      .newServerAt(host, httpPort)
      .useBackend(backend)
      .bind(buildRoutes());
    this.log.info(
      `[ingress] HTTP server listening on http://${this.binding.host}:${this.binding.port}/`,
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
