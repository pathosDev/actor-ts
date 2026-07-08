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
 *       onMessage(msg: In): void {
 *         this.reply({ kind: 'pong', n: msg.n });   // → the sending connection
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
import { Actor } from '../../Actor.js';
import { stoppingStrategy, type SupervisorStrategy } from '../../Supervision.js';
import type { WebsocketDecodeError } from './WebsocketCodec.js';
import type { WebsocketConnection } from './WebsocketConnection.js';
import type {
  WebsocketAcceptCommand,
  WebsocketConnectedSignal,
  WebsocketDataSignal,
  WebsocketDisconnectedSignal,
  WebsocketInvalidSignal,
  WebsocketServerMessage,
} from './WebsocketMessages.js';
import type { WebsocketCloseInfo } from './types.js';

export abstract class WebsocketServerActor<TOut, TIn, TSelf = never>
  extends Actor<WebsocketServerMessage<TOut, TIn, TSelf>> {

  private readonly _clients = new Map<string, WebsocketConnection<TOut>>();
  private _current: WebsocketConnection<TOut> | null = null;

  /* ----------------------- user overrides ------------------------ */

  /** Handle one decoded client message.  `this.connection` / `this.sender` = the sender. */
  abstract onMessage(msg: TIn): void | Promise<void>;

  /** A client completed the upgrade.  Ordered before its first `onMessage`. */
  protected onClientConnected(_client: WebsocketConnection<TOut>): void | Promise<void> {}

  /** A client went away.  Ordered after its last `onMessage`; then it leaves `clients`. */
  protected onClientDisconnected(_client: WebsocketConnection<TOut>, _info: WebsocketCloseInfo): void | Promise<void> {}

  /** A frame failed to decode.  Only called when the route policy is `'hook'`. */
  protected onInvalidMessage(_client: WebsocketConnection<TOut>, _error: WebsocketDecodeError): void | Promise<void> {}

  /** App-level message told to this hub's ref (reachable only when `TSelf` ≠ `never`). */
  protected onSelfMessage(msg: TSelf): void | Promise<void> {
    this.log.warn(`WebsocketServerActor: unhandled self message: ${String(msg)}`);
  }

  /* ----------------------- helpers ------------------------------- */

  /** The connection whose event is being processed.  Throws outside a hook / onMessage. */
  protected get connection(): WebsocketConnection<TOut> {
    if (this._current === null) {
      throw new Error('this.connection is only valid inside onMessage / onClient* hooks');
    }
    return this._current;
  }

  /** Reply to the current connection.  Sugar for `this.connection.tell(msg)`. */
  protected reply(msg: TOut): void {
    this.connection.tell(msg);
  }

  /** Send to every open connection (optionally filtered). */
  protected broadcast(msg: TOut, filter?: (c: WebsocketConnection<TOut>) => boolean): void {
    for (const c of this._clients.values()) {
      if (c.isOpen && (!filter || filter(c))) c.tell(msg);
    }
  }

  /** Live connections, keyed by connection id. */
  protected get clients(): ReadonlyMap<string, WebsocketConnection<TOut>> {
    return this._clients;
  }

  /** Close every connection. */
  protected closeAll(code = 1000, reason = ''): void {
    for (const c of this._clients.values()) c.close(code, reason);
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
  override async onReceive(msg: WebsocketServerMessage<TOut, TIn, TSelf>): Promise<void> {
    // Uniform `kind` dispatch over the accept command + lifecycle signals.
    switch ((msg as { readonly kind?: unknown }).kind) {
      case 'websocket-accept': {
        // Spawn the per-connection actor as THIS actor's child, so the
        // tree is server → conn-N and supervision/teardown are automatic.
        const command = msg as WebsocketAcceptCommand;
        this.context.spawn(command.props, command.name);
        return;
      }
      case 'websocket-connected': {
        const signal = msg as WebsocketConnectedSignal<TOut>;
        this._clients.set(signal.connection.id, signal.connection);
        this._current = signal.connection;
        try {
          await this.onClientConnected(signal.connection);
        } finally {
          this._current = null;
        }
        return;
      }
      case 'websocket-data': {
        const signal = msg as WebsocketDataSignal<TOut, TIn>;
        this._current = signal.connection;
        try {
          await this.onMessage(signal.message);
        } finally {
          this._current = null;
        }
        return;
      }
      case 'websocket-disconnected': {
        const signal = msg as WebsocketDisconnectedSignal<TOut>;
        this._current = signal.connection;
        try {
          await this.onClientDisconnected(signal.connection, signal.info);
        } finally {
          this._current = null;
          this._clients.delete(signal.connection.id);
        }
        return;
      }
      case 'websocket-invalid': {
        const signal = msg as WebsocketInvalidSignal<TOut>;
        this._current = signal.connection;
        try {
          await this.onInvalidMessage(signal.connection, signal.error);
        } finally {
          this._current = null;
        }
        return;
      }
      default:
        await this.onSelfMessage(msg as TSelf);
    }
  }
}
