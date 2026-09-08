import type { Cancellable, Scheduler } from './Scheduler.js';
import { ActorPath } from './ActorPath.js';
import { AskTimeoutError, PoisonPill, Kill } from './SystemMessages.js';
import { DEFAULT_ASK_TIMEOUT_MS } from './util/Constants.js';
import { OptionsError } from './util/OptionsValidator.js';
import { randomId } from './util/RandomString.js';

/**
 * Drop `replyTo: ActorRef<...>` from any variant of a message union
 * that declares one.  Distributes across unions: variants without
 * `replyTo` pass through untouched; variants with `replyTo` lose just
 * that field.  Used by `ActorRef.ask()` so callers never have to
 * supply the `replyTo` field — the framework synthesises and injects
 * one on every call.
 */
export type OmitReplyTo<TMessage> = TMessage extends { replyTo: ActorRef<unknown> }
  ? Omit<TMessage, 'replyTo'>
  : TMessage;

/**
 * Names the one-shot reply ref that `ask` creates.
 *
 * Was a module-global `++askCounter`.  Two problems with that: the name is
 * predictable, so anything that can address a ref by path could aim a forged
 * reply at an in-flight ask; and the counter is per *module*, not per system,
 * so two systems in one process hand out the same names — and after a long
 * enough run it wraps into collisions with names still in flight.
 *
 * A random suffix fixes both.  Twelve characters is ~48 bits: far beyond the
 * number of asks that can be in flight at once, which is what has to be unique
 * here.  See {@link randomId} for the entropy itself, shared with the other
 * names the framework generates.
 */
const nextAskName = (): string => `askResp-${randomId(12)}`;

/**
 * Path segment holding the short-lived refs `ask` synthesises.
 *
 * A reply ref used to *be* a root (`new ActorPath(name, null, systemName)`),
 * and {@link ActorPath} renders a root without its own name — so the ref came
 * out as `actor-ts://<system>/`, name gone.  Locally that is invisible: the ref
 * is passed around as an object and never looked up by path.  Across the
 * cluster wire the path is the whole address, so every reply went back
 * addressed to the bare system root, matched nothing on arrival, and each
 * cross-node `ask` timed out (#517).
 *
 * A named segment keeps the name in the rendering.  `temp` rather than `user`
 * or `system` because these are not actors in the tree — nothing spawns them,
 * `_resolvePath` never finds them, and the cluster resolves them through a
 * registration that lives exactly as long as the ask does.
 */
const TEMP_SEGMENT = 'temp';

/**
 * Refuse an ask deadline that would arm no timer.
 *
 * {@link AskResponseRef} creates its timeout under `if (timeoutMs > 0)`, and a
 * reply ref without a timer has no second way to settle — `tell` is the only
 * other caller of its `settle()`.  So an unanswered ask with a non-positive or
 * non-finite deadline leaves the caller's `await` pending forever and, once the
 * ref has been encoded onto the wire, leaves one entry in
 * `Cluster._envelopeHandlersByPath` that `dispatchEnvelope` consults on every
 * inbound envelope and that nothing ever removes (#765).
 *
 * Neither value needs a typo to arrive: a computed budget
 * (`deadline - Date.now()`) is negative the moment the deadline has passed, and
 * an untyped configuration value arrives as whatever it parsed to.  #602 closed
 * this same shape on `HttpClient`'s per-request limits.
 *
 * **Zero is refused too, which is where this parts company with #602.**  An
 * HTTP request with no deadline still settles when its socket does, so zero is
 * a usable per-call opt-out there.  An ask has no such fallback: the reply ref
 * is neither returned to the caller nor exported from `src/index.ts`, so a
 * caller holding only the promise cannot settle it by hand, and until #177
 * ("Cancelable ask") gives `ask` a cancellation handle there is nothing to
 * settle it with.  Refusing zero also puts this positional argument in the same
 * domain as every option-sourced ask timeout in the framework —
 * `ScatterGatherOptions.timeoutMs`, `ClusterClientOptions.askTimeoutMs` and
 * `ClusterClientReceptionistOptions.askTimeoutMs` all validate with
 * `positiveNumber`, which rejects it — and makes the documented "mandatory in
 * spirit" deadline mandatory in fact.  Omitting the argument still yields a
 * deadline, as does an explicit `undefined`: whatever
 * {@link ActorRef._defaultAskTimeoutMs} answers, which is
 * `actor-ts.actor.ask-timeout` where the ref can see a system and
 * {@link DEFAULT_ASK_TIMEOUT_MS} where it cannot.  A configured value is
 * refused by `ActorSystem` at startup, so nothing this function would reject
 * can arrive through that door (#863).
 *
 * Written out rather than run through an `OptionsValidator` subclass on
 * purpose: the rule is one comparison on one positional argument, and the
 * validator form would allocate a settings object and a validator instance on
 * every ask — on a path where the message spread below is documented as the
 * last per-ask allocation worth keeping.
 */
function assertAskTimeout(timeoutMs: number): void {
  // `Number.isFinite` does not coerce, so it also rejects a non-number that
  // reached here from untyped JavaScript.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new OptionsError(
      `ActorRef.ask: timeoutMs must be a positive finite number (got ${String(timeoutMs)})`
      + ' — an ask that arms no deadline can never settle',
      'ActorRef.ask',
      'timeoutMs',
      timeoutMs,
    );
  }
}

/**
 * Handle to an actor.  The only way to interact with an actor — you never
 * hold a direct reference to the Actor instance itself.  tell() is fire-and-
 * forget; ask() provides a request/response Promise.
 */
export abstract class ActorRef<TMessage = unknown> {
  abstract readonly path: ActorPath;

  /** Send a message to this actor. `sender` is surfaced as context.sender in the recipient. */
  abstract tell(message: TMessage, sender?: ActorRef | null): void;

  /** Alias for tell — useful if you want to pipe something. */
  send(message: TMessage): void { this.tell(message, null); }

  /**
   * Request/response — send `message` and await the recipient's reply.
   * The framework synthesises a one-shot reply ref, injects it as both
   * the `sender` slot and as `message.replyTo`, and resolves the returned
   * promise with the first reply (or rejects with `AskTimeoutError`).
   *
   * The caller never specifies `replyTo` on the message — the `OmitReplyTo`
   * type subtracts it from the parameter type if the recipient declares it.
   *
   *     const value = await counter.ask<number>({ kind: 'get' });
   *
   * `timeoutMs` must be a positive finite number; omit it (or pass
   * `undefined`) to get {@link ActorRef._defaultAskTimeoutMs} — the configured
   * `actor-ts.actor.ask-timeout` on a ref that can reach its `ActorSystem`,
   * and {@link DEFAULT_ASK_TIMEOUT_MS} on one that cannot.  `0`, a negative
   * value, `NaN` and `Infinity` throw {@link OptionsError} — see
   * {@link assertAskTimeout} for why an ask has no "no deadline" mode.
   */
  ask<TResponse = unknown>(
    message: OmitReplyTo<TMessage>,
    timeoutMs?: number,
  ): Promise<TResponse> {
    // `??`, so the override is consulted only when the caller said nothing —
    // an explicit argument never pays for the virtual call, and the resolved
    // value is what the reply ref and the error message both quote.
    const resolvedTimeoutMs = timeoutMs ?? this._defaultAskTimeoutMs();
    // Before anything is allocated or sent, and thrown rather than returned as
    // a rejected promise: an argument outside its domain is a defect at the
    // call site, so the failure belongs on the caller's stack.  A rejected
    // promise would instead surface as an unhandled rejection for the
    // fire-and-forget `void ref.ask(...)` shape the cluster client uses.
    assertAskTimeout(resolvedTimeoutMs);
    const name = nextAskName();
    const systemName = this.path.systemName;
    const ref = new AskResponseRef<TResponse>(
      systemName, name, resolvedTimeoutMs, this.path.toString(), this._virtualScheduler(),
    );
    // Inject `replyTo: ref` into the message so recipients that read
    // `msg.replyTo` work without the caller supplying it.  Recipients
    // that read `this.sender` see the same ref (passed via `tell`'s
    // second arg).
    //
    // The spread stays, and was measured rather than assumed: it is the last
    // per-ask allocation of any size, and both ways around it are worse.
    // Writing `replyTo` onto the caller's object is observable — callers reuse
    // message objects — and a prototype-based stand-in breaks the wire, since
    // serialising a remote ask walks own properties and would drop it.
    const enriched =
      typeof message === 'object' && message !== null
        ? ({ ...(message as object), replyTo: ref } as unknown as TMessage)
        : (message as unknown as TMessage);
    this.tell(enriched, ref as unknown as ActorRef);
    return ref.promise;
  }

  /**
   * @internal The deadline {@link ask} arms when the caller names none.
   *
   * A method rather than a field because the answer belongs to the ref's
   * `ActorSystem`, and the refs do not agree on whether they have one.  The
   * seven that do — {@link LocalActorRef}, `TestProbe`, `RemoteActorRef`,
   * `ClusterSingletonProxy`, `RemoteShardRef`, `ShardSenderRef`, and
   * `EntityRef` through its region — override this with
   * `system._defaultAskTimeoutMs`, so `actor-ts.actor.ask-timeout` reaches
   * every ask a caller is likely to make (#863).  The other six hold a
   * `systemName` string and no system — {@link NobodyRef},
   * {@link AskResponseRef}, `DeadLetterRef`, `UnresolvedPathRef`,
   * `WebsocketConnectionImplementation` and `GracefulStop`'s
   * `TerminationWatcher` — and keep the built-in constant.  None of them has
   * an actor behind it, so an ask on one is waiting for a reply that is not
   * coming; the deadline decides how fast that is discovered, not whether.
   * That split is documented rather than papered
   * over: the alternative, a process-global `Map<systemName, number>`, buys
   * uniformity with a lookup on the ask path and mutable state two systems in
   * one process would share by name.
   *
   * Public (not `protected`) because {@link EntityRef} delegates through a
   * region typed as a bare `ActorRef`, which TypeScript will not let a
   * sibling subclass reach a `protected` member on.
   */
  _defaultAskTimeoutMs(): number { return DEFAULT_ASK_TIMEOUT_MS; }

  /**
   * @internal The scheduler an ask's deadline is armed on when that scheduler
   * is **virtual**, and `null` otherwise — including on a real one.
   *
   * The same question {@link _defaultAskTimeoutMs} answers, with the same split
   * and for the same reason — the refs do not agree on whether they can see an
   * `ActorSystem` — so the refs that can override both together.
   *
   * What it buys is a deadline a test can advance past.  Without it, a test for
   * "the reply never came" has to let the deadline elapse on the wall clock, so
   * it is written with an unrealistically short one and then fails on a loaded
   * machine — the commonest shape in this repository's flake catalogue (#1424).
   *
   * **Virtual only, and that is measured, not cautious.**  Arming every ask
   * through the scheduler costs ~13% of `ask-throughput` (195k → 170k ask/s,
   * p50 2.8 → 3.1 µs) in cancellable allocation and set bookkeeping.  A
   * wall-clock scheduler offers nothing in return for it — nobody can advance
   * past a real deadline — so a real one answers `null` here and the
   * `setTimeout` branch in {@link AskResponseRef} is exactly the code it always
   * was.  The lookup itself is free: keeping this call and bypassing the
   * scheduler restores the baseline figure.
   */
  _virtualScheduler(): Scheduler | null { return null; }

  /** Gracefully stop this actor after it drains its mailbox. */
  stop(): void { this.tell(PoisonPill.instance as unknown as TMessage, null); }

  /** Kill this actor — raises ActorKilledError through the normal supervision path. */
  kill(): void { this.tell(Kill.instance as unknown as TMessage, null); }

  toString(): string { return this.path.toString(); }

  equals(other: ActorRef): boolean {
    return this.path.toString() === other.path.toString();
  }
}

/**
 * Short-lived ref synthesised by {@link ActorRef.ask} to capture the
 * recipient's reply.  Accepts the first message (success or `Error`-shaped
 * failure) and either resolves or rejects its promise; further messages
 * are dropped.  If `timeoutMs` elapses before a reply, rejects with
 * {@link AskTimeoutError}.
 *
 * Lives in `ActorRef.ts` (not a separate file) so the abstract `ActorRef`
 * class has a concrete reply-ref to instantiate without any module-cycle
 * gymnastics — `AskResponseRef extends ActorRef`, both in the same file.
 */
/**
 * `actor-ts://<system>/temp`, one per system name.
 *
 * The reply ref's own segment still gets a fresh `ActorPath` — it has to, the
 * name is different every time — but the two above it are constant, and
 * rebuilding them meant running {@link ActorPath}'s name validation over
 * `'temp'` on every ask forever.
 *
 * Keyed by system name and never evicted, which is sound because the key space
 * is the set of `ActorSystem` names a process has created: one or two in an
 * application, a few dozen across a test run, and each entry is a path object.
 */
const tempPathRoots = new Map<string, ActorPath>();

function tempPathRootFor(systemName: string): ActorPath {
  let root = tempPathRoots.get(systemName);
  if (root === undefined) {
    root = new ActorPath('', null, systemName).child(TEMP_SEGMENT);
    tempPathRoots.set(systemName, root);
  }
  return root;
}

export class AskResponseRef<T = unknown> extends ActorRef<unknown> {
  readonly path: ActorPath;
  readonly promise: Promise<T>;
  private resolveFunction!: (value: T) => void;
  private rejectFunction!: (err: Error) => void;
  private settled = false;
  private timer: Cancellable | ReturnType<typeof setTimeout> | null = null;
  /**
   * `null` until something registers, which for a local ask is never.
   *
   * Only the cluster uses this — it hangs the teardown of its wire
   * registration here — and every local ask was allocating the array anyway.
   */
  private settleCallbacks: Array<() => void> | null = null;

  constructor(
    systemName: string,
    name: string,
    timeoutMs: number,
    targetLabel: string,
    scheduler: Scheduler | null = null,
  ) {
    super();
    // Two of the three path constructions per ask were the same constant
    // prefix, rebuilt (and re-validated, character by character) every time.
    // Cached per system name, which is the only thing that varies: a process
    // has one or two, and a test suite a few dozen.
    this.path = tempPathRootFor(systemName).child(name);
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFunction = resolve;
      this.rejectFunction = reject;
    });
    // One `setTimeout` per ask, kept deliberately.  A shared deadline wheel
    // would amortise the pair across many asks, and would also change what a
    // timeout *means*: a bucketed wheel fires up to one bucket late, so a
    // 5 s ask could reject at 5.1 s.  That is a semantic change to buy back a
    // small share of a setup cost the pooled entropy and the cached temp path
    // have already taken most of.  Revisit only with a profile showing timers
    // are still material.
    //
    // The guard stays conditional rather than becoming unconditional, and what
    // is left of it is not the hole #765 named: {@link ActorRef.ask} refuses a
    // non-positive deadline outright, so no caller-facing path reaches the
    // timerless branch any more.  It still serves the refs
    // `tests/integration/in-process/cluster/RefCodec.test.ts` builds by hand to
    // exercise the wire registration, which settle on a reply rather than a
    // clock — arming a real timer for those would race the reply under test.
    if (timeoutMs > 0) {
      const expire = (): void => {
        if (this.settled) return;
        this.settle();
        this.rejectFunction(new AskTimeoutError(
          `Ask timed out after ${timeoutMs}ms waiting for reply from ${targetLabel}`,
        ));
      };
      // The scheduler where the ref could reach one, so a `ManualScheduler`
      // makes the deadline virtual; a raw timer otherwise, unchanged (#1424).
      // Virtual time where there is any, so a test can advance past the
      // deadline; the host timer otherwise, unchanged and uncosted (#1424).
      this.timer = scheduler === null
        ? setTimeout(expire, timeoutMs)
        : scheduler.scheduleOnceFunction(timeoutMs, expire);
    }
  }

  tell(message: unknown): void {
    if (this.settled) return;
    this.settle();
    if (message instanceof Error) this.rejectFunction(message);
    else this.resolveFunction(message as T);
  }

  /**
   * @internal Run `callback` once this ref settles — by reply, by error, or by
   * timeout.  Fires immediately if it already has.
   *
   * The cluster hangs the teardown of its wire registration here.  Without it
   * that map would gain an entry per cross-node ask and never lose one, which
   * is the unbounded growth every other buffered path in the framework is
   * careful to avoid.
   */
  _onSettled(callback: () => void): void {
    if (this.settled) { callback(); return; }
    (this.settleCallbacks ??= []).push(callback);
  }

  private settle(): void {
    this.settled = true;
    if (this.timer) {
      // A `Cancellable` when a scheduler armed it, a host timer handle
      // otherwise. Distinguished structurally rather than by a second field:
      // the alternative is another per-ask property on the path the message
      // spread is documented as the last allocation worth keeping.
      if (typeof (this.timer as Cancellable).cancel === 'function') {
        (this.timer as Cancellable).cancel();
      } else {
        clearTimeout(this.timer as ReturnType<typeof setTimeout>);
      }
      this.timer = null;
    }
    if (this.settleCallbacks !== null) {
      for (const callback of this.settleCallbacks) callback();
      this.settleCallbacks = null;
    }
  }
}

/**
 * The ref that means "no actor here".  Any message tell()'d to Nobody is
 * silently dropped (it does not even go to dead letters).
 */
export class NobodyRef extends ActorRef<unknown> {
  static readonly instance: NobodyRef = new NobodyRef();
  readonly path = new ActorPath('nobody', null, '<nobody>');
  private constructor() { super(); }
  tell(): void { /* drop */ }
}

export const Nobody: ActorRef = NobodyRef.instance;
