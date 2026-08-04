import type { LogContextData } from '../LogContext.js';
import { DISPLAY_NAME_FIELD, LogLevel, type Logger } from '../Logger.js';

/**
 * A `Logger` that stamps {@link DISPLAY_NAME_FIELD} on every record, with
 * the name resolved per call instead of baked in at construction (#891).
 *
 * Late resolution is what makes the feature work at all.  `ActorCell`
 * binds its logger in the constructor, but the user's `Actor` does not
 * exist until the factory runs — and once it does, `displayName()` may
 * read state `preStart` set up, and is a different method on a different
 * instance after a restart.  A closure answers correctly at every one of
 * those points; an eagerly bound string cannot, and would need a rebind
 * at each lifecycle transition to even try.
 *
 * Cost: the base logger's level is checked *before* anything else, so a
 * filtered-out call — and every call on a `NoopLogger`, whose level is
 * `Off` — returns without touching the resolver.  Above the level the
 * derived logger is memoised on the last resolved name, so a stable name
 * costs one string comparison per record.
 *
 * @internal Wiring for `ActorCell`, not a public extension point: the
 * contract on `resolve` (cheap, pure, called on the logging path) is only
 * satisfiable from inside the runtime.  A user who wants a dynamic source
 * implements `Logger` directly.
 */
export class DisplayNameLogger implements Logger {
  /** Last name seen, or `null` before the first record. */
  private lastName: string | null = null;
  private derived: Logger | null = null;

  constructor(
    /** Already bound to the actor's path — the display name adds to it, never replaces it. */
    private readonly base: Logger,
    private readonly resolve: () => string,
  ) {}

  /**
   * Read through rather than snapshot: `ConsoleLogger.level` is a mutable
   * public field, so a copy taken at construction would freeze out a
   * level raised later.
   */
  get level(): LogLevel { return this.base.level; }

  private enabled(target: LogLevel): boolean { return target >= this.base.level; }

  /**
   * The logger to emit through.  An empty name yields the base logger
   * unchanged, which is what keeps a non-overriding actor's output
   * byte-identical to the pre-#891 format.
   *
   * The `try` is belt and braces — `ActorCell` already guards the hook and
   * owns the warning.  Swallowing here rather than warning again keeps one
   * broken override to one warning instead of one per record.
   */
  private current(): Logger {
    let name: string;
    try {
      const resolved = this.resolve();
      name = typeof resolved === 'string' ? resolved : '';
    } catch {
      name = '';
    }
    if (name !== this.lastName || this.derived === null) {
      this.lastName = name;
      this.derived = name === '' ? this.base : this.base.withFields({ [DISPLAY_NAME_FIELD]: name });
    }
    return this.derived;
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.enabled(LogLevel.Debug)) this.current().debug(message, ...args);
  }
  info(message: string, ...args: unknown[]): void {
    if (this.enabled(LogLevel.Info)) this.current().info(message, ...args);
  }
  warn(message: string, ...args: unknown[]): void {
    if (this.enabled(LogLevel.Warn)) this.current().warn(message, ...args);
  }
  error(message: string, ...args: unknown[]): void {
    if (this.enabled(LogLevel.Error)) this.current().error(message, ...args);
  }

  /**
   * Both derivations fold into the *base* and stay dynamic: an actor
   * writing `this.log.withFields({ orderId })` must not lose its display
   * name in the bargain, and re-sourcing a logger says nothing about
   * whose it is.
   */
  withSource(source: string): Logger {
    return new DisplayNameLogger(this.base.withSource(source), this.resolve);
  }

  withFields(fields: LogContextData): Logger {
    return new DisplayNameLogger(this.base.withFields(fields), this.resolve);
  }
}
