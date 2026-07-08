/**
 * Cluster-singleton-managed HTTP front door — voice variant.
 *
 * Direct twin of the chat sample's HttpIngressActor: same singleton
 * lifecycle, same Fastify+plugins shape.  Differences:
 *
 *   - Default port 8081 (chat occupies 8080; running both samples
 *     side-by-side is supported).
 *   - Plugin deps swap `chatRoomRegion + onlineUsers` for the voice
 *     plumbing: `voicePresence`, `mediator`, `receptionist`, plus
 *     the shared `sessions`.  The WebSocket plugin then spawns
 *     `VoiceSessionActor`s instead of `UserSessionActor`s.
 *
 * Static-files prefix is identical (`/static/<framework>/...`) so
 * the frontend selector at `GET /` can route to per-framework
 * builds the same way the chat sample does.
 */
import {
  Actor,
  Props,
  type ActorRef,
  type ActorSystem,
} from '../../../../src/index.js';
import { FastifyBackend } from '../../../../src/http/backend/FastifyBackend.js';
import type { ServerBinding } from '../../../../src/http/backend/HttpServerBackend.js';
import type {
  Publish,
  Subscribe,
  Unsubscribe,
} from '../../../../src/cluster/pubsub/Messages.js';
import { registerStaticFiles } from '../plugins/staticFilesPlugin.js';
import { WebsocketIngressActor } from './WebsocketIngressActor.js';
import { buildRoutes } from '../routes.js';
import type { VoicePresenceCommand } from './VoicePresenceActor.js';
import type { SessionStore } from '../auth/sessionStore.js';

export interface HttpIngressDeps {
  readonly host: string;
  readonly httpPort: number;
  readonly staticDir: string;
  readonly system: ActorSystem;
  readonly receptionist: ActorRef<unknown>;
  readonly mediator: ActorRef<Subscribe | Unsubscribe | Publish<unknown>>;
  readonly voicePresence: ActorRef<VoicePresenceCommand>;
  readonly sessions: SessionStore;
}

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

    // Spawn the WebSocket ingress hub — one actor for the whole `/ws`
    // route; it spawns a VoiceSessionActor per connection.  The
    // @fastify/websocket plugin is registered automatically by the
    // backend when it sees a websocket() route.
    const ingress = system.spawn(
      Props.create(() => new WebsocketIngressActor({
        receptionist: this.deps.receptionist,
        mediator: this.deps.mediator,
        voicePresence: this.deps.voicePresence,
        sessions: this.deps.sessions,
      })),
      'ws-ingress',
    );

    this.binding = await system.http(httpPort, { host, backend }).bind(buildRoutes(ingress));
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

  override onReceive(_msg: never): void { /* no protocol */ }
}

export function httpIngressProps(deps: HttpIngressDeps): Props<never> {
  return Props.create<never>(() => new HttpIngressActor(deps));
}
