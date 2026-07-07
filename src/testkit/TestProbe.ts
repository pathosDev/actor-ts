import { ActorPath } from '../ActorPath.js';
import { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import type { TestProbeOptions, TestProbeOptionsType } from './TestProbeOptions.js';

interface Pending {
  readonly message: unknown;
  readonly sender: ActorRef | null;
}

let probeCounter = 0;

/**
 * A lightweight ActorRef that captures every `tell` for inspection by tests.
 * Unlike an ordinary actor it is synchronous and not driven by the dispatcher —
 * messages sit in an internal queue until a test asserts on them.
 */
export class TestProbe extends ActorRef<unknown> {
  readonly path: ActorPath;

  private readonly queue: Pending[] = [];
  /** Parked resolvers when a caller is waiting for the next message. */
  private readonly waiters: Array<{
    resolve(env: Pending): void;
    reject(err: Error): void;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];

  private readonly defaultTimeoutMs: number;
  private _lastSender: ActorRef | null = null;

  constructor(
    private readonly system: ActorSystem,
    options: TestProbeOptions = {},
  ) {
    super();
    const opts = (options as Partial<TestProbeOptionsType>);
    const n = opts.name ?? `test-probe-${++probeCounter}`;
    this.path = new ActorPath('', null, system.name).child(n);
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 3_000;
  }

  tell(message: unknown, sender: ActorRef | null = null): void {
    const env: Pending = { message, sender };
    // Hand off to a parked waiter if one is present — otherwise buffer.
    const w = this.waiters.shift();
    if (w) {
      if (w.timer) clearTimeout(w.timer);
      w.resolve(env);
    } else {
      this.queue.push(env);
    }
  }

  /** Number of messages currently buffered. */
  get messageCount(): number { return this.queue.length; }

  /** True when there is at least one buffered message waiting to be consumed. */
  hasMessage(): boolean { return this.queue.length > 0; }

  /** The sender of the LAST message consumed via expect* / receive*. */
  get sender(): ActorRef | null { return this._lastSender; }

  /** Convenience: reply to the last sender (throws if there is none). */
  reply(message: unknown): void {
    if (!this._lastSender) throw new Error('TestProbe.reply(): no sender recorded');
    this._lastSender.tell(message as never, this);
  }

  /** Clear all buffered messages — handy between test phases. */
  clearInbox(): void { this.queue.length = 0; }

  /* ----------------------------- Expectations ---------------------------- */

  /** Wait for the next message and return it.  Throws on timeout. */
  async receiveOne(timeoutMs?: number): Promise<unknown> {
    return (await this._next(timeoutMs)).message;
  }

  /** Receive the next `n` messages. */
  async receiveN(n: number, timeoutMs?: number): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push(await this.receiveOne(timeoutMs));
    return out;
  }

  /** Assert the next message deep-equals `expected`. */
  async expectMsg<T>(expected: T, timeoutMs?: number): Promise<T> {
    const got = await this.receiveOne(timeoutMs);
    if (!deepEqual(got, expected)) {
      throw new Error(`expectMsg: expected ${stringify(expected)} but got ${stringify(got)}`);
    }
    return got as T;
  }

  /** Assert the next message is an instance of `Class`. */
  async expectMsgType<T>(
    Class: new (...args: any[]) => T,
    timeoutMs?: number,
  ): Promise<T> {
    const got = await this.receiveOne(timeoutMs);
    if (!(got instanceof Class)) {
      throw new Error(`expectMsgType: expected instance of ${Class.name} but got ${stringify(got)}`);
    }
    return got;
  }

  /** Assert NO message arrives within the timeout. */
  async expectNoMessage(timeoutMs: number = 300): Promise<void> {
    if (this.queue.length > 0) {
      throw new Error(`expectNoMessage: queue contains ${stringify(this.queue[0]!.message)}`);
    }
    // Wait silently — if something arrives, the next `receiveOne` call would
    // pick it up. We implement by parking a waiter that we cancel after the
    // window elapses.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove our entry from waiters before resolving.
        const idx = this.waiters.indexOf(entry);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve();
      }, timeoutMs);
      const entry = {
        resolve: (env: Pending) => {
          clearTimeout(timer);
          reject(new Error(`expectNoMessage: received ${stringify(env.message)}`));
        },
        reject: (err: Error) => { clearTimeout(timer); reject(err); },
        timer: null as unknown as ReturnType<typeof setTimeout>,
      };
      this.waiters.push(entry);
    });
  }

  /** Receive messages until `pred` returns true.  Other messages are discarded. */
  async fishForMessage<T>(
    pred: (m: unknown) => boolean,
    timeoutMs: number = this.defaultTimeoutMs,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = Math.max(0, deadline - Date.now());
      const msg = await this.receiveOne(remaining || 1);
      if (pred(msg)) return msg as T;
    }
  }

  /* ------------------------------ Internal ------------------------------- */

  private _next(timeoutMs?: number): Promise<Pending> {
    const t = timeoutMs ?? this.defaultTimeoutMs;
    // Use already-buffered message if any.
    const buffered = this.queue.shift();
    if (buffered) { this._lastSender = buffered.sender; return Promise.resolve(buffered); }

    return new Promise<Pending>((resolve, reject) => {
      const entry = {
        resolve: (env: Pending) => {
          this._lastSender = env.sender;
          resolve(env);
        },
        reject,
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      if (t > 0 && Number.isFinite(t)) {
        entry.timer = setTimeout(() => {
          const idx = this.waiters.indexOf(entry);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error(`TestProbe timeout after ${t}ms`));
        }, t);
      }
      this.waiters.push(entry);
    });
  }

  /** @internal — used by TestKit for diagnostics. */
  _snapshot(): ReadonlyArray<Pending> { return this.queue.slice(); }
}

/* ------------------------------- Utilities ------------------------------- */

function stringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const ar = a as unknown[], br = b as unknown[];
    if (ar.length !== br.length) return false;
    for (let i = 0; i < ar.length; i++) if (!deepEqual(ar[i], br[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const keysA = Object.keys(ao), keysB = Object.keys(bo);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) if (!deepEqual(ao[k], bo[k])) return false;
  return true;
}
