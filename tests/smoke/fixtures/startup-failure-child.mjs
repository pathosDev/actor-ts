/**
 * Child process for `tests/smoke/cases/46-startup-failure-exit.mjs` (#1473).
 *
 * The whole of a service's `main`, with a startup task that fails: build the
 * system, then await `runUntilTerminated()` — no `process.exit`, no timer.
 * What is under test is that this ordinary shape ends by itself, with a
 * non-zero status, on every runtime: the failure has to take the system down,
 * the wait has to give back its keep-alive and its signal handlers, and the
 * error has to reach `main`.  A process that stays up after a failed startup
 * is the failure mode, and only a separate process can show it.
 *
 * Two modes, because they prove different things:
 *
 *   uncaught  `main` awaits and catches nothing, so the runtime reports the
 *             rejection and exits non-zero.  Proves the error reaches the
 *             top-level `await` — but an uncaught error ends the process
 *             whatever is still on its event loop, so it cannot see a handle
 *             left behind.
 *   caught    `main` catches, prints the message and sets the exit code
 *             itself.  Now nothing ends the process but an empty event loop,
 *             so a keep-alive that was never released — or a Deno signal
 *             listener that was never removed — hangs it.
 *
 * It lives under `tests/smoke/fixtures/` for the reasons the graceful-shutdown
 * child gives: the runner imports every `cases/*.mjs` and requires a `run()`,
 * and Deno resolves `node_modules` from the entry file, so a copy written to a
 * temp directory could not import the framework.
 *
 * Argv: `<actor-ts entry URL> <mode>`, read through `Deno.args` when it exists.
 *
 * Protocol on stdout: `CREATED` once `ActorSystem.create` has returned, which
 * tells "the startup failed" apart from "the child never got that far", and in
 * `caught` mode `CAUGHT <message>`.  `RESOLVED` is never meant to print.
 */
const args = typeof Deno !== 'undefined' ? Deno.args : process.argv.slice(2);
const [entryUrl, mode] = args;

/** What `caught` mode exits with: distinct from the 1 an uncaught error gives. */
const CAUGHT_EXIT_CODE = 3;

const {
  ActorSystem,
  ActorSystemOptions,
  CoordinatedStartupOptions,
  LogLevel,
  NoopLogger,
  StartupPhases,
} = await import(entryUrl);

const startupOptions = CoordinatedStartupOptions.create().withTasks([
  {
    phase: StartupPhases.PersistenceStart,
    name: 'smoke-open-journal',
    task: async () => { throw new Error('the journal refused the connection'); },
  },
]);
const systemOptions = ActorSystemOptions.create()
  .withLogger(new NoopLogger())
  .withLogLevel(LogLevel.Off)
  .withCoordinatedStartup(startupOptions);
const system = ActorSystem.create('smoke-startup-failure', systemOptions);
console.log('CREATED');

if (mode === 'caught') {
  try {
    await system.runUntilTerminated();
    console.log('RESOLVED');
  } catch (error) {
    console.log(`CAUGHT ${error.message}`);
    setExitCode(CAUGHT_EXIT_CODE);
  }
} else {
  await system.runUntilTerminated();
  console.log('RESOLVED');
}

/** Bun and Node read `process.exitCode`; Deno has its own. */
function setExitCode(code) {
  if (typeof Deno !== 'undefined') {
    Deno.exitCode = code;
    return;
  }
  process.exitCode = code;
}
