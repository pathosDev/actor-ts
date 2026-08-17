/**
 * Child process for `tests/smoke/cases/28-graceful-shutdown-signals.mjs`.
 *
 * Deliberately a *separate process*: the thing under test installs process
 * signal handlers and then waits for one, so a case that signalled itself
 * would take the smoke harness down with it.
 *
 * It lives under `tests/smoke/fixtures/` rather than beside the case because
 * the runner imports every `cases/*.mjs` and requires an exported `run()` —
 * and it lives inside the repository at all because Deno resolves
 * `node_modules` from the *entry* file, so a copy written to a temp
 * directory could not import `ts-pattern` and would fail before reaching
 * anything worth testing.
 *
 * Argv: `<actor-ts entry URL> <mode>` where mode is `signal` (wait to be
 * signalled) or `self` (idle for a beat, then start the pipeline from inside
 * — the Windows path, where no POSIX signal can be delivered).  Reading argv
 * through `Deno.args` when it exists keeps this working without the node
 * compatibility shim.
 *
 * Protocol on stdout, one line each:
 *   READY            handlers installed, safe to signal
 *   ORDER a,b,c      the phases that ran, in order
 * Both what is printed and what is *not* carry the assertion.  A run that
 * stops after READY is a process that fell out of its own wait — nothing
 * referenced was left on the event loop, so it exited instead of waiting for
 * the signal.  Reaching the end of `runUntilTerminated()` and then exiting
 * *by itself* is what proves the handlers came back off — on Deno a listener
 * left armed holds the event loop open forever.
 */
const args = typeof Deno !== 'undefined' ? Deno.args : process.argv.slice(2);
const [entryUrl, mode] = args;

/**
 * How long `self` mode sits idle before starting the pipeline itself.
 *
 * Any positive value would do — the failure it exposes is an event loop that
 * empties on the very first tick, not one that empties slowly — so this is
 * sized to stay cheap in a suite that runs on three runtimes.
 */
const SELF_MODE_IDLE_MS = 250;

const {
  ActorSystem,
  ActorSystemOptions,
  CoordinatedShutdownId,
  LogLevel,
  NoopLogger,
  Phases,
} = await import(entryUrl);

const system = ActorSystem.create(
  'smoke-graceful-shutdown',
  ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
);

const coordinatedShutdown = system.extension(CoordinatedShutdownId);
const ran = [];
for (const phase of [
  Phases.ServiceUnbind,
  Phases.ServiceStop,
  Phases.ClusterLeave,
  Phases.BeforeActorSystemTerminate,
]) {
  coordinatedShutdown.addTask(phase, `record-${phase}`, () => { ran.push(phase); });
}

const running = system.runUntilTerminated();
console.log('READY');

if (mode === 'self') {
  // No signal is coming on this platform.  Start the same pipeline the
  // handler would have, so the ordering and the clean exit are still under
  // test — only the OS delivery step is skipped.
  //
  // The delay, and the `unref`, are the load-bearing part of that.  Running
  // the pipeline straight away keeps the event loop busy from the first tick
  // and so proves nothing about the *waiting* — which is exactly where the
  // runtimes disagree.  Node unrefs its signal handles, so a
  // `runUntilTerminated()` that holds nothing of its own lets the process
  // fall out from under the `await running` below and exit 13 before any
  // shutdown runs (#549).  An idle window in which every handle is
  // unreferenced is the only way this branch can see that, and it is the one
  // part of the signal path a Windows box can still exercise.
  unreferenceTimer(setTimeout(() => { void coordinatedShutdown.run(); }, SELF_MODE_IDLE_MS));
}

await running;
console.log(`ORDER ${ran.join(',')}`);

/**
 * Stop `timer` from keeping the process alive by itself.
 *
 * Two spellings, because the runtimes do not share one: Bun and Node hang an
 * `unref()` off the handle they return, Deno returns a bare numeric id and
 * takes `Deno.unrefTimer(id)` instead.
 */
function unreferenceTimer(timer) {
  if (typeof Deno !== 'undefined') {
    Deno.unrefTimer(timer);
    return;
  }
  timer.unref?.();
}
