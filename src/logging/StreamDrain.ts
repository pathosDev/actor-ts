import type { TcpSocketLike } from '../runtime/tcp/TcpBackend.js';
import { SinkDeliveryError } from './BatchingSink.js';
import { SINK_STREAM_DRAIN_TIMEOUT_MS } from './Constants.js';

/** The one write a {@link StreamDrain} is holding the batch on. */
type DrainWait = {
  readonly socket: TcpSocketLike;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

/**
 * The write half of a log sink's stream connection — GELF over TCP, syslog
 * over TCP or TLS — that honours the socket's back-pressure (#1827).
 *
 * Both sinks wrote every record of a batch whatever the socket answered, so a
 * collector that stopped reading grew this process's heap by whatever the
 * batches held, without bound: the adapters keep every byte since #931 and
 * only say, with `false`, that they are holding more than they should.  Here
 * a write that answers `false` holds the batch until the socket's `onDrain`,
 * so at most one record waits past the socket's high-water mark and the rest
 * wait in `BatchingSink`'s queue, which is bounded and reports what it drops.
 *
 * The wait has its own bound, {@link SINK_STREAM_DRAIN_TIMEOUT_MS}: past it,
 * and on a connection that closes or fails meanwhile, the write rejects with a
 * retryable {@link SinkDeliveryError} and the caller lets the connection go,
 * so the retry dials afresh.  A wait belongs to one socket — a drain or a
 * close from a connection the sink has already replaced settles nothing.
 */
export class StreamDrain {
  private waiting: DrainWait | undefined;

  /** @param destination  How the errors name the connection, e.g. `syslog connection to host:514`. */
  constructor(private readonly destination: string) {}

  /**
   * Hand `bytes` to `socket`, and when it answers `false`, resolve only once
   * it drains.  `=== false`, as in `TcpTransport`: a socket that answers
   * nothing is one that never pushes back.
   */
  async write(socket: TcpSocketLike, bytes: Uint8Array): Promise<void> {
    if (socket.write(bytes) !== false) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(socket)?.reject(new SinkDeliveryError(
          `${this.destination} took nothing for ${SINK_STREAM_DRAIN_TIMEOUT_MS} ms after pushing back`,
          true,
        ));
      }, SINK_STREAM_DRAIN_TIMEOUT_MS);
      this.waiting = {
        socket,
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
    });
  }

  /** `socket` can take more: the write waiting on it resolves. */
  drained(socket: TcpSocketLike): void {
    this.settle(socket)?.resolve();
  }

  /** `socket` is gone: the write waiting on it fails, retryably. */
  lost(socket: TcpSocketLike, how: string): void {
    this.settle(socket)?.reject(new SinkDeliveryError(`${this.destination} ${how} while it was pushing back`, true));
  }

  /** Take the wait on `socket`, if there is one, so it is settled exactly once. */
  private settle(socket: TcpSocketLike): DrainWait | undefined {
    const waiting = this.waiting;
    if (waiting === undefined || waiting.socket !== socket) return undefined;
    this.waiting = undefined;
    return waiting;
  }
}

/**
 * Let a stream connection go for good — after a stall or a loss — so nothing
 * it still holds is written later.  `destroy` where the runtime has it: the
 * point is to stop paying for a backlog nobody reads, which a FIN does not.
 */
export function abandonStreamSocket(socket: TcpSocketLike): void {
  try {
    if (socket.destroy !== undefined) socket.destroy();
    else socket.end();
  } catch { /* already gone */ }
}
