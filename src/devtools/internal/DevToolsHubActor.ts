/**
 * The WebSocket hub behind the DevTools tap — one actor serving every
 * connected browser tab.
 *
 * Running the tap as an actor is what makes it safe: subscription
 * bookkeeping, stream sequence numbering and snapshot generation all
 * happen on a single mailbox, so a snapshot can never interleave with
 * the deltas a tap emits while it is being built.  Taps publish by
 * telling this actor, which turns the mailbox into the natural buffer.
 */
import { match } from 'ts-pattern';
import { WebsocketServerActor } from '../../http/websocket/WebsocketServerActor.js';
import type { WebsocketConnection } from '../../http/websocket/WebsocketConnection.js';
import type { WebsocketCloseInfo } from '../../http/websocket/Types.js';
import {
  DEVTOOLS_CLOSE_VERSION_MISMATCH,
  DEVTOOLS_PROTOCOL_VERSION,
  decodeClientFrame,
  errorFrame,
  eventFrame,
  responseFrame,
} from '../protocol/index.js';
import type {
  DevToolsClientFrame,
  DevToolsRequestMethod,
  DevToolsServerFrame,
  DevToolsStreamId,
  DevToolsStreamPayload,
  HelloFrame,
  RequestFrame,
  SubscribeFrame,
  UnsubscribeFrame,
  WelcomeFrame,
} from '../protocol/index.js';
import {
  MAXIMUM_IN_FLIGHT_REQUESTS,
  MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION,
} from '../Constants.js';

/** Command told to the hub when a tap produces a payload. */
export type DevToolsPublishCommand = {
  readonly kind: 'devtools-publish';
  readonly stream: DevToolsStreamId;
  readonly payload: DevToolsStreamPayload;
};

/** Everything other components may tell the hub. */
export type DevToolsHubCommand = DevToolsPublishCommand;

/** @internal */
export function devToolsPublishCommand(
  stream: DevToolsStreamId,
  payload: DevToolsStreamPayload,
): DevToolsPublishCommand {
  return { kind: 'devtools-publish', stream, payload };
}

/**
 * What the hub needs from the server.  Declared here, on the consumer
 * side, so the hub does not import `DevToolsServer` — the server holds
 * a ref to the hub, and a type edge back would be a cycle.
 */
export interface DevToolsHubContext {
  /** Handshake answer, including panel availability. */
  welcome(): Omit<WelcomeFrame, 'kind' | 'protocolVersion'>;
  /** True when a tap is installed for `stream`. */
  isStreamAvailable(stream: DevToolsStreamId): boolean;
  /** Payloads a fresh subscriber needs before deltas make sense. */
  snapshot(stream: DevToolsStreamId): ReadonlyArray<DevToolsStreamPayload>;
  /** True when a handler is registered for `method`. */
  isMethodAvailable(method: DevToolsRequestMethod): boolean;
  /** Run a pull operation.  Rejects with a plain `Error` on bad input. */
  invoke(method: DevToolsRequestMethod, parameters: unknown): Promise<unknown>;
  /**
   * Subscriber count for `stream` changed — lets a tap idle while no
   * panel is looking at it.
   */
  streamSubscribersChanged(stream: DevToolsStreamId, count: number): void;
}

/** Per-connection state. */
type DevToolsSession = {
  greeted: boolean;
  /**
   * Requests dispatched on this connection and not yet settled.  Lives on
   * the session rather than being derived, because the work happens off
   * the mailbox and there is nothing else left to count it.
   */
  inFlightRequests: number;
  readonly streams: Set<DevToolsStreamId>;
};

export class DevToolsHubActor
  extends WebsocketServerActor<DevToolsServerFrame, unknown, DevToolsHubCommand> {

  private readonly sessions = new Map<string, DevToolsSession>();
  /** Last sequence number handed out per stream; gaps mean dropped frames. */
  private readonly sequenceNumbers = new Map<DevToolsStreamId, number>();
  /**
   * Requests outstanding across every connection, live and closed alike
   * (#758).  Kept on the actor rather than summed over `sessions` on
   * demand: a request outlives the session that asked for it — the socket
   * can drop while a replay is still folding — and the work it is doing
   * has to keep holding its slot until it actually finishes.
   */
  private inFlightRequests = 0;

  constructor(private readonly hub: DevToolsHubContext) {
    super();
  }

  /* --------------------------- connections --------------------------- */

  protected override onClientConnected(client: WebsocketConnection<DevToolsServerFrame>): void {
    this.sessions.set(client.id, { greeted: false, inFlightRequests: 0, streams: new Set() });
  }

  protected override onClientDisconnected(
    client: WebsocketConnection<DevToolsServerFrame>,
    _info: WebsocketCloseInfo,
  ): void {
    const session = this.sessions.get(client.id);
    this.sessions.delete(client.id);
    // Report the drop AFTER removing the session so the recomputed
    // counts do not include the connection that just went away.
    if (session) for (const stream of session.streams) this.reportSubscribers(stream);
  }

  /* ----------------------------- inbound ----------------------------- */

  override onMessage(message: unknown): void {
    // Capture the connection up front: `this.connection` is only valid
    // synchronously inside the hook, and request handling continues
    // after an await.
    const client = this.connection;
    const session = this.sessions.get(client.id);
    if (session === undefined) return;

    const frame = decodeClientFrame(message);
    if (frame === null) {
      client.tell(errorFrame('malformed-frame', 'not a DevTools protocol frame'));
      return;
    }
    if (!session.greeted && frame.kind !== 'hello') {
      client.tell(errorFrame('malformed-frame', 'expected `hello` as the first frame'));
      client.close(DEVTOOLS_CLOSE_VERSION_MISMATCH, 'handshake missing');
      return;
    }
    this.dispatch(frame, client, session);
  }

  private dispatch(
    frame: DevToolsClientFrame,
    client: WebsocketConnection<DevToolsServerFrame>,
    session: DevToolsSession,
  ): void {
    match(frame)
      .with({ kind: 'hello' }, (f) => this.onHello(f, client, session))
      .with({ kind: 'subscribe' }, (f) => this.onSubscribe(f, client, session))
      .with({ kind: 'unsubscribe' }, (f) => this.onUnsubscribe(f, client, session))
      .with({ kind: 'request' }, (f) => this.onRequest(f, client, session))
      .exhaustive();
  }

  private onHello(
    frame: HelloFrame,
    client: WebsocketConnection<DevToolsServerFrame>,
    session: DevToolsSession,
  ): void {
    if (frame.protocolVersion !== DEVTOOLS_PROTOCOL_VERSION) {
      // Refuse rather than negotiate.  A UI bundle from a different
      // release rendering a half-understood tree is worse than a banner
      // telling the developer to rebuild.
      client.tell(errorFrame(
        'version-mismatch',
        `server speaks DevTools protocol v${DEVTOOLS_PROTOCOL_VERSION}, client sent v${frame.protocolVersion}`,
      ));
      client.close(DEVTOOLS_CLOSE_VERSION_MISMATCH, 'protocol version mismatch');
      return;
    }
    session.greeted = true;
    this.log.debug(`[devtools] client connected: ${frame.client ?? 'unnamed'} (${client.id})`);
    client.tell({ kind: 'welcome', protocolVersion: DEVTOOLS_PROTOCOL_VERSION, ...this.hub.welcome() });
  }

  private onSubscribe(
    frame: SubscribeFrame,
    client: WebsocketConnection<DevToolsServerFrame>,
    session: DevToolsSession,
  ): void {
    if (!this.hub.isStreamAvailable(frame.stream)) {
      client.tell(errorFrame('unavailable', `stream "${frame.stream}" is not available on this system`));
      return;
    }
    const added = !session.streams.has(frame.stream);
    session.streams.add(frame.stream);
    if (added) this.reportSubscribers(frame.stream);
    // Snapshot last, and only to this client: it must reflect every
    // delta already broadcast, which is guaranteed because publishes
    // and this call share the mailbox.
    for (const payload of this.hub.snapshot(frame.stream)) {
      client.tell(eventFrame(frame.stream, this.nextSequenceNumber(frame.stream), payload));
    }
  }

  private onUnsubscribe(
    frame: UnsubscribeFrame,
    _client: WebsocketConnection<DevToolsServerFrame>,
    session: DevToolsSession,
  ): void {
    if (session.streams.delete(frame.stream)) this.reportSubscribers(frame.stream);
  }

  private onRequest(
    frame: RequestFrame,
    client: WebsocketConnection<DevToolsServerFrame>,
    session: DevToolsSession,
  ): void {
    if (!this.hub.isMethodAvailable(frame.method)) {
      client.tell(errorFrame('unavailable', `method "${frame.method}" is not available on this system`, frame.requestId));
      return;
    }
    const refusal = this.capacityRefusal(session);
    if (refusal !== null) {
      // Refused, not queued: a queue is the same unbounded backlog with
      // a slower fuse, and the client is the one holding the retry.  Not
      // logged either — a line per refused frame under a flood would turn
      // the log into the amplifier the cap just closed.
      client.tell(errorFrame('unavailable', refusal, frame.requestId));
      return;
    }
    session.inFlightRequests++;
    this.inFlightRequests++;
    // Deliberately NOT awaited: a slow journal read would otherwise
    // block this hub's mailbox and stall every other connected tab.
    void this.hub.invoke(frame.method, frame.parameters)
      .then((result) => {
        if (client.isOpen) client.tell(responseFrame(frame.requestId, result));
      })
      .catch((error: unknown) => {
        if (client.isOpen) {
          client.tell(errorFrame('bad-parameters', (error as Error).message, frame.requestId));
        }
      })
      // Last in the chain on purpose: `finally` runs exactly once however
      // the request ends, including when the `then` arm throws and the
      // `catch` above picks it up.  Releasing the slot inside both arms
      // instead would double-release that path.
      .finally(() => this.settleRequest(client.id));
  }

  /**
   * Why this request cannot be dispatched right now, or `null` to admit
   * it (#758).  The message is the client's only diagnosis — it names the
   * limit it hit and that retrying is the answer.
   */
  private capacityRefusal(session: DevToolsSession): string | null {
    if (session.inFlightRequests >= MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION) {
      return `this connection already has ${MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION} `
        + 'requests in flight; retry once one of them has been answered';
    }
    if (this.inFlightRequests >= MAXIMUM_IN_FLIGHT_REQUESTS) {
      return `the DevTools tap is at its ceiling of ${MAXIMUM_IN_FLIGHT_REQUESTS} `
        + 'concurrent requests across all connections; retry shortly';
    }
    return null;
  }

  /**
   * Release the slot one settled request held.
   *
   * Looked up by connection id rather than closing over the session
   * object, because `onClientDisconnected` may already have dropped it —
   * a socket can close while its replay is still folding.  The hub-wide
   * count is released either way: the work really has finished, whoever
   * asked for it.
   */
  private settleRequest(clientId: string): void {
    this.inFlightRequests--;
    const session = this.sessions.get(clientId);
    if (session !== undefined) session.inFlightRequests--;
  }

  /* ----------------------------- outbound ---------------------------- */

  protected override onSelfMessage(message: DevToolsHubCommand): void {
    match(message)
      .with({ kind: 'devtools-publish' }, (m) => this.onDevToolsPublish(m))
      .exhaustive();
  }

  private onDevToolsPublish(command: DevToolsPublishCommand): void {
    const frame = eventFrame(
      command.stream,
      this.nextSequenceNumber(command.stream),
      command.payload,
    );
    this.broadcast(frame, (client) => {
      const session = this.sessions.get(client.id);
      return session !== undefined && session.greeted && session.streams.has(command.stream);
    });
  }

  /* ------------------------------ helpers ---------------------------- */

  private nextSequenceNumber(stream: DevToolsStreamId): number {
    const next = (this.sequenceNumbers.get(stream) ?? 0) + 1;
    this.sequenceNumbers.set(stream, next);
    return next;
  }

  private reportSubscribers(stream: DevToolsStreamId): void {
    let count = 0;
    for (const session of this.sessions.values()) if (session.streams.has(stream)) count++;
    this.hub.streamSubscribersChanged(stream, count);
  }
}
