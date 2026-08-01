/**
 * The `mailboxes` stream (#204) — periodic top-N mailbox depths.
 *
 * Sampling rather than eventing: a mailbox's depth changes on every
 * enqueue and dequeue, which is the hottest path in the framework.  An
 * event per change would cost more than the actors being measured; a
 * depth *at an instant* is also exactly what the "which actors are
 * falling behind?" question wants.
 *
 * The sampler idles while nothing is subscribed, so an open dashboard
 * on another panel costs the system nothing.
 */
import type { ActorSystem } from '../../ActorSystem.js';
import type { Cancellable } from '../../Scheduler.js';
import {
  mailboxSamplePayload,
  type DevToolsStreamId,
  type DevToolsStreamPayload,
  type MailboxDepthEntry,
} from '../protocol/index.js';
import type { DevToolsTap } from '../DevToolsServer.js';

export class MailboxSamplerTap implements DevToolsTap {
  readonly stream: DevToolsStreamId = 'mailboxes';

  private emit: ((payload: DevToolsStreamPayload) => void) | null = null;
  private ticker: Cancellable | null = null;

  constructor(
    private readonly system: ActorSystem,
    private readonly intervalMs: number,
    private readonly limit: number,
  ) {}

  install(emit: (payload: DevToolsStreamPayload) => void): void {
    this.emit = emit;
  }

  uninstall(): void {
    this.stopTicking();
    this.emit = null;
  }

  snapshot(): ReadonlyArray<DevToolsStreamPayload> {
    return [this.sample()];
  }

  subscribersChanged(count: number): void {
    if (count > 0) this.startTicking();
    else this.stopTicking();
  }

  private startTicking(): void {
    if (this.ticker !== null) return;
    this.ticker = this.system.scheduler.scheduleAtFixedRateFunction(
      this.intervalMs,
      this.intervalMs,
      () => this.emit?.(this.sample()),
    );
  }

  private stopTicking(): void {
    this.ticker?.cancel();
    this.ticker = null;
  }

  private sample(): DevToolsStreamPayload {
    const tree = this.system._inspectTree();
    const entries: MailboxDepthEntry[] = tree
      .map((cell) => ({
        path: cell.path,
        size: cell.mailboxSize,
        stashSize: cell.stashSize,
        suspended: cell.suspended,
      }))
      // Deepest first, and drop the idle majority: a list of a thousand
      // zeroes is noise, and the panel only ever renders the head.
      .filter((entry) => entry.size > 0 || entry.stashSize > 0 || entry.suspended)
      .sort((a, b) => b.size - a.size)
      .slice(0, this.limit);
    return mailboxSamplePayload(Date.now(), entries, tree.length);
  }
}
