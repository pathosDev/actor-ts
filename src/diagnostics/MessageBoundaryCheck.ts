import type { ActorPath } from '../ActorPath.js';
import { ActorRef } from '../ActorRef.js';
import { isFrameworkMessage } from '../util/FrameworkMessage.js';
import { SYSTEM_GUARDIAN_NAME } from '../internal/Guardian.js';
import type { Logger } from '../Logger.js';
import type { SerializationExtension } from '../serialization/SerializationExtension.js';
import {
  DEFAULT_MESSAGE_BOUNDARY_SERIALIZER_ROUND_TRIP,
  DEFAULT_MESSAGE_BOUNDARY_STRUCTURED_CLONE,
  type MessageBoundaryMode,
  type MessageBoundaryOptionsType,
} from './MessageBoundaryOptions.js';

/**
 * A message that would not survive a boundary the check stands in for, thrown
 * on the sender's stack under the `fail` mode.
 */
export class MessageBoundaryError extends Error {
  constructor(
    /** `structured-clone` or `serializer-round-trip`. */
    readonly boundary: string,
    /** The message's type as the report names it: constructor name, or `kind`, or `typeof`. */
    readonly messageType: string,
    readonly recipient: string,
    detail: string,
  ) {
    super(`message ${messageType} to ${recipient} would not survive the ${boundary} boundary: ${detail}`);
    this.name = 'MessageBoundaryError';
  }
}

/** What building the check needs from the system: the sinks it reports to, and the serializer it round-trips through. */
export type MessageBoundaryHost = {
  readonly log: Logger;
  serialization(): SerializationExtension;
};

/**
 * Every local `tell` held to the boundaries a message meets in production
 * (#1386).
 *
 * In-process delivery hands the receiver the very object the sender built —
 * prototype intact, methods working, functions callable.  A worker hop
 * structured-clones it: a class instance arrives as a plain object, silently,
 * and a function-valued field does not arrive at all.  A cluster wire runs
 * it through a serializer, which needs a binding for the class.  The suite of
 * an application exercises the first path almost exclusively, so a message
 * type can be green locally and degrade the first time
 * `actor-ts.parallelism.workers` is switched on.  This check makes the local
 * path answer for the others: with a mode on, the message is examined at
 * `tell` time the way the boundary would examine it, and what would be lost
 * is reported — with the type and the recipient — while there is still a
 * stack to report it on.
 *
 * Two independent switches, because they catch different defects: the
 * structured-clone half a silent degradation, the serializer half a hard
 * failure.  Off, the check does not exist — `ActorSystem` keeps `null` and
 * `postUserEnvelope` pays one comparison.
 */
export class MessageBoundaryCheck {
  readonly structuredClone: MessageBoundaryMode;
  readonly serializerRoundTrip: MessageBoundaryMode;
  /** Message types already warned about, so `warn` is one line per type and not one per message. */
  private readonly warned = new Set<string>();

  constructor(
    private readonly host: MessageBoundaryHost,
    options: MessageBoundaryOptionsType,
  ) {
    this.structuredClone = options.structuredClone ?? DEFAULT_MESSAGE_BOUNDARY_STRUCTURED_CLONE;
    this.serializerRoundTrip = options.serializerRoundTrip ?? DEFAULT_MESSAGE_BOUNDARY_SERIALIZER_ROUND_TRIP;
  }

  /** Whether either mode is on — the system builds no check otherwise. */
  static isEnabled(options: MessageBoundaryOptionsType): boolean {
    return (options.structuredClone ?? DEFAULT_MESSAGE_BOUNDARY_STRUCTURED_CLONE) !== 'off'
      || (options.serializerRoundTrip ?? DEFAULT_MESSAGE_BOUNDARY_SERIALIZER_ROUND_TRIP) !== 'off';
  }

  /**
   * Examine one message on its way to `recipient`.  Framework messages and
   * anything bound for the `/system` tree are exempt: the framework's own
   * classes cross their boundaries by their own mechanisms, and a system
   * actor is never the far side of a worker hop.
   */
  check(message: unknown, recipient: ActorPath): void {
    if (message === null || typeof message !== 'object') return;
    if (isFrameworkMessage(message) || isUnderSystemGuardian(recipient)) return;
    if (this.structuredClone !== 'off') {
      const problem = structuredCloneProblem(message);
      if (problem !== null) this.report(this.structuredClone, 'structured-clone', message, recipient, problem);
    }
    if (this.serializerRoundTrip !== 'off') {
      const problem = this.serializerProblem(message);
      if (problem !== null) this.report(this.serializerRoundTrip, 'serializer-round-trip', message, recipient, problem);
    }
  }

  private serializerProblem(message: unknown): string | null {
    try {
      const serialization = this.host.serialization();
      serialization.decode(serialization.encode(message));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private report(mode: MessageBoundaryMode, boundary: string, message: object, recipient: ActorPath, detail: string): void {
    const messageType = describeMessageType(message);
    if (mode === 'fail') throw new MessageBoundaryError(boundary, messageType, recipient.toString(), detail);
    const key = `${boundary}:${messageType}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.host.log.warn(
      `[message-boundary] ${messageType} to ${recipient.toString()} would not survive the ${boundary} boundary: ${detail} `
      + '(reported once per type)',
    );
  }
}

function isUnderSystemGuardian(path: ActorPath): boolean {
  let current: ActorPath | null = path;
  while (current !== null && current.parent !== null) {
    if (current.parent.parent === null) return current.name === SYSTEM_GUARDIAN_NAME;
    current = current.parent;
  }
  return false;
}

/** `Deposit`, or `{kind: 'deposit'}`, or `object` — the name a report and a warn-once key use. */
export function describeMessageType(message: object): string {
  const constructor = Object.getPrototypeOf(message)?.constructor as { name?: string } | undefined;
  const name = constructor?.name;
  if (name !== undefined && name !== 'Object' && name !== 'Array' && name.length > 0) return name;
  const kind = (message as { kind?: unknown }).kind;
  if (typeof kind === 'string') return `{ kind: '${kind}' }`;
  return Array.isArray(message) ? 'array' : 'object';
}

/**
 * The prototypes the structured clone algorithm preserves, beyond plain
 * objects and arrays.  Everything else reachable in a message comes out of
 * the clone as a plain object — which is the silent case this exists for.
 */
const PRESERVED_PROTOTYPES: ReadonlySet<object> = new Set<object>([
  Object.prototype,
  Array.prototype,
  Date.prototype,
  RegExp.prototype,
  Map.prototype,
  Set.prototype,
  ArrayBuffer.prototype,
  DataView.prototype,
  Error.prototype,
  EvalError.prototype,
  RangeError.prototype,
  ReferenceError.prototype,
  SyntaxError.prototype,
  TypeError.prototype,
  URIError.prototype,
  Boolean.prototype,
  Number.prototype,
  String.prototype,
  BigInt.prototype,
]);

function isPreservedPrototype(prototype: object): boolean {
  if (PRESERVED_PROTOTYPES.has(prototype)) return true;
  // Every typed array shares one abstract ancestor; naming the nine
  // concrete ones would miss BigInt64Array and whatever comes next.
  return prototype === TYPED_ARRAY_PROTOTYPE || Object.getPrototypeOf(prototype) === TYPED_ARRAY_PROTOTYPE;
}

const TYPED_ARRAY_PROTOTYPE: object = Object.getPrototypeOf(Uint8Array.prototype) as object;

/**
 * What a worker hop would do to `message`, or `null` when it arrives intact.
 * Two questions, in the order they matter: is anything reachable going to
 * lose its prototype — found by walking, because `structuredClone` succeeds
 * on it and says nothing — and can the value be cloned at all, found by
 * cloning it.  `ActorRef`s are skipped with their subtrees: every remote
 * send rewrites them to wire markers before the port sees them, so a
 * `replyTo` field is exactly what it should be.
 */
export function structuredCloneProblem(message: object): string | null {
  const lost = findPrototypeLoss(message, '$', new Set());
  if (lost !== null) return lost;
  try {
    structuredClone(withoutRefs(message, new Map()));
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `it cannot be cloned at all — ${reason}`;
  }
}

function findPrototypeLoss(value: unknown, at: string, seen: Set<object>): string | null {
  if (value === null || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (value instanceof ActorRef) return null;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== null && !isPreservedPrototype(prototype)) {
    const name = (prototype as { constructor?: { name?: string } }).constructor?.name || '(anonymous class)';
    return at === '$'
      ? `it is an instance of ${name}, which arrives as a plain object without its prototype — `
        + 'send plain data (a `kind`-discriminated object) instead'
      : `the value at ${at} is an instance of ${name}, which arrives as a plain object without its prototype`;
  }
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      const problem = findPrototypeLoss(entry, `${at}.get(${String(key)})`, seen);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (value instanceof Set) {
    for (const entry of value) {
      const problem = findPrototypeLoss(entry, `${at}[Set]`, seen);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = findPrototypeLoss(value[i], `${at}[${i}]`, seen);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  for (const key of Object.keys(value)) {
    const problem = findPrototypeLoss((value as Record<string, unknown>)[key], `${at}.${key}`, seen);
    if (problem !== null) return problem;
  }
  return null;
}

/** A copy of `value` with every `ActorRef` replaced by `null`, the shape the wire would clone. */
function withoutRefs(value: unknown, copies: Map<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof ActorRef) return null;
  const existing = copies.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    copies.set(value, copy);
    for (const entry of value) copy.push(withoutRefs(entry, copies));
    return copy;
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    copies.set(value, copy);
    for (const [key, entry] of value) copy.set(withoutRefs(key, copies), withoutRefs(entry, copies));
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>();
    copies.set(value, copy);
    for (const entry of value) copy.add(withoutRefs(entry, copies));
    return copy;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy: Record<string, unknown> = {};
  copies.set(value, copy);
  for (const key of Object.keys(value)) copy[key] = withoutRefs((value as Record<string, unknown>)[key], copies);
  return copy;
}
