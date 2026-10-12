/**
 * Base class for a WebSocket server hub — the actor you bind a route to
 * with `websocket(path, ref)`.  ONE hub handles every connection on the
 * route; the framework spawns an internal session actor per connection
 * behind the scenes (you never manage those).
 *
 *     type In  = { kind: 'ping'; n: number };
 *     type Out = { kind: 'pong'; n: number };
 *
 *     class PingServer extends WebsocketServerActor<Out, In> {
 *       onMessage(message: In): void {
 *         this.reply({ kind: 'pong', n: message.n });   // → the sending connection
 *       }
 *     }
 *
 * `TOut` (what you send) comes first, then `TIn` (what you receive), to
 * match the `websocket()` / client generic order.  `TSelf` (default
 * `never`) is for app-level messages other actors `tell` this hub.
 *
 * You override `onMessage` (required) and optionally the lifecycle
 * hooks.  Do NOT override `onReceive` — it is the sealed dispatcher that
 * turns mailbox envelopes into these calls.  Per connection you observe
 * exactly: `onClientConnected` → zero+ `onMessage` (in frame order) →
 * `onClientDisconnected`, all serialised through this one actor.
 */
import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import { ActorRef } from '../../ActorRef.js';
import { countMailboxDrops } from '../../internal/ActorCell.js';
import { MailboxFullError } from '../../mailbox/DroppingMailbox.js';
import { stoppingStrategy, type SupervisorStrategy } from '../../Supervision.js';
import { classNameOf } from '../../util/ClassName.js';
import type { WebsocketDecodeError } from './WebsocketCodec.js';
import type { WebsocketConnection } from './WebsocketConnection.js';
import { WebsocketConnectionActor } from './WebsocketConnectionActor.js';
import type {
  WebsocketAcceptCommand,
  WebsocketConnectedSignal,
  WebsocketDataSignal,
  WebsocketDisconnectedSignal,
  WebsocketInvalidSignal,
  WebsocketServerMessage,
  WebsocketServerSignal,
} from './WebsocketMessages.js';
import type { WebsocketCloseInfo } from './Types.js';

export abstract class WebsocketServerActor<TOut, TIn, TSelf = never>
  extends Actor<WebsocketServerMessage<TOut, TIn, TSelf>> {

  private readonly _clients = new Map<string, WebsocketConnection<TOut>>();
  private _current: WebsocketConnection<TOut> | null = null;

  /* ----------------------- user overrides ------------------------ */

  /** Handle one decoded client message.  `this.connection` / `this.sender` = the sender. */
  abstract onMessage(message: TIn): void | Promise<void>;

  /** A client completed the upgrade.  Ordered before its first `onMessage`. */
  protected onClientConnected(_client: WebsocketConnection<TOut>): void | Promise<void> {}

  /** A client went away.  Ordered after its last `onMessage`; then it leaves `clients`. */
  protected onClientDisconnected(_client: WebsocketConnection<TOut>, _info: WebsocketCloseInfo): void | Promise<void> {}

  /** A frame failed to decode.  Only called when the route policy is `'hook'`. */
  protected onInvalidMessage(_client: WebsocketConnection<TOut>, _error: WebsocketDecodeError): void | Promise<void> {}

  /**
   * App-level message told to this hub's ref — your `TSelf` — or anything else
   * none of the hub's own kinds matched, which includes a body a remote node
   * addressed to this path.
   *
   * The default declines it: a warn naming the message's *class*, then
   * `this.unhandled(message)`, which dead-letters it with this hub as the
   * recipient and counts it in `actor_unhandled_total{class}` (#1442).  It
   * used to warn with `String(message)` and stop there, which printed the
   * payload into the log, left the decline invisible to anything but that
   * line, and threw on a body whose `toString` is not callable — restarting
   * the hub, which tears down every connection it had spawned, on one peer
   * frame.  The warn stays because it says what the dead-letter record
   * cannot: that this hook was not overridden.
   */
  protected onSelfMessage(message: TSelf): void | Promise<void> {
    this.log.warn(`WebsocketServerActor: unhandled self message: ${classNameOf(message)}`);
    this.unhandled(message);
  }

  /* ----------------------- helpers ------------------------------- */

  /** The connection whose event is being processed.  Throws outside a hook / onMessage. */
  protected get connection(): WebsocketConnection<TOut> {
    if (this._current === null) {
      throw new Error('this.connection is only valid inside onMessage / onClient* hooks');
    }
    return this._current;
  }

  /**
   * Reply to the current connection — `this.connection.tell(message)`, except
   * that a connection whose queue refuses the frame cannot fail the hub (see
   * {@link _tellConnection}).
   */
  protected reply(message: TOut): void {
    this._tellConnection(this.connection, message);
  }

  /**
   * Send to every open connection (optionally filtered).  A connection whose
   * queue refuses the frame misses it; every other one still gets it.
   */
  protected broadcast(message: TOut, filter?: (c: WebsocketConnection<TOut>) => boolean): void {
    for (const client of this._clients.values()) {
      if (client.isOpen && (!filter || filter(client))) this._tellConnection(client, message);
    }
  }

  /** Live connections, keyed by connection id. */
  protected get clients(): ReadonlyMap<string, WebsocketConnection<TOut>> {
    return this._clients;
  }

  /** Close every connection. */
  protected closeAll(code = 1000, reason = ''): void {
    for (const client of this._clients.values()) client.close(code, reason);
  }

  /**
   * One connection's frame, with that connection's refusal contained here.
   *
   * A route may bound its connections with `connectionMailboxOverflow:
   * 'reject'`, and a full `reject` queue throws `MailboxFullError` on the
   * sender's stack — which for `reply` and `broadcast` is this hub.  Uncaught,
   * one connection that had fallen behind failed the hub, and the restart tore
   * down every connection it had spawned; `broadcast` also stopped at the first
   * refusal, so every client after the slow one missed the frame as well.
   *
   * So the frame is lost for that connection alone, and counted the way a
   * bound that drops reports the same loss: `actor_mailbox_dropped_total` under
   * the connection actor's class, reason `drop-new` — the arriving frame is the
   * one that did not make it.  Nothing else is caught.  A `tell` the
   * application makes on a connection itself still throws on its own stack,
   * which is what `reject` promises a sender; and `closeAll` needs no guard,
   * because a close takes the exempt door no bound refuses (#985).
   */
  private _tellConnection(client: WebsocketConnection<TOut>, message: TOut): void {
    try {
      client.tell(message);
    } catch (e) {
      if (!(e instanceof MailboxFullError)) throw e;
      const metrics = this.system._metricsRegistry;
      if (metrics !== null) countMailboxDrops(metrics, WebsocketConnectionActor.name, 'drop-new', 1);
    }
  }

  /* ----------------------- sealed dispatch ----------------------- */

  /**
   * Supervision for the per-connection child actors: stop a crashed
   * connection (its `postStop` still reports the disconnect) rather than
   * restart it into a dead socket.  Override on your subclass only if you
   * really mean to change how connection failures are handled.
   */
  override supervisorStrategy(): SupervisorStrategy {
    return stoppingStrategy;
  }

  /** @internal Sealed — do not override; override `onMessage` + hooks instead. */
  override async onReceive(message: WebsocketServerMessage<TOut, TIn, TSelf>): Promise<void> {
    // Uniform `kind` dispatch over the accept command + lifecycle signals.
    //
    // Matched against the envelope union rather than the mailbox type: `TSelf`
    // is an open type parameter, and ts-pattern cannot build a `Pattern<>` for
    // a union that still contains one.  Narrowing here keeps every arm fully
    // typed, and `.otherwise` — reached exactly when none of our kinds hit —
    // hands the original message back as the app-level `TSelf`.
    //
    // Each arm also requires the one field only the framework can supply, so a
    // decoded body that merely spells one of these kinds lands in `.otherwise`
    // too — see `isLiveConnection` for why `kind` alone was not enough.
    const envelope = message as WebsocketAcceptCommand | WebsocketServerSignal<TOut, TIn>;
    await match(envelope)
      .with({ kind: 'websocket-accept', actor: P.when(isActorFactory) }, (m) => this.onWebsocketAccept(m))
      .with({ kind: 'websocket-connected', connection: P.when(isLiveConnection) }, (m) => this.onWebsocketConnected(m))
      .with({ kind: 'websocket-data', connection: P.when(isLiveConnection) }, (m) => this.onWebsocketData(m))
      .with({ kind: 'websocket-disconnected', connection: P.when(isLiveConnection) }, (m) =>
        this.onWebsocketDisconnected(m))
      .with({ kind: 'websocket-invalid', connection: P.when(isLiveConnection) }, (m) => this.onWebsocketInvalid(m))
      .otherwise(() => this.onSelfMessage(message as TSelf));
  }

  /* --------------------- dispatch arm handlers -------------------- */

  /**
   * Spawn the per-connection actor as THIS actor's child, so the tree is
   * server → conn-N and supervision/teardown are automatic — with the
   * options the route's policy asked for, which today is its connection
   * mailbox bound (#1432).  Absent options spawn it exactly as before.
   */
  private onWebsocketAccept(command: WebsocketAcceptCommand): void {
    this.context.spawn(command.actor, command.name, command.options);
  }

  /*
   * The `_current` bracket around each user hook below is what backs
   * `this.connection` / `this.reply()`.  It is `finally`, not a trailing
   * assignment, because a hook that throws would otherwise strand the
   * pointer and leak one connection's identity into the next event.
   */

  private async onWebsocketConnected(signal: WebsocketConnectedSignal<TOut>): Promise<void> {
    this._clients.set(signal.connection.id, signal.connection);
    this._current = signal.connection;
    try {
      await this.onClientConnected(signal.connection);
    } finally {
      this._current = null;
    }
  }

  private async onWebsocketData(signal: WebsocketDataSignal<TOut, TIn>): Promise<void> {
    this._current = signal.connection;
    try {
      await this.onMessage(signal.message);
    } finally {
      this._current = null;
    }
  }

  private async onWebsocketDisconnected(signal: WebsocketDisconnectedSignal<TOut>): Promise<void> {
    this._current = signal.connection;
    try {
      await this.onClientDisconnected(signal.connection, signal.info);
    } finally {
      this._current = null;
      this._clients.delete(signal.connection.id);
    }
  }

  private async onWebsocketInvalid(signal: WebsocketInvalidSignal<TOut>): Promise<void> {
    this._current = signal.connection;
    try {
      await this.onInvalidMessage(signal.connection, signal.error);
    } finally {
      this._current = null;
    }
  }
}

/**
 * A connection the framework built, as opposed to one a decoded body spells.
 *
 * A hub sits at a path a remote node can address, so a body that arrives over
 * the cluster wire reaches `onReceive` like any signal, and dispatching on
 * `kind` alone took `{ kind: 'websocket-connected', connection: { id: 'x' } }`
 * for the real thing: it planted a client whose `close` is not a function, the
 * next `closeAll()` threw, and the hub restarted with every real connection
 * under it — the outcome #713 closed for the receptionist and the singleton
 * manager.  The data, disconnected and invalid signals were as open: a forged
 * one ran `onMessage` with the peer's payload, evicted a live client from
 * `clients`, or reported a connection that does not exist.
 *
 * What a decoded body cannot carry is a function.  No codec produces one, and
 * the refs the cluster revives inside a body (`RefCodec.decodeRefs`) have no
 * `close` or `abort`.  So the hub accepts a connection only in the shape the
 * framework hands it — an `ActorRef` whose `close` and `abort` are callable —
 * and a forgery falls to `onSelfMessage`, which declines it.  A structural
 * test rather than `instanceof` on the implementation class, because the
 * connection is an interface: a stand-in that implements it with no socket
 * behind it is still a connection.
 */
function isLiveConnection(value: unknown): boolean {
  return value instanceof ActorRef
    && typeof (value as { close?: unknown }).close === 'function'
    && typeof (value as { abort?: unknown }).abort === 'function';
}

/**
 * The accept command's factory — the field that carries the socket, and a
 * function, so for the reason {@link isLiveConnection} gives no decoded body
 * can supply it.  Without it a forged accept asked the hub to spawn whatever
 * the body held, under whatever name it chose, and a name already taken threw
 * on the hub's own stack.
 */
function isActorFactory(value: unknown): boolean {
  return typeof value === 'function';
}
