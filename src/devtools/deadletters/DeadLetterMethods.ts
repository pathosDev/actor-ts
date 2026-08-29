/**
 * The dead-letter inspector (#553) — what the system failed to deliver.
 *
 * Request/response rather than a stream, for the reason the explain plan
 * is one: the queue is a bounded ring the system already keeps, so asking
 * for it costs one request per poll, while pushing every capture would put
 * DevTools on the delivery path of the very failures it is watching.
 *
 * The panel reports the queue's own `store` setting rather than quietly
 * showing an empty table.  A queue left `off` captures nothing, and
 * "nothing is broken" and "nothing is being recorded" are opposite answers
 * that an empty table gives identically.
 */
import type { ActorSystem } from '../../ActorSystem.js';
import type { DeadLetterEntry } from '../../deadletters/DeadLetterEntry.js';
import { toWireValue } from '../internal/WireSerializer.js';
import {
  DEAD_LETTER_ROWS,
  deadLetterView,
  type DeadLettersParameters,
  type DeadLettersResult,
} from '../protocol/index.js';
import type { DevToolsServer } from '../DevToolsServer.js';

/** Wires `deadletters.list` onto the server. */
export class DeadLetterMethods {
  constructor(private readonly system: ActorSystem) {}

  /** Register the method on `server`. */
  install(server: DevToolsServer): void {
    server.registerMethod('deadletters.list', (parameters) => this.onList(parameters));
  }

  /** True when the queue is actually recording — the panel's precondition. */
  get recording(): boolean {
    return this.system.deadLetterQueue.store !== 'off';
  }

  private async onList(parameters: unknown): Promise<DeadLettersResult> {
    const request = parameters as DeadLettersParameters | undefined;
    const recipient = this.qualify(request?.recipient);
    const limit = clampLimit(request?.limit);
    const queue = this.system.deadLetterQueue;

    // Two reads, because `total` must count what the filter selects and
    // not what the page shows — a panel saying "200 of 200" while the
    // queue holds a thousand is worse than saying nothing.
    const selected = await queue.list(recipient === undefined ? {} : { recipient });
    return {
      entries: selected.slice(0, limit).map(toView),
      total: selected.length,
      capacity: queue.capacity,
    };
  }

  /**
   * Accept the path an operator actually types.
   *
   * The queue records fully-qualified paths (`actor-ts://<system>/user/x`)
   * and filters on prefix, but nobody types the scheme and the system name
   * into a filter box — and a filter that silently matches nothing is worse
   * than no filter at all.  A bare `/user/orders` is qualified here.
   */
  private qualify(recipient: unknown): string | undefined {
    if (recipient === undefined || recipient === '') return undefined;
    if (typeof recipient !== 'string') {
      throw new Error('`recipient` must be an actor path');
    }
    if (recipient.includes('://')) return recipient;
    const segments = recipient.replace(/^\/+/, '').replace(/\/+$/, '');
    return `actor-ts://${this.system.name}/${segments}`;
  }
}

/** Flatten one entry, sanitising the payload for the wire. */
function toView(entry: DeadLetterEntry) {
  if (entry.payload.kind === 'degraded') {
    return deadLetterView(entry, entry.payload.className, null, entry.payload.reason);
  }
  const message = entry.payload.message;
  return deadLetterView(entry, messageTypeOf(message), toWireValue(message), null);
}

/**
 * Name the message by its constructor, falling back to `typeof`.
 *
 * The type is the column an operator scans first — "which message is
 * dying" is a sharper question than "what was in it" — so it is computed
 * even when the payload itself is degraded away.
 */
function messageTypeOf(message: unknown): string {
  if (message === null) return 'null';
  if (typeof message !== 'object') return typeof message;
  const name = (message as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === 'string' && name.length > 0 ? name : 'Object';
}

function clampLimit(limit: unknown): number {
  if (limit === undefined) return DEAD_LETTER_ROWS;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new Error('`limit` must be an integer >= 1');
  }
  return Math.min(limit, DEAD_LETTER_ROWS);
}
