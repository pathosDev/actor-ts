/**
 * Initial slot count, and the reason every later capacity is a power of two.
 *
 * Stays here rather than moving to a `Constants.ts`: the power-of-two
 * invariant *is* the implementation — index arithmetic is `& mask` instead of
 * `% capacity`, which only works while the capacity is a power of two — so the
 * number and the algorithm cannot be separated without breaking one of them.
 *
 * Small on purpose.  A ring is allocated per queue and there is one queue per
 * actor (two, counting system messages), so a generous initial capacity is
 * paid for by every actor in the system whether or not it ever queues
 * anything.  The backing array is not allocated at all until the first
 * `push`, so an idle mailbox costs exactly what an empty `[]` costs — which
 * is what it cost before the ring existed.
 */
const INITIAL_RING_CAPACITY = 8;

/**
 * A first-in-first-out queue whose removal from the front is O(1).
 *
 * `Array.prototype.shift()` is O(n): it reindexes every remaining element.
 * That is invisible on a queue of ten and quadratic on a queue of a hundred
 * thousand — and since #1148 removed the default mailbox bound, an actor that
 * falls behind its producers has no ceiling short of the heap.  A deep mailbox
 * was paying one memmove of the whole backlog per message delivered (#408).
 *
 * This is the standard circular buffer: elements live in a fixed array between
 * a moving `head` and `head + count`, both wrapping at the end, so removing
 * the front advances an index instead of moving the payload.  Growth doubles
 * the array and re-lays the elements from index 0, which is the one O(n) step
 * and happens log2(n) times — amortized O(1) per push.
 *
 * Deliberately not a general-purpose deque.  It carries exactly the five
 * operations its callers need — {@link push}, {@link shift}, {@link pop},
 * {@link unshiftAll} and {@link drain} — because every extra one is another
 * index-wrapping edge case, and this type sits on the message path of every
 * actor in the system.
 */
export class RingBuffer<T> {
  /**
   * Slots.  Holds `count` live elements starting at {@link head} and wrapping;
   * every other slot is `undefined` so a drained element is not retained.
   *
   * Starts as a plain empty array rather than a pre-sized one: the ring is
   * per-actor and most actors never queue anything, so the allocation waits
   * for the first `push` (see {@link INITIAL_RING_CAPACITY}).
   */
  private slots: Array<T | undefined> = [];
  /** Index of the front element.  Meaningless while `count` is 0. */
  private head = 0;
  /** Live elements — the queue's length, distinct from `slots.length`. */
  private count = 0;
  /** `slots.length - 1`, cached because it is read twice per operation. */
  private mask = -1;

  /** Number of queued elements. */
  get length(): number {
    return this.count;
  }

  /** Append to the back.  Amortized O(1). */
  push(item: T): void {
    if (this.count === this.slots.length) this.grow(this.count + 1);
    this.slots[(this.head + this.count) & this.mask] = item;
    this.count++;
  }

  /** Remove and return the front element, or `undefined` when empty.  O(1). */
  shift(): T | undefined {
    if (this.count === 0) return undefined;
    const item = this.slots[this.head];
    // Cleared rather than left behind: the slot outlives the element until
    // the ring wraps back onto it, and a mailbox that has drained a burst of
    // large payloads must not keep them reachable.
    this.slots[this.head] = undefined;
    this.head = (this.head + 1) & this.mask;
    this.count--;
    return item;
  }

  /**
   * Remove and return the back element, or `undefined` when empty.  O(1).
   *
   * The mirror of {@link shift}, and it exists for one caller: a bound that
   * has to make room for something inserted at the *front* sheds at the back,
   * because that is the end furthest from the arrival (#772).  Without it a
   * mailbox could only evict what it was about to deliver.
   */
  pop(): T | undefined {
    if (this.count === 0) return undefined;
    const index = (this.head + this.count - 1) & this.mask;
    const item = this.slots[index];
    // Cleared for the same reason `shift` clears: the slot outlives the
    // element until the ring wraps back onto it.
    this.slots[index] = undefined;
    this.count--;
    return item;
  }

  /**
   * Insert `items` at the FRONT, preserving their order relative to each
   * other and placing all of them ahead of what is already queued.
   *
   * One bulk move rather than `n` individual unshifts, and — unlike
   * `Array.prototype.unshift(...items)` — no spread, so a stash replay of a
   * thousand messages neither reindexes the backlog `n` times nor pushes a
   * thousand arguments onto the call stack.
   */
  unshiftAll(items: ReadonlyArray<T>): void {
    if (items.length === 0) return;
    if (this.count + items.length > this.slots.length) this.grow(this.count + items.length);
    // Walking `head` backwards is what makes this O(items.length) rather than
    // O(count): the elements already queued never move.
    this.head = (this.head - items.length) & this.mask;
    for (let i = 0; i < items.length; i++) this.slots[(this.head + i) & this.mask] = items[i];
    this.count += items.length;
  }

  /**
   * Remove every element and return them in queue order.
   *
   * Returns a fresh array rather than handing out the backing store: the ring
   * is not a dense `T[]` and the caller must not see its holes or its
   * wrap-around.  The backing store is released too, so draining a queue that
   * grew to a million entries gives the memory back instead of holding a
   * million empty slots for an actor that is usually shutting down.
   */
  drain(): T[] {
    const drained = new Array<T>(this.count);
    for (let i = 0; i < this.count; i++) drained[i] = this.slots[(this.head + i) & this.mask] as T;
    this.slots = [];
    this.head = 0;
    this.count = 0;
    this.mask = -1;
    return drained;
  }

  /**
   * Re-lay the elements into a larger power-of-two array, front-aligned.
   *
   * The copy is the only O(n) step in the type, and doubling is what keeps it
   * amortized: reaching `n` elements costs `n + n/2 + n/4 + … < 2n` moves in
   * total, spread over log2(n) growths.
   */
  private grow(minimumCapacity: number): void {
    let capacity = this.slots.length === 0 ? INITIAL_RING_CAPACITY : this.slots.length * 2;
    while (capacity < minimumCapacity) capacity *= 2;
    // `fill` keeps the array packed and uniformly typed; a sparse
    // `new Array(n)` is a slower shape in both V8 and JavaScriptCore, and
    // this array is indexed once per message.
    const grown = new Array<T | undefined>(capacity).fill(undefined);
    for (let i = 0; i < this.count; i++) grown[i] = this.slots[(this.head + i) & this.mask];
    this.slots = grown;
    this.head = 0;
    this.mask = capacity - 1;
  }
}
