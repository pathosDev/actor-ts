/**
 * Shared DevTools wiring for the examples.
 *
 * Every example can be inspected in the DevTools UI, but none of them
 * pay for it by default:
 *
 *     bun run examples/hello-world.ts              # unchanged
 *     bun run examples/hello-world.ts --devtools   # + http://127.0.0.1:9333
 *
 * The `--devtools` argument works in every shell.  `DEVTOOLS=1` does the
 * same on a POSIX shell, but `VAR=value command` is a parser error in
 * PowerShell — which is most Windows contributors — so the flag is the
 * form worth leading with.
 *
 * Most examples are scripts that finish in a few hundred milliseconds —
 * far too fast to open a browser.  {@link ExampleDevTools.holdOpen}
 * solves that: when enabled it parks the example just before shutdown so
 * you can actually look at it, and when not it returns immediately,
 * leaving the example's timing exactly as it was.
 *
 * Multi-system examples (cluster demos, two-node persistence) call
 * `attachDevTools` per system and each gets its own port, counting up
 * from `DEVTOOLS_PORT` — so a three-node cluster is 9333, 9334, 9335.
 *
 *   --devtools          enable (any shell)
 *   DEVTOOLS=1          enable (POSIX shells)
 *   --devtools-port=N   first port to use (default 9333)
 *   DEVTOOLS_PORT=N     same, via the environment
 */
import type { ActorSystem } from '../src/index.js';
import { DevTools, DevToolsOptions } from '../src/devtools/index.js';

/** Handle returned by {@link attachDevTools}; inert when DevTools is off. */
export interface ExampleDevTools {
  /** Browser URL, or `null` when DevTools was not enabled. */
  readonly url: string | null;
  /**
   * Keep the example alive while you look at it.  Resolves immediately
   * unless DevTools is attached; otherwise waits for Ctrl+C.
   */
  holdOpen(): Promise<void>;
  /** Release the port.  Safe when DevTools was never attached. */
  detach(): Promise<void>;
}

const DISABLED: ExampleDevTools = {
  url: null,
  holdOpen: () => Promise.resolve(),
  detach: () => Promise.resolve(),
};

/** Next port to hand out — bumped per attachment within one process. */
let nextPort = 0;

/** Per-attachment overrides. */
export interface AttachDevToolsOptions {
  /**
   * Fixed port instead of the next one from the shared counter.  Pass
   * `0` to let the operating system pick — the only workable choice
   * where the counter cannot help, e.g. worker threads, which each get
   * their own copy of this module and would otherwise all claim 9333.
   */
  readonly port?: number;
}

/**
 * Attach DevTools to `system` when the `DEVTOOLS` environment variable
 * is set.  Returns a handle that does nothing when it is not.
 */
export async function attachDevTools(
  system: ActorSystem,
  options: AttachDevToolsOptions = {},
): Promise<ExampleDevTools> {
  if (!isEnabled()) return DISABLED;

  if (nextPort === 0) nextPort = readPort();
  const port = options.port ?? nextPort++;
  const devtoolsOptions = DevToolsOptions.create().withPort(port);
  const devtools = await DevTools.attach(system, devtoolsOptions);

  console.log(`[devtools] ${system.name} → ${devtools.url}`);
  return {
    url: devtools.url,
    holdOpen: () => waitForInterrupt(devtools.url),
    detach: () => devtools.detach(),
  };
}

function isEnabled(): boolean {
  // The argument first: it is the form that works in every shell.
  if (commandLineArguments().includes('--devtools')) return true;
  const flag = readEnvironment('DEVTOOLS');
  return flag !== undefined && flag !== '' && flag !== '0' && flag.toLowerCase() !== 'false';
}

function readPort(): number {
  const raw = argumentValue('--devtools-port') ?? readEnvironment('DEVTOOLS_PORT');
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 9333;
}

/** `--devtools-port=9400` or `--devtools-port 9400`. */
function argumentValue(name: string): string | undefined {
  const argv = commandLineArguments();
  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** Command-line arguments on Bun, Node and Deno alike. */
function commandLineArguments(): ReadonlyArray<string> {
  const scope = globalThis as {
    process?: { argv?: string[] };
    Deno?: { args?: string[] };
  };
  return scope.Deno?.args ?? scope.process?.argv?.slice(2) ?? [];
}

/** Read an environment variable on Bun, Node and Deno alike. */
function readEnvironment(name: string): string | undefined {
  const scope = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    Deno?: { env?: { get(key: string): string | undefined } };
  };
  return scope.process?.env?.[name] ?? scope.Deno?.env?.get(name);
}

/**
 * Park until the user interrupts.  Examples run in a terminal, so
 * Ctrl+C is the natural "I'm done looking" signal; the promise resolves
 * rather than exiting so the example still runs its own shutdown.
 */
function waitForInterrupt(url: string): Promise<void> {
  console.log(`[devtools] holding ${url} open — press Ctrl+C to continue shutdown`);
  return new Promise<void>((resolve) => {
    const scope = globalThis as {
      process?: { once(event: string, listener: () => void): unknown };
    };
    if (scope.process?.once === undefined) {
      // No signal handling available — do not hang the example forever.
      resolve();
      return;
    }
    scope.process.once('SIGINT', () => resolve());
  });
}
