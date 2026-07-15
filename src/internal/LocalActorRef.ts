import { ActorRef } from '../ActorRef.js';
import type { ActorPath } from '../ActorPath.js';
import { LogContext } from '../LogContext.js';
import { tracerOf } from '../tracing/TracingExtension.js';
import type { ActorCell } from './ActorCell.js';

/**
 * Reference to a locally-hosted actor.  Sends go through the cell which owns
 * the mailbox and lifecycle.  The cell is exposed internally via getCell()
 * so that supervision / death-watch can wire things up without public API.
 */
export class LocalActorRef<TMessage = unknown> extends ActorRef<TMessage> {
  readonly path: ActorPath;

  constructor(private readonly cell: ActorCell<TMessage>) {
    super();
    this.path = cell.path;
  }

  tell(message: TMessage, sender: ActorRef | null = null): void {
    // Snapshot caller's MDC + active span context at tell-time so the
    // receiver's handler runs with the same diagnostic context and
    // its child span links back to ours (#53, #10).  Both fields are
    // omitted from the envelope when their respective extensions are
    // not enabled, keeping the no-instrumentation hot path lean.
    const ctx = LogContext.get();
    const tracer = tracerOf(this.cell.system);
    const span = tracer.activeSpan();
    const env: import('./Mailbox.js').Envelope<TMessage> = { message, sender };
    if (Object.keys(ctx).length > 0) (env as { context?: typeof ctx }).context = ctx;
    if (span) (env as { trace?: ReturnType<typeof span.context> }).trace = span.context();
    this.cell.postUserEnvelope(env);
  }

  /** @internal */
  getCell(): ActorCell<TMessage> {
    return this.cell;
  }
}
