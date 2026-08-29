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
    const context = LogContext.get();
    // The tracer comes off the system field rather than `tracerOf`, which
    // walks the extension chain, and `null` here means nothing can be active
    // — so the ordinary send resolves both fields without a lookup (#411).
    const tracer = this.cell.system._tracer;
    const span = tracer === null ? null : tracer.activeSpan();
    const env: import('./Mailbox.js').Envelope<TMessage> = { message, sender };
    if (!LogContext.isEmpty(context)) (env as { context?: typeof context }).context = context;
    if (span) (env as { trace?: ReturnType<typeof span.context> }).trace = span.context();
    this.cell.postUserEnvelope(env);
  }

  /** @internal */
  getCell(): ActorCell<TMessage> {
    return this.cell;
  }
}
