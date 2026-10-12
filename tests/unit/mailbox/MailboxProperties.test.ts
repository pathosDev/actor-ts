import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { match, P } from 'ts-pattern';
import { Mailbox, type Envelope, type MailboxDropReason } from '../../../src/internal/Mailbox.js';
import { BoundedMailbox } from '../../../src/mailbox/BoundedMailbox.js';
import { ControlAwareMailbox } from '../../../src/mailbox/ControlAwareMailbox.js';
import { PriorityMailbox } from '../../../src/mailbox/PriorityMailbox.js';
import type { BoundedMailboxOverflow } from '../../../src/mailbox/BoundedMailboxOptions.js';
import type { PriorityMailboxOverflow } from '../../../src/mailbox/PriorityMailboxOptions.js';

/**
 * Model test for every mailbox shape (#408, #647, #1431).
 *
 * The reference is the mailbox as it was written before the ring buffer:
 * plain arrays, `push` / `shift` / `unshift`.  That is deliberate — the claim
 * a ring has to earn is "indistinguishable from the array queue it replaced",
 * and the most direct way to state it is to keep the array queue around and
 * demand agreement on every observable after every step.
 *
 * The same driver covers the bounded and priority variants, so the overflow
 * policies and the priority ordering are checked against an independent
 * implementation too — the priority reference re-sorts on every insert rather
 * than binary-searching, so an off-by-one in the real one's search bounds
 * cannot hide in a shared mistake.
 *
 * `removeOldest` is `protected`, so each real mailbox is reached through a
 * one-method subclass.  That is also the seam a custom mailbox sees, so
 * exercising it here is not only convenience.
 *
 * The control-aware mailbox walks the same operations plus three of its own —
 * the exempt `enqueueSignal` door, a replayed signal, and a dequeue-then-
 * prepend re-park — against a reference of two arrays, one per class.  Those
 * stay out of the shared walk on purpose: an undroppable envelope is admitted
 * past the bound, so the absolute `size <= capacity` walks at the bottom of
 * the file could not hold over them.
 */

/* ------------------------------- the shape ------------------------------- */

/** What the driver needs from both sides — the mailbox surface, plus the `protected` eviction. */
interface MailboxUnderTest {
  enqueue(envelope: Envelope<number>): void;
  prependUser(envelopes: Array<Envelope<number>>): void;
  enqueueSystem(envelope: Envelope<unknown>): void;
  dequeueUser(): Envelope<number> | undefined;
  dequeueSystem(): Envelope<unknown> | undefined;
  /** `removeOldest`, made reachable — see the file comment. */
  evictOldest(): Envelope<number> | undefined;
  drainUser(): Envelope<number>[];
  drainSystem(): Envelope<unknown>[];
  hasMessages(): boolean;
  hasUserMessages(): boolean;
  hasSystemMessages(): boolean;
  suspend(): void;
  resume(): void;
  readonly size: number;
  readonly suspended: boolean;
  readonly droppedCount?: number;
}

/* ---------------------------- the array models ---------------------------- */

/** The base `Mailbox` exactly as it read before #408: two arrays and `shift()`. */
class ArrayMailboxModel implements MailboxUnderTest {
  protected userQueue: Envelope<number>[] = [];
  private systemQueue: Envelope<unknown>[] = [];
  private isSuspended = false;

  get suspended(): boolean { return this.isSuspended; }
  get size(): number { return this.userQueue.length; }

  enqueue(envelope: Envelope<number>): void { this.userQueue.push(envelope); }
  prependUser(envelopes: Array<Envelope<number>>): void { this.userQueue.unshift(...envelopes); }
  enqueueSystem(envelope: Envelope<unknown>): void { this.systemQueue.push(envelope); }
  dequeueUser(): Envelope<number> | undefined {
    return this.isSuspended ? undefined : this.userQueue.shift();
  }
  evictOldest(): Envelope<number> | undefined { return this.userQueue.shift(); }
  dequeueSystem(): Envelope<unknown> | undefined { return this.systemQueue.shift(); }
  hasMessages(): boolean {
    return this.systemQueue.length > 0 || (!this.isSuspended && this.userQueue.length > 0);
  }
  hasUserMessages(): boolean { return this.userQueue.length > 0; }
  hasSystemMessages(): boolean { return this.systemQueue.length > 0; }
  suspend(): void { this.isSuspended = true; }
  resume(): void { this.isSuspended = false; }
  drainUser(): Envelope<number>[] {
    const drained = this.userQueue;
    this.userQueue = [];
    return drained;
  }
  drainSystem(): Envelope<unknown>[] {
    const drained = this.systemQueue;
    this.systemQueue = [];
    return drained;
  }
}

class ArrayBoundedMailboxModel extends ArrayMailboxModel {
  droppedCount = 0;

  constructor(
    private readonly capacity: number,
    private readonly overflow: BoundedMailboxOverflow,
    private readonly onDrop: (reason: MailboxDropReason) => void,
  ) {
    super();
  }

  override enqueue(envelope: Envelope<number>): void {
    if (this.size >= this.capacity) {
      if (this.overflow === 'reject') throw new Error('mailbox full');
      if (this.overflow === 'drop-head') {
        const evicted = super.evictOldest();
        if (evicted !== undefined) this.recordDrop('drop-head');
        super.enqueue(envelope);
        return;
      }
      this.recordDrop('drop-new');
      return;
    }
    super.enqueue(envelope);
  }

  /**
   * The replay path, bounded (#772).  An arrival lands at the tail and
   * `drop-head` makes room at the head; a replay lands at the head and makes
   * room at the tail.  `reject` refuses the batch whole rather than admitting
   * part of it, so the model has to decide before it mutates anything.
   */
  override prependUser(envelopes: Array<Envelope<number>>): void {
    if (envelopes.length === 0) return;
    const droppable = envelopes.filter((envelope) => envelope.undroppable !== true).length;
    if (this.overflow === 'reject') {
      if (droppable > Math.max(0, this.capacity - this.size)) throw new Error('mailbox full');
      super.prependUser(envelopes);
      return;
    }
    const admitted: Envelope<number>[] = [];
    for (const envelope of envelopes) {
      if (envelope.undroppable === true || this.size + admitted.length < this.capacity) {
        admitted.push(envelope);
        continue;
      }
      const evicted = this.overflow === 'drop-head' ? this.evictNewest() : undefined;
      if (evicted === undefined) {
        this.recordDrop('drop-new');
        continue;
      }
      this.recordDrop('drop-head');
      admitted.push(envelope);
    }
    super.prependUser(admitted);
  }

  /** The newest queued message that may be dropped — the mirror of `evictOldest`. */
  private evictNewest(): Envelope<number> | undefined {
    for (let index = this.userQueue.length - 1; index >= 0; index--) {
      if (this.userQueue[index]!.undroppable !== true) return this.userQueue.splice(index, 1)[0];
    }
    return undefined;
  }

  private recordDrop(reason: MailboxDropReason): void {
    this.droppedCount++;
    this.onDrop(reason);
  }
}

type ModelEntry = {
  readonly envelope: Envelope<number>;
  readonly priority: number;
  readonly sequence: number;
};

/**
 * The reference normalisation for a priority the callback could not produce
 * (#733), written out here rather than shared with the implementation — a
 * reference that imported the rule it is checking would agree by
 * construction.
 *
 * `MAX_SAFE_INTEGER` and not `Infinity` for the reason the implementation
 * gives: the sort below is `a.priority - b.priority || …`, and
 * `Infinity - Infinity` is `NaN`, which is falsy, so a pair of sentinels
 * would fall through to the tie-break by accident rather than by rule.
 */
const UNRANKABLE_PRIORITY = Number.MAX_SAFE_INTEGER;

const rankOf = (priorityFor: (message: number) => number, message: number): number => {
  let raw: number;
  try { raw = priorityFor(message); } catch { return UNRANKABLE_PRIORITY; }
  return typeof raw === 'number' && !Number.isNaN(raw) ? raw : UNRANKABLE_PRIORITY;
};

/**
 * The priority mailbox, modelled by re-sorting on every insert instead of
 * binary-searching an already-ordered array.  Slow and obviously correct,
 * which is what a reference is for.
 */
class ArrayPriorityMailboxModel extends ArrayMailboxModel {
  droppedCount = 0;
  private sequence = 0;
  private entries: ModelEntry[] = [];

  constructor(
    private readonly priorityFor: (message: number) => number,
    private readonly capacity: number | undefined,
    private readonly overflow: PriorityMailboxOverflow,
    private readonly onDrop: (reason: MailboxDropReason) => void,
  ) {
    super();
  }

  override get size(): number { return this.entries.length; }

  override enqueue(envelope: Envelope<number>): void {
    if (this.capacity !== undefined && this.entries.length >= this.capacity) {
      if (this.overflow === 'reject') throw new Error('mailbox full');
      if (this.overflow === 'drop-new') {
        this.recordDrop('drop-new');
        return;
      }
      this.insert(envelope);
      const shed = this.entries.pop()!;
      this.recordDrop(shed.envelope === envelope ? 'drop-new' : 'drop-head');
      return;
    }
    this.insert(envelope);
  }

  override prependUser(envelopes: Array<Envelope<number>>): void {
    for (const envelope of envelopes) this.enqueue(envelope);
  }

  override dequeueUser(): Envelope<number> | undefined {
    if (this.suspended) return undefined;
    return this.entries.shift()?.envelope;
  }

  override evictOldest(): Envelope<number> | undefined { return this.entries.pop()?.envelope; }

  override hasUserMessages(): boolean { return this.entries.length > 0; }

  override hasMessages(): boolean {
    return this.hasSystemMessages() || (!this.suspended && this.entries.length > 0);
  }

  override drainUser(): Envelope<number>[] {
    const drained = this.entries.map((entry) => entry.envelope);
    this.entries = [];
    return drained;
  }

  private insert(envelope: Envelope<number>): void {
    this.entries.push({
      envelope,
      priority: rankOf(this.priorityFor, envelope.message),
      sequence: this.sequence++,
    });
    this.entries.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
  }

  private recordDrop(reason: MailboxDropReason): void {
    this.droppedCount++;
    this.onDrop(reason);
  }
}

/** The mailbox surface plus the exempt door — what the control-aware walk drives. */
interface SignalingMailboxUnderTest extends MailboxUnderTest {
  enqueueSignal(envelope: Envelope<number>): void;
}

/**
 * The control-aware mailbox as two plain arrays, one per class (#1431).
 *
 * Independent of the implementation where it matters: `shift` / `unshift` /
 * `splice` instead of a ring and the inherited base eviction, the
 * predicate's containment restated rather than imported, and the batch split
 * by two filters rather than by the single pass the real one makes.  The
 * ordinary class reuses the base model's `userQueue`, because that is exactly
 * what the real one does with the base mailbox's queue.
 */
class ArrayControlAwareMailboxModel extends ArrayMailboxModel implements SignalingMailboxUnderTest {
  droppedCount = 0;
  private controlQueue: Envelope<number>[] = [];

  constructor(
    private readonly isControl: (message: number) => boolean,
    private readonly capacity: number | undefined,
    private readonly overflow: BoundedMailboxOverflow,
    private readonly onDrop: (reason: MailboxDropReason) => void,
  ) {
    super();
  }

  override get size(): number { return this.controlQueue.length + this.userQueue.length; }

  override enqueue(envelope: Envelope<number>): void {
    if (this.classesAsControl(envelope.message)) {
      this.controlQueue.push(envelope);
      return;
    }
    if (this.capacity !== undefined && this.userQueue.length >= this.capacity) {
      if (this.overflow === 'reject') throw new Error('mailbox full');
      if (this.overflow === 'drop-new') {
        this.recordDrop('drop-new');
        return;
      }
      if (this.evictOldest() !== undefined) this.recordDrop('drop-head');
    }
    this.userQueue.push(envelope);
  }

  /** Past the bound in either class; position by class. */
  enqueueSignal(envelope: Envelope<number>): void {
    if (this.classesAsControl(envelope.message)) this.controlQueue.push(envelope);
    else this.userQueue.push(envelope);
  }

  /**
   * Control to the head of the control class, unbounded; ordinary to the head
   * of the ordinary class under the bounded model's replay rules (#772) —
   * with `reject` decided before either class moves.
   */
  override prependUser(envelopes: Array<Envelope<number>>): void {
    const control = envelopes.filter((envelope) => this.classesAsControl(envelope.message));
    const ordinary = envelopes.filter((envelope) => !this.classesAsControl(envelope.message));
    const admitted = this.admitOrdinaryReplay(ordinary);
    this.controlQueue.unshift(...control);
    this.userQueue.unshift(...admitted);
  }

  override dequeueUser(): Envelope<number> | undefined {
    if (this.suspended) return undefined;
    return this.controlQueue.shift() ?? this.userQueue.shift();
  }

  /** What the real one inherits: the oldest droppable *ordinary* message. */
  override evictOldest(): Envelope<number> | undefined {
    const index = this.userQueue.findIndex((envelope) => envelope.undroppable !== true);
    return index === -1 ? undefined : this.userQueue.splice(index, 1)[0];
  }

  override hasUserMessages(): boolean {
    return this.controlQueue.length > 0 || this.userQueue.length > 0;
  }

  override hasMessages(): boolean {
    return this.hasSystemMessages() || (!this.suspended && this.hasUserMessages());
  }

  override drainUser(): Envelope<number>[] {
    const drained = [...this.controlQueue, ...this.userQueue];
    this.controlQueue = [];
    this.userQueue = [];
    return drained;
  }

  private admitOrdinaryReplay(envelopes: Envelope<number>[]): Envelope<number>[] {
    const capacity = this.capacity;
    if (capacity === undefined) return envelopes;
    if (this.overflow === 'reject') {
      const droppable = envelopes.filter((envelope) => envelope.undroppable !== true).length;
      if (droppable > Math.max(0, capacity - this.userQueue.length)) throw new Error('mailbox full');
      return envelopes;
    }
    const admitted: Envelope<number>[] = [];
    for (const envelope of envelopes) {
      if (envelope.undroppable === true || this.userQueue.length + admitted.length < capacity) {
        admitted.push(envelope);
        continue;
      }
      const evicted = this.overflow === 'drop-head' ? this.evictNewest() : undefined;
      if (evicted === undefined) {
        this.recordDrop('drop-new');
        continue;
      }
      this.recordDrop('drop-head');
      admitted.push(envelope);
    }
    return admitted;
  }

  private evictNewest(): Envelope<number> | undefined {
    for (let index = this.userQueue.length - 1; index >= 0; index--) {
      if (this.userQueue[index]!.undroppable !== true) return this.userQueue.splice(index, 1)[0];
    }
    return undefined;
  }

  private classesAsControl(message: number): boolean {
    try {
      return this.isControl(message) === true;
    } catch {
      return false;
    }
  }

  private recordDrop(reason: MailboxDropReason): void {
    this.droppedCount++;
    this.onDrop(reason);
  }
}

/* --------------------- the real mailboxes, reachable --------------------- */

class ProbeMailbox extends Mailbox<number> implements MailboxUnderTest {
  evictOldest(): Envelope<number> | undefined { return this.removeOldest(); }
}
class ProbeBoundedMailbox extends BoundedMailbox<number> implements MailboxUnderTest {
  evictOldest(): Envelope<number> | undefined { return this.removeOldest(); }
}
class ProbePriorityMailbox extends PriorityMailbox<number> implements MailboxUnderTest {
  evictOldest(): Envelope<number> | undefined { return this.removeOldest(); }
}
class ProbeControlAwareMailbox extends ControlAwareMailbox<number> implements SignalingMailboxUnderTest {
  evictOldest(): Envelope<number> | undefined { return this.removeOldest(); }
}

/* ------------------------------- operations ------------------------------- */

type EnqueueOperation = { readonly kind: 'enqueue'; readonly message: number };
type PrependUserOperation = { readonly kind: 'prependUser'; readonly messages: ReadonlyArray<number> };
type EnqueueSystemOperation = { readonly kind: 'enqueueSystem'; readonly message: number };
type DequeueUserOperation = { readonly kind: 'dequeueUser' };
type DequeueSystemOperation = { readonly kind: 'dequeueSystem' };
type EvictOldestOperation = { readonly kind: 'evictOldest' };
type DrainUserOperation = { readonly kind: 'drainUser' };
type DrainSystemOperation = { readonly kind: 'drainSystem' };
type SuspendOperation = { readonly kind: 'suspend' };
type ResumeOperation = { readonly kind: 'resume' };

type MailboxOperation =
  | EnqueueOperation
  | PrependUserOperation
  | EnqueueSystemOperation
  | DequeueUserOperation
  | DequeueSystemOperation
  | EvictOldestOperation
  | DrainUserOperation
  | DrainSystemOperation
  | SuspendOperation
  | ResumeOperation;

/** The mailbox under test and the array model it must agree with, step for step. */
type MailboxPair = {
  readonly mailbox: MailboxUnderTest;
  readonly reference: MailboxUnderTest;
};

const envelopeOf = (message: number): Envelope<number> => ({ message, sender: null });

/**
 * Run `action` on both sides and require the same outcome, thrown or not.
 *
 * `reject` is a policy the model has to reproduce as well, and "both threw"
 * is the only comparison that makes sense once one of them has.
 */
function bothAgree<R>(left: () => R, right: () => R, compare: (a: R, b: R) => void): void {
  let leftValue: R | undefined;
  let leftThrew = false;
  try { leftValue = left(); } catch { leftThrew = true; }
  let rightValue: R | undefined;
  let rightThrew = false;
  try { rightValue = right(); } catch { rightThrew = true; }
  expect(leftThrew).toBe(rightThrew);
  if (!leftThrew) compare(leftValue as R, rightValue as R);
}

const messagesOf = (envelopes: ReadonlyArray<Envelope<unknown>>): unknown[] =>
  envelopes.map((envelope) => envelope.message);

function onEnqueue(pair: MailboxPair, operation: EnqueueOperation): void {
  // The same envelope object on both sides, so identity-sensitive behaviour
  // (`drop-lowest-priority` deciding whether it shed the arrival) is
  // comparable and not merely equal.
  const envelope = envelopeOf(operation.message);
  bothAgree(
    () => pair.mailbox.enqueue(envelope),
    () => pair.reference.enqueue(envelope),
    () => {},
  );
}

function onPrependUser(pair: MailboxPair, operation: PrependUserOperation): void {
  const envelopes = operation.messages.map(envelopeOf);
  bothAgree(
    () => pair.mailbox.prependUser([...envelopes]),
    () => pair.reference.prependUser([...envelopes]),
    () => {},
  );
}

function onEnqueueSystem(pair: MailboxPair, operation: EnqueueSystemOperation): void {
  const envelope = envelopeOf(operation.message);
  pair.mailbox.enqueueSystem(envelope);
  pair.reference.enqueueSystem(envelope);
}

function onDequeueUser(pair: MailboxPair): void {
  expect(pair.mailbox.dequeueUser()?.message).toBe(pair.reference.dequeueUser()?.message as number);
}

function onDequeueSystem(pair: MailboxPair): void {
  expect(pair.mailbox.dequeueSystem()?.message).toBe(pair.reference.dequeueSystem()?.message as number);
}

function onEvictOldest(pair: MailboxPair): void {
  expect(pair.mailbox.evictOldest()?.message).toBe(pair.reference.evictOldest()?.message as number);
}

function onDrainUser(pair: MailboxPair): void {
  expect(messagesOf(pair.mailbox.drainUser())).toEqual(messagesOf(pair.reference.drainUser()));
}

function onDrainSystem(pair: MailboxPair): void {
  expect(messagesOf(pair.mailbox.drainSystem())).toEqual(messagesOf(pair.reference.drainSystem()));
}

function onSuspend(pair: MailboxPair): void {
  pair.mailbox.suspend();
  pair.reference.suspend();
}

function onResume(pair: MailboxPair): void {
  pair.mailbox.resume();
  pair.reference.resume();
}

function applyOperation(pair: MailboxPair, operation: MailboxOperation): void {
  match(operation)
    .with({ kind: 'enqueue' }, (o) => onEnqueue(pair, o))
    .with({ kind: 'prependUser' }, (o) => onPrependUser(pair, o))
    .with({ kind: 'enqueueSystem' }, (o) => onEnqueueSystem(pair, o))
    .with({ kind: 'dequeueUser' }, () => onDequeueUser(pair))
    .with({ kind: 'dequeueSystem' }, () => onDequeueSystem(pair))
    .with({ kind: 'evictOldest' }, () => onEvictOldest(pair))
    .with({ kind: 'drainUser' }, () => onDrainUser(pair))
    .with({ kind: 'drainSystem' }, () => onDrainSystem(pair))
    .with({ kind: 'suspend' }, () => onSuspend(pair))
    .with({ kind: 'resume' }, () => onResume(pair))
    .exhaustive();
}

function expectSameState(pair: MailboxPair): void {
  expect(pair.mailbox.size).toBe(pair.reference.size);
  expect(pair.mailbox.suspended).toBe(pair.reference.suspended);
  expect(pair.mailbox.hasMessages()).toBe(pair.reference.hasMessages());
  expect(pair.mailbox.hasUserMessages()).toBe(pair.reference.hasUserMessages());
  expect(pair.mailbox.hasSystemMessages()).toBe(pair.reference.hasSystemMessages());
  if (pair.mailbox.droppedCount !== undefined) {
    expect(pair.mailbox.droppedCount).toBe(pair.reference.droppedCount as number);
  }
}

const message = fc.integer({ min: 0, max: 40 });

const operationArbitrary = fc.oneof(
  { arbitrary: message.map((value): MailboxOperation => ({ kind: 'enqueue', message: value })), weight: 6 },
  { arbitrary: fc.constant<MailboxOperation>({ kind: 'dequeueUser' }), weight: 4 },
  {
    arbitrary: fc.array(message, { maxLength: 6 })
      .map((messages): MailboxOperation => ({ kind: 'prependUser', messages })),
    weight: 2,
  },
  { arbitrary: message.map((value): MailboxOperation => ({ kind: 'enqueueSystem', message: value })), weight: 2 },
  { arbitrary: fc.constant<MailboxOperation>({ kind: 'dequeueSystem' }), weight: 2 },
  { arbitrary: fc.constant<MailboxOperation>({ kind: 'evictOldest' }), weight: 1 },
  { arbitrary: fc.constant<MailboxOperation>({ kind: 'drainUser' }), weight: 1 },
  { arbitrary: fc.constant<MailboxOperation>({ kind: 'drainSystem' }), weight: 1 },
  { arbitrary: fc.constant<MailboxOperation>({ kind: 'suspend' }), weight: 1 },
  { arbitrary: fc.constant<MailboxOperation>({ kind: 'resume' }), weight: 1 },
);

/** Ties on purpose — the FIFO tie-break is the half of the ordering a sort can get wrong. */
const priorityFor = (value: number): number => value % 5;

/**
 * A `priorityFor` that fails the two ways real ones do (#733): it throws for
 * one residue class and answers `undefined` for another, and ranks everything
 * else.  Both are reachable without malice — the framework hands the callback
 * `PoisonPill`, and `Number(message.absentField)` is `NaN`.
 *
 * This is the only guard on the *sort-invariant* half of #733, as opposed to
 * the head-insertion half.  An unrankable entry used to break the ordering the
 * binary search assumes, so where it landed depended on the order the whole
 * batch arrived in — which a fixed sequence of enqueues can miss and a random
 * walk against a re-sorting reference cannot.
 */
const unrankablePriorityFor = (value: number): number => {
  if (value % 7 === 0) throw new Error(`cannot rank ${value}`);
  if (value % 7 === 1) return undefined as unknown as number;
  return value % 5;
};

type MailboxVariant = {
  readonly name: string;
  /** Fresh pair plus the drop-reason logs the two sides must agree on. */
  readonly create: () => {
    readonly pair: MailboxPair;
    readonly realReasons: MailboxDropReason[];
    readonly modelReasons: MailboxDropReason[];
  };
};

const boundedVariant = (overflow: BoundedMailboxOverflow): MailboxVariant['create'] => () => {
  const realReasons: MailboxDropReason[] = [];
  const modelReasons: MailboxDropReason[] = [];
  return {
    pair: {
      mailbox: new ProbeBoundedMailbox({
        capacity: 8,
        overflow,
        onDrop: (reason) => realReasons.push(reason),
      }),
      reference: new ArrayBoundedMailboxModel(8, overflow, (reason) => modelReasons.push(reason)),
    },
    realReasons,
    modelReasons,
  };
};

const priorityVariant = (
  capacity: number | undefined,
  overflow: PriorityMailboxOverflow,
  rank: (value: number) => number = priorityFor,
): MailboxVariant['create'] => () => {
  const realReasons: MailboxDropReason[] = [];
  const modelReasons: MailboxDropReason[] = [];
  return {
    pair: {
      mailbox: new ProbePriorityMailbox({
        priorityFor: rank,
        ...(capacity === undefined ? {} : { capacity, overflow }),
        onDrop: (reason) => realReasons.push(reason),
      }),
      reference: new ArrayPriorityMailboxModel(
        rank,
        capacity,
        overflow,
        (reason) => modelReasons.push(reason),
      ),
    },
    realReasons,
    modelReasons,
  };
};

const variants: ReadonlyArray<MailboxVariant> = [
  {
    name: 'Mailbox (unbounded base)',
    create: () => ({
      pair: { mailbox: new ProbeMailbox(), reference: new ArrayMailboxModel() },
      realReasons: [],
      modelReasons: [],
    }),
  },
  { name: 'BoundedMailbox drop-head', create: boundedVariant('drop-head') },
  { name: 'BoundedMailbox drop-new', create: boundedVariant('drop-new') },
  { name: 'BoundedMailbox reject', create: boundedVariant('reject') },
  { name: 'PriorityMailbox (unbounded)', create: priorityVariant(undefined, 'reject') },
  { name: 'PriorityMailbox drop-lowest-priority', create: priorityVariant(8, 'drop-lowest-priority') },
  { name: 'PriorityMailbox drop-new', create: priorityVariant(8, 'drop-new') },
  { name: 'PriorityMailbox reject', create: priorityVariant(8, 'reject') },
  {
    name: 'PriorityMailbox unrankable priorities (unbounded)',
    create: priorityVariant(undefined, 'reject', unrankablePriorityFor),
  },
  {
    name: 'PriorityMailbox unrankable priorities, drop-lowest-priority',
    create: priorityVariant(8, 'drop-lowest-priority', unrankablePriorityFor),
  },
];

describe('every mailbox variant matches an array reference model', () => {
  for (const variant of variants) {
    test(`property: ${variant.name}`, () => {
      fc.assert(
        fc.property(fc.array(operationArbitrary, { maxLength: 250 }), (operations) => {
          const { pair, realReasons, modelReasons } = variant.create();
          for (const operation of operations) {
            applyOperation(pair, operation);
            expectSameState(pair);
          }
          expect(realReasons).toEqual(modelReasons);
          // Whatever survived, in the order it would be delivered.
          expect(messagesOf(pair.mailbox.drainUser())).toEqual(messagesOf(pair.reference.drainUser()));
          expect(messagesOf(pair.mailbox.drainSystem())).toEqual(messagesOf(pair.reference.drainSystem()));
        }),
        { numRuns: 120 },
      );
    });
  }
});

/* ------------------------ the control-aware variants ----------------------- */

type EnqueueSignalOperation = { readonly kind: 'enqueueSignal'; readonly message: number };
type ReplaySignalOperation = { readonly kind: 'replaySignal'; readonly message: number };
type ReparkHeadOperation = { readonly kind: 'reparkHead' };
/** The shared walk plus the exempt door, a replayed signal and a re-park — see the file comment. */
type SignalingOperation =
  | MailboxOperation
  | EnqueueSignalOperation
  | ReplaySignalOperation
  | ReparkHeadOperation;

type SignalingMailboxPair = {
  readonly mailbox: SignalingMailboxUnderTest;
  readonly reference: SignalingMailboxUnderTest;
};

/** Built the way `ActorCell.postSignalEnvelope` builds it — the marker is the whole difference. */
const signalOf = (message: number): Envelope<number> => ({ message, sender: null, undroppable: true });

function onEnqueueSignal(pair: SignalingMailboxPair, operation: EnqueueSignalOperation): void {
  // One object on both sides, as for `enqueue`.
  const envelope = signalOf(operation.message);
  bothAgree(
    () => pair.mailbox.enqueueSignal(envelope),
    () => pair.reference.enqueueSignal(envelope),
    () => {},
  );
}

/**
 * A lifecycle notification coming back from a stash: the replay door, carrying
 * the marker, at whatever depth the walk has reached — which is usually the
 * bound, so the replay's exemption is tested where it decides something.
 */
function onReplaySignal(pair: SignalingMailboxPair, operation: ReplaySignalOperation): void {
  const envelope = signalOf(operation.message);
  bothAgree(
    () => pair.mailbox.prependUser([envelope]),
    () => pair.reference.prependUser([envelope]),
    () => {},
  );
}

/**
 * Take the next envelope and hand it straight back: the cell's throttle
 * re-park, and the shortest stash round trip.  What comes out may be an
 * undroppable envelope, which is how a replay in this walk comes to carry the
 * marker at all.
 */
function onReparkHead(pair: SignalingMailboxPair): void {
  const fromMailbox = pair.mailbox.dequeueUser();
  const fromReference = pair.reference.dequeueUser();
  expect(fromMailbox?.message).toBe(fromReference?.message as number);
  bothAgree(
    () => { if (fromMailbox !== undefined) pair.mailbox.prependUser([fromMailbox]); },
    () => { if (fromReference !== undefined) pair.reference.prependUser([fromReference]); },
    () => {},
  );
}

function onMailboxOperation(pair: SignalingMailboxPair, operation: MailboxOperation): void {
  applyOperation(pair, operation);
}

function applySignalingOperation(pair: SignalingMailboxPair, operation: SignalingOperation): void {
  match(operation)
    .with({ kind: 'enqueueSignal' }, (o) => onEnqueueSignal(pair, o))
    .with({ kind: 'replaySignal' }, (o) => onReplaySignal(pair, o))
    .with({ kind: 'reparkHead' }, () => onReparkHead(pair))
    .with(
      { kind: P.not(P.union('enqueueSignal', 'replaySignal', 'reparkHead')) },
      (o) => onMailboxOperation(pair, o),
    )
    .exhaustive();
}

/** A third of the messages are control — enough that both classes stay in play all walk long. */
const controlFor = (value: number): boolean => value % 3 === 0;

/**
 * A predicate that fails the ways real ones do: it throws for one residue
 * class and answers a truthy value that is not `true` for another.  Both must
 * land in the ordinary class, and a walk checks that far more thoroughly than
 * a fixed case can, because the class a message lands in decides every later
 * eviction.
 */
const unrulyControlFor = (value: number): boolean => {
  if (value % 7 === 0) throw new Error(`cannot classify ${value}`);
  if (value % 7 === 1) return 1 as unknown as boolean;
  return value % 3 === 0;
};

type ControlAwareVariant = {
  readonly name: string;
  readonly create: () => {
    readonly pair: SignalingMailboxPair;
    readonly realReasons: MailboxDropReason[];
    readonly modelReasons: MailboxDropReason[];
  };
};

const controlAwareVariant = (
  capacity: number | undefined,
  overflow: BoundedMailboxOverflow,
  isControl: (value: number) => boolean = controlFor,
): ControlAwareVariant['create'] => () => {
  const realReasons: MailboxDropReason[] = [];
  const modelReasons: MailboxDropReason[] = [];
  return {
    pair: {
      mailbox: new ProbeControlAwareMailbox({
        isControl,
        ...(capacity === undefined ? {} : { capacity, overflow }),
        onDrop: (reason) => realReasons.push(reason),
      }),
      reference: new ArrayControlAwareMailboxModel(
        isControl,
        capacity,
        overflow,
        (reason) => modelReasons.push(reason),
      ),
    },
    realReasons,
    modelReasons,
  };
};

const controlAwareVariants: ReadonlyArray<ControlAwareVariant> = [
  { name: 'ControlAwareMailbox (unbounded)', create: controlAwareVariant(undefined, 'reject') },
  { name: 'ControlAwareMailbox drop-head', create: controlAwareVariant(8, 'drop-head') },
  { name: 'ControlAwareMailbox drop-new', create: controlAwareVariant(8, 'drop-new') },
  { name: 'ControlAwareMailbox reject', create: controlAwareVariant(8, 'reject') },
  {
    name: 'ControlAwareMailbox unruly predicate (unbounded)',
    create: controlAwareVariant(undefined, 'reject', unrulyControlFor),
  },
  {
    name: 'ControlAwareMailbox unruly predicate, drop-head',
    create: controlAwareVariant(8, 'drop-head', unrulyControlFor),
  },
];

const signalingOperationArbitrary: fc.Arbitrary<SignalingOperation> = fc.oneof(
  { arbitrary: operationArbitrary, weight: 21 },
  {
    arbitrary: message.map((value): SignalingOperation => ({ kind: 'enqueueSignal', message: value })),
    weight: 2,
  },
  {
    arbitrary: message.map((value): SignalingOperation => ({ kind: 'replaySignal', message: value })),
    weight: 1,
  },
  { arbitrary: fc.constant<SignalingOperation>({ kind: 'reparkHead' }), weight: 2 },
);

/**
 * `size: 'max'` is what makes `maxLength` mean something here.  Without it
 * fast-check generates arrays at its default `'small'` size — at most ten
 * elements, about four on average, measured against fast-check 4.10 under
 * this suite's preload.  That is enough to fill one bounded queue, but this
 * mailbox's interesting states are conjunctions — an ordinary class at its
 * bound *and* a control arrival, a signal, or a replayed notification at that
 * moment — and at ten operations they came up too rarely: seven of nineteen
 * deliberately wrong implementations passed the short walk, none passes this
 * one.  At `'max'` the walks average over a hundred operations.
 */
const controlAwareWalk = fc.array(signalingOperationArbitrary, { maxLength: 250, size: 'max' });

describe('ControlAwareMailbox matches a two-class array reference model (#1431)', () => {
  for (const variant of controlAwareVariants) {
    test(`property: ${variant.name}`, () => {
      fc.assert(
        fc.property(controlAwareWalk, (operations) => {
          const { pair, realReasons, modelReasons } = variant.create();
          for (const operation of operations) {
            applySignalingOperation(pair, operation);
            expectSameState(pair);
          }
          expect(realReasons).toEqual(modelReasons);
          // Whatever survived, control first, in the order it would be delivered.
          expect(messagesOf(pair.mailbox.drainUser())).toEqual(messagesOf(pair.reference.drainUser()));
          expect(messagesOf(pair.mailbox.drainSystem())).toEqual(messagesOf(pair.reference.drainSystem()));
        }),
        { numRuns: 120 },
      );
    });
  }
});

/**
 * The regression #407 left behind: `drop-head` used `dequeueUser`, which
 * refuses while suspended, so the queue grew past capacity and the drop was
 * counted anyway.  A random walk that suspends and resumes is the cheapest
 * guard that the bounds keep holding across the whole enqueue path.
 *
 * `prependUser` is in the walk for every variant since #772.  It used to be
 * excluded for `BoundedMailbox`, because that path inherited the base
 * implementation and bypassed the bound — the exclusion was the suite
 * asserting the gap rather than the invariant.  Both mailboxes now bound
 * their replay, by different routes: `BoundedMailbox` sheds at the tail to
 * make room at the head, `PriorityMailbox` re-enters `enqueue` so priorities
 * are recomputed.  The model above pins each against its own reference.
 */
/* --------------- the absolute bound, checked without a model --------------- */

const applyEnqueue = (mailbox: MailboxUnderTest, operation: EnqueueOperation): void =>
  mailbox.enqueue(envelopeOf(operation.message));
const applyPrependUser = (mailbox: MailboxUnderTest, operation: PrependUserOperation): void =>
  mailbox.prependUser(operation.messages.map(envelopeOf));
const applyEnqueueSystem = (mailbox: MailboxUnderTest, operation: EnqueueSystemOperation): void =>
  mailbox.enqueueSystem(envelopeOf(operation.message));
const applyDequeueUser = (mailbox: MailboxUnderTest): void => void mailbox.dequeueUser();
const applyDequeueSystem = (mailbox: MailboxUnderTest): void => void mailbox.dequeueSystem();
const applyEvictOldest = (mailbox: MailboxUnderTest): void => void mailbox.evictOldest();
const applyDrainUser = (mailbox: MailboxUnderTest): void => void mailbox.drainUser();
const applyDrainSystem = (mailbox: MailboxUnderTest): void => void mailbox.drainSystem();
const applySuspend = (mailbox: MailboxUnderTest): void => mailbox.suspend();
const applyResume = (mailbox: MailboxUnderTest): void => mailbox.resume();

/** The same operations against one mailbox, with nothing to compare against. */
function driveOne(mailbox: MailboxUnderTest, operation: MailboxOperation): void {
  match(operation)
    .with({ kind: 'enqueue' }, (o) => applyEnqueue(mailbox, o))
    .with({ kind: 'prependUser' }, (o) => applyPrependUser(mailbox, o))
    .with({ kind: 'enqueueSystem' }, (o) => applyEnqueueSystem(mailbox, o))
    .with({ kind: 'dequeueUser' }, () => applyDequeueUser(mailbox))
    .with({ kind: 'dequeueSystem' }, () => applyDequeueSystem(mailbox))
    .with({ kind: 'evictOldest' }, () => applyEvictOldest(mailbox))
    .with({ kind: 'drainUser' }, () => applyDrainUser(mailbox))
    .with({ kind: 'drainSystem' }, () => applyDrainSystem(mailbox))
    .with({ kind: 'suspend' }, () => applySuspend(mailbox))
    .with({ kind: 'resume' }, () => applyResume(mailbox))
    .exhaustive();
}

/**
 * The regression #407 left behind: `drop-head` used `dequeueUser`, which
 * refuses while suspended, so the queue grew past capacity and the drop was
 * counted anyway.  The model test above would catch a divergence from the
 * reference; this one states the bound absolutely, so it cannot be satisfied
 * by a model that regressed in the same direction.
 *
 * The walk includes `prependUser` for both mailboxes since #772.  While
 * `BoundedMailbox` inherited the base implementation, this test ran against a
 * filtered arbitrary — which meant the one suite stating the bound absolutely
 * was stating it over exactly the operations that could not break it.
 */
describe('#407 stays fixed under a random walk', () => {
  test('BoundedMailbox never exceeds its capacity, unstash included', () => {
    fc.assert(
      fc.property(fc.array(operationArbitrary, { maxLength: 250 }), (operations) => {
        const mailbox = new ProbeBoundedMailbox({ capacity: 8, overflow: 'drop-head' });
        for (const operation of operations) {
          driveOne(mailbox, operation);
          expect(mailbox.size).toBeLessThanOrEqual(8);
        }
      }),
      { numRuns: 120 },
    );
  });

  test('a bounded PriorityMailbox never exceeds its capacity, unstash included', () => {
    fc.assert(
      fc.property(fc.array(operationArbitrary, { maxLength: 250 }), (operations) => {
        const mailbox = new ProbePriorityMailbox({
          priorityFor,
          capacity: 8,
          overflow: 'drop-lowest-priority',
        });
        for (const operation of operations) {
          driveOne(mailbox, operation);
          expect(mailbox.size).toBeLessThanOrEqual(8);
        }
      }),
      { numRuns: 120 },
    );
  });

  /**
   * Stated absolutely rather than against the model, for the same reason as
   * the two above: a walk whose `priorityFor` throws must not be able to
   * reach the caller at all, and the bound must keep holding while it
   * happens.  A containment that let one enqueue in ten escape would satisfy
   * the model test as long as the reference escaped too.
   */
  test('a bounded PriorityMailbox contains an unrankable priority and stays bounded', () => {
    fc.assert(
      fc.property(fc.array(operationArbitrary, { maxLength: 250 }), (operations) => {
        const mailbox = new ProbePriorityMailbox({
          priorityFor: unrankablePriorityFor,
          capacity: 8,
          overflow: 'drop-lowest-priority',
        });
        for (const operation of operations) {
          driveOne(mailbox, operation);
          expect(mailbox.size).toBeLessThanOrEqual(8);
        }
      }),
      { numRuns: 120 },
    );
  });
});
