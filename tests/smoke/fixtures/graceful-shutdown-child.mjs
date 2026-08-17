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
 * signalled) or `self` (start the pipeline from inside — the Windows path,
 * where no POSIX signal can be delivered).  Reading argv through `Deno.args`
 * when it exists keeps this working without the node compatibility shim.
 *
 * Protocol on stdout, one line each:
 *   READY            handlers installed, safe to signal
 *   ORDER a,b,c      the phases that ran, in order
 * The exit code is the other half of the assertion: reaching the end of
 * `runUntilTerminated()` and exiting *by itself* is what proves the signal
 * handlers came back off — on Deno a listener left armed holds the event
 * loop open forever.
 */
const args = typeof Deno !== 'undefined' ? Deno.args : process.argv.slice(2);
const [entryUrl, mode] = args;

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
  void coordinatedShutdown.run();
}

await running;
console.log(`ORDER ${ran.join(',')}`);
