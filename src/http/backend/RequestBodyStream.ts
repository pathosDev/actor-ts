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
import { STREAMED_BODY_DRAIN_LIMIT_BYTES } from '../Constants.js';
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

/** A {@link RequestBodySource} over a web `ReadableStream` body — Hono under Bun and Deno. */
export function webRequestBodySource(stream: ReadableStream<Uint8Array>): RequestBodySource {
  const reader = stream.getReader();
  let stopped = false;
  return {
    read: async () => {
      if (stopped) return null;
      try {
        const { done, value } = await reader.read();
        return done ? null : value ?? new Uint8Array(0);
      } catch (err) {
        throw new RequestBodyAbortedError(err);
      }
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      reader.cancel().catch(() => undefined);
    },
  };
}

/** A chunk a `node:http` request yields — a `Buffer`, or a string under `setEncoding` — as bytes. */
function asBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return new TextEncoder().encode(String(chunk));
}
