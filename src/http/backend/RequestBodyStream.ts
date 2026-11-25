/**
 * The request side of streaming (#1868): a request body handed to a
 * `streamedBody()` route unread, as a `ReadableStream` that reads the
 * connection only when its consumer asks for the next chunk.
 *
 * The same discipline {@link reportingSourceFailure} keeps for response
 * bodies, run the other way: a high-water mark of zero, so the stream holds
 * no chunk its consumer has not asked for, and everything past what the
 * runtime's own socket buffer holds stays with the client, held back by TCP
 * or HTTP/2 flow control.  A handler piping the body into object storage
 * moves at the store's pace and holds one chunk at a time.
 *
 * Three backends feed it from two kinds of source — a `node:http` request
 * (Fastify, Express, Hono under Node) and a web `ReadableStream` (Hono under
 * Bun and Deno) — and all three apply the same limit, raise the same typed
 * errors and settle an unread remainder by the same rule, which is what the
 * parity suite holds them to.
 */
import { match } from 'ts-pattern';
import {
  STREAMED_BODY_DRAIN_LIMIT_BYTES,
  STREAMED_BODY_LINGER_BYTES,
  STREAMED_BODY_LINGER_MS,
  STREAMED_BODY_LINGER_POLL_MS,
} from '../Constants.js';
import { RequestBodyAbortedError, RequestBodyTooLargeError } from '../Types.js';

/** One chunk at a time off a request; `null` once the body ended. */
export interface RequestBodySource {
  /** The next chunk, or `null` at the end.  Rejects when the client aborted mid-body. */
  read(): Promise<Uint8Array | null>;
  /** Stop reading and drop what the source holds.  Never throws; the connection is the caller's to settle. */
  stop(): void;
}

/**
 * Where a streamed body stands, as the backend that settles the connection
 * after the response sees it:
 *
 * - `unread`     — the handler never pulled;
 * - `reading`    — pulled, not to the end;
 * - `ended`      — read to the end, nothing left on the connection;
 * - `over-limit` — errored with {@link RequestBodyTooLargeError};
 * - `aborted`    — errored with {@link RequestBodyAbortedError};
 * - `cancelled`  — the consumer cancelled it.
 */
export type RequestBodyState = 'unread' | 'reading' | 'ended' | 'over-limit' | 'aborted' | 'cancelled';

/** The live progress of one streamed body; mutated by the stream, read by the backend. */
export type RequestBodyProgress = {
  state: RequestBodyState;
  bytesRead: number;
};

export type LimitedRequestBodyParameters = {
  /** The route's limit; one byte more errors the stream. */
  readonly maxBytes: number;
  /** The declared `Content-Length`; a body that ends short of it was cut off by the client. */
  readonly declaredLength?: number;
  /**
   * Called once, before the first read — the moment the handler first asks
   * for the body.  `node:http` backends send a deferred `100 Continue` here.
   */
  readonly onFirstPull?: () => void;
};

/** A streamed body and the progress record its backend settles the connection by. */
export type LimitedRequestBody = {
  readonly body: ReadableStream<Uint8Array>;
  readonly progress: RequestBodyProgress;
};

/**
 * Wrap `source` as the pull-driven, limited stream a `streamedBody()` handler
 * reads.
 *
 * A chunk that carries the count past `maxBytes` is not enqueued: the stream
 * errors with {@link RequestBodyTooLargeError} instead, so a handler never
 * holds a byte past its limit.  A source that fails, or a body that ends short
 * of its declared length, errors it with {@link RequestBodyAbortedError}.
 */
export function limitedRequestBody(source: RequestBodySource, parameters: LimitedRequestBodyParameters): LimitedRequestBody {
  const progress: RequestBodyProgress = { state: 'unread', bytesRead: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      if (progress.state === 'unread') {
        progress.state = 'reading';
        parameters.onFirstPull?.();
      }
      for (;;) {
        let chunk: Uint8Array | null;
        try {
          chunk = await source.read();
        } catch (err) {
          progress.state = 'aborted';
          source.stop();
          controller.error(err instanceof RequestBodyAbortedError ? err : new RequestBodyAbortedError(err));
          return;
        }
        if (chunk === null) {
          if (parameters.declaredLength !== undefined && progress.bytesRead < parameters.declaredLength) {
            progress.state = 'aborted';
            controller.error(new RequestBodyAbortedError());
            return;
          }
          progress.state = 'ended';
          controller.close();
          return;
        }
        // An empty chunk answers nothing the consumer asked for; read on
        // rather than return, which would leave its read pending on a pull
        // the stream may never schedule again.
        if (chunk.byteLength === 0) continue;
        progress.bytesRead += chunk.byteLength;
        if (progress.bytesRead > parameters.maxBytes) {
          progress.state = 'over-limit';
          source.stop();
          controller.error(new RequestBodyTooLargeError(parameters.maxBytes));
          return;
        }
        controller.enqueue(chunk);
        return;
      }
    },
    cancel: () => {
      if (progress.state === 'unread' || progress.state === 'reading') progress.state = 'cancelled';
      source.stop();
    },
  }, { highWaterMark: 0 });
  return { body, progress };
}

/**
 * Whether the connection has to close after the response, rather than let
 * the runtime read the rest of the body off it.
 *
 * Measured: Node and Bun both read an unread remainder to its end after the
 * response — all of it, keeping the connection — so a refused 50 MiB upload is
 * received in full anyway.  Closing is the only bound.  A remainder known to
 * be small ({@link STREAMED_BODY_DRAIN_LIMIT_BYTES}) is left to that drain,
 * which keeps the connection; an unknown one (a chunked body) never is.  A
 * body that errored or was cancelled always closes: the bytes after it are
 * either more than the route admits or the rest of a request the client gave
 * up on.
 */
export function remainderForcesClose(progress: RequestBodyProgress, declaredLength: number | undefined): boolean {
  return match(progress.state)
    .with('ended', () => false)
    .with('over-limit', 'aborted', 'cancelled', () => true)
    .with('unread', 'reading', () =>
      declaredLength === undefined || declaredLength - progress.bytesRead > STREAMED_BODY_DRAIN_LIMIT_BYTES)
    .exhaustive();
}

/**
 * The body length a request declares: its `Content-Length`, `0` for an
 * HTTP/1.1 request with neither that nor `Transfer-Encoding` (which has no
 * body), and `undefined` when the length is unknown — a chunked body, or an
 * HTTP/2 request without the header, whose body ends with its stream.
 */
export function declaredBodyLength(headers: Readonly<Record<string, string | undefined>>, http2: boolean): number | undefined {
  const contentLength = headers['content-length'];
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    return undefined;
  }
  if (headers['transfer-encoding'] !== undefined || http2) return undefined;
  return 0;
}

/** The structural slice of a `node:http` / `node:http2` request this module reads. */
export type NodeRequestReadable = {
  read(): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  readonly readableEnded?: boolean;
};

/**
 * A {@link RequestBodySource} over a `node:http` (or `node:http2`
 * compatibility) request, read in paused mode: a `'readable'` listener and
 * `read()`, never `'data'`, so the request holds at most its own high-water
 * mark and the socket stops being read once that is full.
 *
 * `'close'` or `'aborted'` before `'end'` is the client going away; `'error'`
 * is the socket failing.  Both reject the pending read with
 * {@link RequestBodyAbortedError}.
 */
export function nodeRequestBodySource(request: NodeRequestReadable): RequestBodySource {
  let ended = request.readableEnded === true;
  let failure: RequestBodyAbortedError | null = null;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const pending = wake;
    wake = null;
    pending?.();
  };
  const onReadable = (): void => notify();
  const onEnd = (): void => { ended = true; notify(); };
  const onGone = (cause?: unknown): void => {
    if (!ended && failure === null) failure = new RequestBodyAbortedError(cause);
    notify();
  };
  const onError = (err: unknown): void => onGone(err);
  const onClose = (): void => onGone();
  const onAborted = (): void => onGone();
  request.on('readable', onReadable);
  request.on('end', onEnd);
  request.on('error', onError);
  request.on('close', onClose);
  request.on('aborted', onAborted);
  const detach = (): void => {
    request.off('readable', onReadable);
    request.off('end', onEnd);
    request.off('error', onError);
    request.off('close', onClose);
    request.off('aborted', onAborted);
  };
  return {
    read: async () => {
      for (;;) {
        if (failure !== null) throw failure;
        const chunk = request.read();
        if (chunk !== null && chunk !== undefined) return asBytes(chunk);
        if (ended) return null;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
    stop: () => {
      detach();
      notify();
    },
  };
}

/**
 * A {@link webRequestBodySource} whose release the backend times itself — see
 * `deferRelease`.
 */
export type WebRequestBodySource = RequestBodySource & {
  /** Whether a reader was taken — by a read, or by {@link WebRequestBodySource.hold}. */
  readonly taken: boolean;
  /** Take the reader now, if nothing has, without reading: the runtime sees the body as taken. */
  hold(): void;
  /** Cancel the reader, if one was taken.  What `stop()` does at once without `deferRelease`. */
  release(): void;
  /**
   * Read the rest of the body and drop it — at most `maxBytes`, within
   * `withinMs`.  `true` once it ended inside both bounds; `false` when it did
   * not, or failed, or the reader was already released.
   */
  drain(maxBytes: number, withinMs: number): Promise<boolean>;
};

export type WebRequestBodySourceOptions = {
  /**
   * Leave the reader held when the body is stopped, for the backend to
   * {@link WebRequestBodySource.release} once its response is out.  Deno 2.9
   * needs it — `HonoBackend.releasingDenoBody` says why.
   */
  readonly deferRelease?: boolean;
};

/**
 * A {@link RequestBodySource} over a web `ReadableStream` body — Hono under Bun
 * and Deno.
 *
 * Neither the stream nor its reader is touched before the first read — pass a
 * getter to keep even the stream unasked for until then.  A taken reader is a
 * claim on the connection: Deno 2.9 hands the connection to it once the
 * response is out, and a reader taken up front for a handler that never read
 * held it without answering the next request (measured on 2.9.8, #1878).  The
 * backend now settles every Deno body after the response, but a body nobody
 * asked for still has to be told apart from one a read took — a request that
 * expects `100 Continue` from a Deno that never sends one has no body coming,
 * and draining it would only wait.  A getter that answers `null` is a body
 * that has ended.
 */
export function webRequestBodySource(
  stream: ReadableStream<Uint8Array> | (() => ReadableStream<Uint8Array> | null),
  options: WebRequestBodySourceOptions = {},
): WebRequestBodySource {
  let resolved: ReadableStream<Uint8Array> | null | undefined = typeof stream === 'function' ? undefined : stream;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stopped = false;
  let released = false;
  const streamOf = (): ReadableStream<Uint8Array> | null => {
    if (resolved === undefined) resolved = (stream as () => ReadableStream<Uint8Array> | null)();
    return resolved;
  };
  const take = (): ReadableStreamDefaultReader<Uint8Array> | null => {
    if (reader === undefined) {
      const body = streamOf();
      if (body === null) return null;
      reader = body.getReader();
    }
    return reader;
  };
  const release = (): void => {
    if (released || reader === undefined) return;
    released = true;
    reader.cancel().catch(() => undefined);
  };
  return {
    get taken() { return reader !== undefined; },
    read: async () => {
      if (stopped) return null;
      const current = take();
      if (current === null) return null;
      try {
        const { done, value } = await current.read();
        return done ? null : value ?? new Uint8Array(0);
      } catch (err) {
        throw new RequestBodyAbortedError(err);
      }
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (options.deferRelease === true) return;
      if (reader !== undefined) {
        release();
        return;
      }
      // Nothing read: cancel the stream itself if it was ever asked for — one
      // that never was has nothing in flight to stop.
      released = true;
      if (resolved) resolved.cancel().catch(() => undefined);
    },
    hold: () => {
      if (!released) take();
    },
    release,
    drain: async (maxBytes, withinMs) => {
      if (released) return false;
      const current = take();
      if (current === null) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<'expired'>((resolve) => { timer = setTimeout(() => resolve('expired'), withinMs); });
      let drained = 0;
      try {
        for (;;) {
          const next = await Promise.race([current.read(), expired]);
          if (next === 'expired') return false;
          if (next.done) return true;
          drained += next.value?.byteLength ?? 0;
          if (drained > maxBytes) return false;
        }
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** A chunk a `node:http` request yields — a `Buffer`, or a string under `setEncoding` — as bytes. */
function asBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return new TextEncoder().encode(String(chunk));
}

/** The slice of a `node:http` / `node:http2` request {@link closeNodeConnectionAfterResponse} touches. */
export type NodeExchangeRequest = NodeRequestReadable & {
  removeAllListeners?(event: string): unknown;
  resume?(): unknown;
  readonly httpVersionMajor?: number;
  readonly socket?: LingeringSocket | null;
  readonly stream?: { close(code?: number): void; readonly closed?: boolean; readonly destroyed?: boolean };
};

/** The slice of a `node:http` / `node:http2` response {@link closeNodeConnectionAfterResponse} touches. */
export type NodeExchangeResponse = {
  readonly headersSent: boolean;
  setHeader(name: string, value: string): unknown;
  once(event: 'finish', listener: () => void): unknown;
};

/** The slice of a `net.Socket` the lingering close drives. */
export type LingeringSocket = {
  destroySoon?: () => void;
  end(): unknown;
  destroy(): void;
  readonly destroyed?: boolean;
  readonly bytesRead?: number;
  once(event: 'end' | 'close', listener: () => void): unknown;
};

/**
 * Make sure the unread remainder of a request is never read in full: on
 * HTTP/1.1 by answering with `Connection: close` and closing *lingeringly*;
 * on HTTP/2, where that header is forbidden, by closing the request's stream
 * with `NO_ERROR` once the response finished — RFC 9113 §8.1 allows exactly
 * that for a response sent before the request ended.
 *
 * **Why lingering (#1868).**  Measured with a client that keeps writing its
 * body: Node answers `Connection: close` by destroying the socket as soon as
 * the response is flushed, the bytes still arriving turn that into a TCP
 * reset, and the reset discards the response in the client's receive buffer —
 * the client sees `ECONNRESET`, never the 401.  So the socket's
 * `destroySoon` is taken over: the response is flushed and a FIN sent, the
 * rest is read and dropped (by `node:http`'s own parser) until the client
 * closes its side, {@link STREAMED_BODY_LINGER_BYTES} more arrived or
 * {@link STREAMED_BODY_LINGER_MS} passed, and only then is the socket
 * destroyed.  The same measurement after the change: the 401 arrives and
 * 0.4 MiB of a 50 MiB upload is taken in, on Node and on Bun.
 *
 * A response whose headers are already out can no longer say `close`, so the
 * socket is destroyed after it finished instead.
 */
export function closeNodeConnectionAfterResponse(request: NodeExchangeRequest, response: NodeExchangeResponse): void {
  if (request.httpVersionMajor === 2) {
    response.once('finish', () => {
      const stream = request.stream;
      if (stream === undefined || stream.closed === true || stream.destroyed === true) return;
      try {
        stream.close(HTTP2_NO_ERROR);
      } catch {
        /* already closing */
      }
    });
    return;
  }
  if (!response.headersSent) {
    response.setHeader('connection', 'close');
    const socket = request.socket;
    if (socket !== undefined && socket !== null) socket.destroySoon = () => lingeringClose(socket, request);
    return;
  }
  response.once('finish', () => request.socket?.destroy());
}

/**
 * Half-close `socket` once its writes are flushed, then destroy it when the
 * peer closes its side or the linger bound runs out — whichever is first.
 *
 * The request is switched to discarding first.  The response has finished, so
 * nothing reads the body any more — but the paused-mode reader a streamed
 * route attached is still there, and while a `'readable'` listener exists a
 * `resume()` does not flow: `node:http`'s own discard of the remainder stalls,
 * its parser stops reading the socket, and neither the peer's FIN nor the
 * byte bound is ever seen.  Measured on Node: the socket stayed open until the
 * deadline, and a server `close()` waited on it — on a runtime whose loop had
 * nothing else to do, forever, since the linger timers are unreferenced.
 */
function lingeringClose(socket: LingeringSocket, request: NodeExchangeRequest): void {
  request.removeAllListeners?.('readable');
  // On a later turn, after node:http has settled the request it just dumped:
  // a synchronous resume() here left an IncomingMessage paused on Node 26 —
  // a server close() over such a connection took 1.2 s, the linger deadline,
  // against 3 ms with this.  A plain PassThrough flows either way, so smoke
  // case 64, which hung on Node before, is what holds this.
  setTimeout(() => request.resume?.(), 0);
  const startBytes = socket.bytesRead ?? 0;
  // Timers rather than a clock reading: both bounds are elapsed time, and a
  // deadline timer needs no wall clock to compare against.
  let poll: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stopTimers = (): void => {
    if (poll !== undefined) clearInterval(poll);
    if (deadline !== undefined) clearTimeout(deadline);
    poll = undefined;
    deadline = undefined;
  };
  const finish = (): void => {
    stopTimers();
    if (socket.destroyed !== true) socket.destroy();
  };
  socket.once('end', finish);
  socket.once('close', stopTimers);
  socket.end();
  deadline = setTimeout(finish, STREAMED_BODY_LINGER_MS);
  poll = setInterval(() => {
    if (socket.destroyed === true || (socket.bytesRead ?? 0) - startBytes > STREAMED_BODY_LINGER_BYTES) finish();
  }, STREAMED_BODY_LINGER_POLL_MS);
  (deadline as { unref?: () => void }).unref?.();
  (poll as { unref?: () => void }).unref?.();
}

/** `NGHTTP2_NO_ERROR` — spelled out so this module needs no `node:http2` import on runtimes without one. */
const HTTP2_NO_ERROR = 0;

/* ----------------------------- Expect: 100-continue ----------------------------- */

const DEFERRED_CONTINUE: unique symbol = Symbol('actor-ts.deferred-continue');

/** A request whose `100 Continue` is held back until its body is first read. */
type ContinueAwaitingRequest = { [DEFERRED_CONTINUE]?: { writeContinue(): void } };

/** The slice of a `node:http` / `node:http2` server {@link deferContinueUntilBodyRead} drives. */
export type ContinueServer = {
  on(event: 'checkContinue', listener: (request: object, response: { writeContinue(): void }) => void): unknown;
  emit(event: 'request', request: object, response: object): boolean;
  listenerCount(event: string): number;
};

/**
 * Hold back `100 Continue` until something reads the request body (#1868).
 *
 * Without a `'checkContinue'` listener, Node and Bun answer
 * `Expect: 100-continue` before any handler runs, so a client that asked
 * whether to send its body is always told yes — even by a route about to
 * refuse it for a bad token.  With this listener the request goes on to the
 * handler with the interim response pending: the first read of a streamed
 * body sends it ({@link limitedRequestBody}'s `onFirstPull`), so does every
 * buffered read ({@link sendDeferredContinue} in front of it), and a handler
 * that answers without reading never sends it at all — the client then never
 * sends the body.  Deno's `node:http` never sends one on its own, so there
 * this is also what makes a waiting client send its body promptly.
 *
 * Left alone when the server already has a listener: that one is the
 * application's, and it decides.
 */
export function deferContinueUntilBodyRead(server: ContinueServer | undefined): void {
  if (server === undefined || typeof server.on !== 'function' || server.listenerCount('checkContinue') > 0) return;
  server.on('checkContinue', (request, response) => {
    (request as ContinueAwaitingRequest)[DEFERRED_CONTINUE] = response;
    server.emit('request', request, response);
  });
}

/** Send the `100 Continue` {@link deferContinueUntilBodyRead} held back for `request`, if any — once. */
export function sendDeferredContinue(request: object): void {
  const awaiting = request as ContinueAwaitingRequest;
  const response = awaiting[DEFERRED_CONTINUE];
  if (response === undefined) return;
  delete awaiting[DEFERRED_CONTINUE];
  try {
    response.writeContinue();
  } catch {
    /* the response is already under way or gone — nothing left to tell the client */
  }
}
