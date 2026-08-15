/**
 * ProcessSignal — the POSIX signal names a process can be told to handle.
 *
 * A verbatim mirror of `NodeJS.Signals`, kept here so the published
 * declarations do not need `@types/node` to be readable.  The type reaches
 * the public API through `CoordinatedShutdown.installProcessHooks`,
 * `ProcessTerminateReason.signal` and
 * `ClusterBootstrapOptionsType.shutdownOnSignals`; referencing the `NodeJS`
 * namespace from any of those made `@types/node` a silent requirement for
 * every consumer type-checking with `skipLibCheck: false`, while the
 * manifest declared it only as a devDependency (#1006).
 *
 * The member list is deliberately identical rather than trimmed to the
 * handful the framework installs by default.  An identical union is
 * assignable in both directions, so a caller already holding a
 * `NodeJS.Signals` value keeps compiling, and `process.on(signal, …)` still
 * accepts what we pass it.  Trimming would have made this a breaking change
 * for no benefit.
 *
 * Lives in `src/util/` because both the root (`CoordinatedShutdown`) and
 * `src/cluster/` read it, and `src/util/` is the one module with no outward
 * import — so depending on it couples no subsystem to another.
 *
 * Keep in step with `@types/node` if a future release adds a signal; the
 * devDependency is what would surface the drift.
 */
export type ProcessSignal =
  | 'SIGABRT'
  | 'SIGALRM'
  | 'SIGBUS'
  | 'SIGCHLD'
  | 'SIGCONT'
  | 'SIGFPE'
  | 'SIGHUP'
  | 'SIGILL'
  | 'SIGINT'
  | 'SIGIO'
  | 'SIGIOT'
  | 'SIGKILL'
  | 'SIGPIPE'
  | 'SIGPOLL'
  | 'SIGPROF'
  | 'SIGPWR'
  | 'SIGQUIT'
  | 'SIGSEGV'
  | 'SIGSTKFLT'
  | 'SIGSTOP'
  | 'SIGSYS'
  | 'SIGTERM'
  | 'SIGTRAP'
  | 'SIGTSTP'
  | 'SIGTTIN'
  | 'SIGTTOU'
  | 'SIGUNUSED'
  | 'SIGURG'
  | 'SIGUSR1'
  | 'SIGUSR2'
  | 'SIGVTALRM'
  | 'SIGWINCH'
  | 'SIGXCPU'
  | 'SIGXFSZ'
  | 'SIGBREAK'
  | 'SIGLOST'
  | 'SIGINFO';
