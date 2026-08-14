/*
 * actor-ts — an actor-model framework for TypeScript on Bun.
 *
 *   Quick start:
 *     import { ActorSystem, Actor } from 'actor-ts';
 *
 *     class Hello extends Actor<string> {
 *       onReceive(message: string) { console.log('hello', message); }
 *     }
 *
 *     const system = ActorSystem.create('demo');
 *     const ref = system.spawn(Hello, 'hello');
 *     ref.tell('world');
 *     await system.terminate();
 */

// Option<T> — explicit "might not have a value" type.
export {
  Some,
  None,
  none,
  some,
  fromNullable,
  fromPredicate,
  firstSome,
} from './util/Option.js';
export type { Option } from './util/Option.js';

// Lazy<T> — Scala-style `lazy val`: compute once on first .get(), memoise.
export { Lazy, lazy } from './util/Lazy.js';

// Try<T> — Success<T> / Failure wrapper for synchronous throwing computations.
export {
  Success,
  Failure,
  success,
  failure,
  tryOf,
  trySequence,
} from './util/Try.js';
export type { Try } from './util/Try.js';

// Either<L, R> — right-biased disjoint union for typed-error flows.
export {
  Left,
  Right,
  left,
  right,
  eitherOf,
  eitherSequence,
} from './util/Either.js';
export type { Either } from './util/Either.js';

// BidirectionalMap<K, V> — a Map that also answers value → key, keeping the
// inverse index in step for you.  Persists as a real instance.
export { BidirectionalMap } from './util/BidirectionalMap.js';
export type { BidirectionalMapJson } from './util/BidirectionalMap.js';

// BidirectionalMultiMap<L, R> — the same idea for a many-to-many relation:
// drop a participant on one side and it leaves no trace on the other.
export { BidirectionalMultiMap } from './util/BidirectionalMultiMap.js';
export type { BidirectionalMultiMapJson } from './util/BidirectionalMultiMap.js';

export { OptionsBuilder } from './util/OptionsBuilder.js';
export { OptionsValidator, OptionsError } from './util/OptionsValidator.js';

// Random strings — crypto entropy, no modulo bias, exact length, and an optional
// collision predicate that redraws for you.  The same source the framework names
// its own actors and reply refs from.
export { randomString, randomHex, randomId, randomUuid } from './util/RandomString.js';
export type { ExistsPredicate, RandomStringOptions } from './util/RandomString.js';

// safeStringify — JSON.stringify for log and error paths, which cannot throw.
export { safeStringify } from './util/SafeStringify.js';

// URL redaction for log and error paths.  The framework runs every connection
// URL it reports through these; exported so an application's own log line — or
// a MultiSinkLogger `transform` — can hold the same line.
export { redactUrlCredentials, redactedUrlLabel } from './util/RedactUrlCredentials.js';

// lazyImportModule — import an optional peer dependency, or fail with a message
// that names the package and how to install it.
export { lazyImportModule } from './util/LazyImport.js';
export type { LazyImportOptions } from './util/LazyImport.js';

// Core API
export { Actor } from './Actor.js';
export { ActorRef, Nobody, NobodyRef } from './ActorRef.js';
export { ActorPath } from './ActorPath.js';
export { ActorSelection, parseSelectionPath } from './ActorSelection.js';
export { ActorSystem } from './ActorSystem.js';
export { ActorSystemOptions, ActorSystemOptionsBuilder } from './ActorSystemOptions.js';
export type { ActorSystemOptionsType } from './ActorSystemOptions.js';
export type { ActorContext, Receive, TimerScheduler } from './ActorContext.js';
export { StashOverflowError, StashOutsideHandlerError } from './ActorContext.js';
export { ActorOptions, ActorOptionsBuilder, ActorOptionsValidator } from './ActorOptions.js';
export type { ActorOptionsType, MailboxFactory } from './ActorOptions.js';
export type { ActorClassOrFactory, ActorFactory } from './Actor.js';
export type { EntityContext } from './EntityContext.js';

// Supervision
export {
  Directive,
  OneForOneStrategy,
  AllForOneStrategy,
  defaultStrategy,
  stoppingStrategy,
  escalatingStrategy,
  decideBy,
  ActorInitializationError,
  DeathPactError,
} from './Supervision.js';
export type { Decider, SupervisorStrategy, StrategyOptions } from './Supervision.js';

// Runtime services
export { Scheduler } from './Scheduler.js';
export type { Cancellable } from './Scheduler.js';
export {
  Dispatchers,
  ImmediateDispatcher,
  MicrotaskDispatcher,
  ThroughputDispatcher,
} from './Dispatcher.js';
export type { Dispatcher, DispatcherErrorSink } from './Dispatcher.js';
export { EventStream } from './EventStream.js';
export { EventKey } from './EventKey.js';
export type { EventChannel, EventClass, KindOf } from './EventKey.js';
export { ConsoleLogger, NoopLogger, JsonLogger, LogLevel, DISPLAY_NAME_FIELD } from './Logger.js';
export type { Logger, JsonLogSink } from './Logger.js';
export { LogContext } from './LogContext.js';
export type { LogContextData, LogContextEntry } from './LogContext.js';



// System messages
export {
  PoisonPill,
  Kill,
  Terminated,
  ReceiveTimeout,
  DeadLetter,
  ActorLifecycleEvent,
  ActorStarted,
  ActorStopped,
  ActorRestarted,
  DispatcherError,
  ActorKilledError,
  AskTimeoutError,
} from './SystemMessages.js';

// Patterns — Success / Failure live in util/Try.js (already exported above).
export {
  pipeTo,
  after,
  retry,
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerTimeoutError,
  CircuitBreakerOptions,
  CircuitBreakerOptionsBuilder,
  exponentialBackoff,
  linearBackoff,
  BackoffSupervisor,
} from './pattern/index.js';
export type {
  PipeToOptions,
  CancellablePromise,
  RetryOptions,
  CircuitBreakerOptionsType,
  CircuitState,
  BackoffPolicy,
  ExponentialBackoffOptions,
  LinearBackoffOptions,
  BackoffOptions,
  ResetCounter,
  ForwardStrategy,
} from './pattern/index.js';
export {
  Router,
  Broadcast,
  roundRobinStrategy,
  randomStrategy,
  broadcastStrategy,
  smallestMailboxStrategy,
} from './Router.js';
export type { RoutingStrategy, RouterState } from './Router.js';
export {
  ScatterGatherOptions,
  ScatterGatherOptionsBuilder,
  ScatterGatherOptionsValidator,
} from './ScatterGatherOptions.js';
export type { ScatterGatherOptionsType } from './ScatterGatherOptions.js';


// Configuration (HOCON with code overrides).
export {
  Config,
  ConfigError,
  parseDuration,
  parseSize,
  parseHocon,
  resolveSubstitutions,
  deepMerge,
  REFERENCE_CONF,
} from './config/index.js';
export type { LoadOptions, ConfigObject, ConfigValue } from './config/index.js';


// Extensions mechanism.
export { Extensions, extensionId } from './Extension.js';
export type { Extension, ExtensionId } from './Extension.js';

// Coordinated Shutdown (phase-ordered graceful termination).
export {
  CoordinatedShutdown,
  CoordinatedShutdownId,
  Phases,
  Reason,
  UnknownReason,
  ActorSystemTerminateReason,
  ClusterLeavingReason,
  ClusterDowningReason,
  ProcessTerminateReason,
} from './CoordinatedShutdown.js';
export type { ShutdownTask, PhaseDefinition } from './CoordinatedShutdown.js';








// Mailboxes: the unbounded base (the default since #1148) and its variants.
export {
  Mailbox,
  BoundedMailbox,
  MailboxFullError,
  PriorityMailbox,
  BoundedMailboxOptions,
  BoundedMailboxOptionsBuilder,
  PriorityMailboxOptions,
  PriorityMailboxOptionsBuilder,
} from './mailbox/index.js';
export type {
  DropReportingMailbox,
  Envelope,
  MailboxDropReason,
  BoundedMailboxOptionsType,
  BoundedMailboxOverflow,
  PriorityMailboxOptionsType,
  PriorityFunction,
} from './mailbox/index.js';




// Typed Behaviors DSL (functional facade over the OO Actor API).
export {
  Behaviors,
  TypedActor,
  typedActor,
  same,
  stopped,
  unhandled,
  empty,
  ignore,
} from './typed/index.js';
export type {
  Behavior,
  BehaviorInterceptor,
  BehaviorInterceptorTarget,
  Signal,
  StashBuffer,
  TypedActorContext,
  ReceiveBehavior,
  SetupBehavior,
  WithTimersBehavior,
  WithStashBehavior,
  SuperviseBehavior,
  InterceptBehavior,
  SameBehavior,
  StoppedBehavior,
  UnhandledBehavior,
  EmptyBehavior,
  IgnoreBehavior,
  SuperviseBuilder,
  LogMessagesOptions,
} from './typed/index.js';

