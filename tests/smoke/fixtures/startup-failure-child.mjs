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
 * Three modes, because they prove different things:
 *
 *   uncaught     `main` awaits and catches nothing, so the runtime reports
 *                the rejection and exits non-zero.  Proves the error reaches
 *                the top-level `await` — but an uncaught error ends the
 *                process whatever is still on its event loop, so it cannot see
 *                a handle left behind.
 *   caught       `main` catches, prints the message and sets the exit code
 *                itself.  Now nothing ends the process but an empty event
 *                loop, so a keep-alive that was never released — or a Deno
 *                signal listener that was never removed — hangs it.
 *   persistence  As `caught`, but no startup task is the application's: a
 *                SQLite journal is wired through the `plugins` slot and
 *                selected in the configuration, on a path that cannot be
 *                opened, and the framework's own warm-up is what fails the
 *                startup.  Proves a store that cannot open at boot ends the
 *                process — and that its failed open leaves nothing behind.
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
 * the `caught` and `persistence` modes `CAUGHT <message>`.  `RESOLVED` is
 * never meant to print.
 */
const args = typeof Deno !== 'undefined' ? Deno.args : process.argv.slice(2);
const [entryUrl, mode] = args;

/** What the catching modes exit with: distinct from the 1 an uncaught error gives. */
const CAUGHT_EXIT_CODE = 3;

const {
  ActorSystem,
  ActorSystemOptions,
  CoordinatedStartupOptions,
  LogLevel,
  NoopLogger,
  StartupPhases,
} = await import(entryUrl);

const systemOptions = mode === 'persistence' ? await unopenableJournalOptions() : failingTaskOptions();
const system = ActorSystem.create('smoke-startup-failure', systemOptions);
console.log('CREATED');

if (mode === 'uncaught') {
  await system.runUntilTerminated();
  console.log('RESOLVED');
} else {
  try {
    await system.runUntilTerminated();
    console.log('RESOLVED');
  } catch (error) {
    console.log(`CAUGHT ${error.message}`);
    setExitCode(CAUGHT_EXIT_CODE);
  }
}

function quietOptions() {
  return ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
}

/** The `uncaught` and `caught` modes: a startup task of the application's that fails. */
function failingTaskOptions() {
  const startupOptions = CoordinatedStartupOptions.create().withTasks([
    {
      phase: StartupPhases.PersistenceStart,
      name: 'smoke-open-journal',
      task: async () => { throw new Error('the journal refused the connection'); },
    },
  ]);
  return quietOptions().withCoordinatedStartup(startupOptions);
}

/**
 * The `persistence` mode: a SQLite journal registered through the `plugins`
 * slot and selected in the configuration, on a path whose parent is this
 * file rather than a directory — so the open fails the same way on every
 * runtime and operating system, and creates nothing on disk.
 */
async function unopenableJournalOptions() {
  const persistenceEntry = new URL(
    entryUrl.endsWith('.ts') ? './persistence/index.ts' : './persistence/index.js',
    entryUrl,
  ).href;
  const {
    RegisterSqlitePluginsOptions,
    SQLITE_JOURNAL_PLUGIN_ID,
    SqliteJournalOptions,
    registerSqlitePlugins,
  } = await import(persistenceEntry);
  const journalOptions = SqliteJournalOptions.create().withPath(`${ownPath()}/journal.db`);
  const sqliteOptions = RegisterSqlitePluginsOptions.create().withJournal(journalOptions);
  return quietOptions()
    .withConfig({ 'actor-ts': { persistence: { journal: { plugin: SQLITE_JOURNAL_PLUGIN_ID } } } })
    .withPersistence({ plugins: [(persistence) => registerSqlitePlugins(persistence, sqliteOptions)] });
}

/** This file's path, without a `node:url` import. */
function ownPath() {
  const path = decodeURIComponent(new URL(import.meta.url).pathname);
  // Windows file URLs arrive as `/C:/…`; the leading slash is not part of it.
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}

/** Bun and Node read `process.exitCode`; Deno has its own. */
function setExitCode(code) {
  if (typeof Deno !== 'undefined') {
    Deno.exitCode = code;
    return;
  }
  process.exitCode = code;
}
