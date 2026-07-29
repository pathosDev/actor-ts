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
 * That counter is per process, so a cluster built from *separate*
 * terminals would have every node claim 9333; the first free port in the
 * range is taken instead, the same way the cluster transport scans for
 * its own port.
 *
 * The bind interface is `127.0.0.1` unless `--devtools-host` says
 * otherwise — the flag for when the browser is not on the machine
 * running the example: a container, a VM, a WSL or remote dev box.
 * Naming a non-loopback host there *is* the deliberate act
 * `DevToolsOptions` asks for, so the harness pairs it with
 * `allowRemote`; DevTools then binds and warns that it is reachable
 * without auth, instead of refusing and leaving you to guess why.
 * Nothing beyond an example should be exposed that cheaply.
 *
 *   --devtools          enable (any shell)
 *   DEVTOOLS=1          enable (POSIX shells)
 *   --devtools-port=N   first port to use (default 9333)
 *   DEVTOOLS_PORT=N     same, via the environment
 *   --devtools-host=H   interface to bind (default 127.0.0.1)
 *   DEVTOOLS_HOST=H     same, via the environment
 */
import { concat, type ActorSystem } from '../src/index.js';
import type { Cluster } from '../src/cluster/Cluster.js';
import { DevTools, DevToolsOptions, isLoopbackHost, type DevToolsBinding } from '../src/devtools/index.js';

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

/**
 * How many ports the scan tries before giving up.
 *
 * Matches `MAX_NODE_SLOTS` in the cluster examples: however many nodes
 * you can start there, each of them can have DevTools.
 */
const PORT_SCAN_SLOTS = 16;

/** Per-attachment overrides. */
export interface AttachDevToolsOptions {
  /**
   * Fixed port instead of the next one from the shared counter.  Pass
   * `0` to let the operating system pick — the only workable choice
   * where the counter cannot help, e.g. worker threads, which each get
   * their own copy of this module and would otherwise all claim 9333.
   */
  readonly port?: number;
  /**
   * Cluster to inspect.  Without it the cluster panel reports itself as
   * unavailable — a system cannot hand out its own `Cluster`, so a
   * clustered example has to pass it, and after `Cluster.join` at that.
   */
  readonly cluster?: Cluster;
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
  const first = options.port ?? nextPort++;
  // An explicit port is an instruction, not a hint: honour it exactly so
  // a script that publishes "DevTools is on 9400" stays true.
  const slots = options.port === undefined ? PORT_SCAN_SLOTS : 1;
  const devtools = await attachScanning(system, options, readHost(), first, slots);
  if (devtools === null) return DISABLED;

  const url = browsableUrl(devtools.host, devtools.port);
  return {
    url,
    holdOpen: () => waitForInterrupt(url),
    detach: () => devtools.detach(),
  };
}

/**
 * Bind the first free port from `first`, or give up without DevTools.
 *
 * A cluster started from three terminals is three processes, each with
 * its own copy of the counter above and so each claiming 9333 — the
 * second and third have to move along, the same way the cluster
 * transport scans for its own port.
 *
 * The port is *probed* rather than attached-and-retried, because a
 * failed attach is not free: it has already spawned the DevTools hub,
 * whose actor name is then taken for as long as its termination takes to
 * settle, and the retry fails on that instead of the port.
 *
 * Whatever remains unsolved, the example still starts.  A debugger that
 * cannot bind is not a reason for the program under debug to die — which
 * is exactly what happened before: "voice backend failed to start: Is
 * port 9333 in use?".
 */
async function attachScanning(
  system: ActorSystem,
  options: AttachDevToolsOptions,
  host: string,
  first: number,
  slots: number,
): Promise<DevToolsBinding | null> {
  for (let offset = 0; offset < slots; offset++) {
    const port = first + offset;
    if (slots > 1 && !(await isPortFree(system, host, port))) continue;
    const devtoolsOptions = DevToolsOptions.create()
      .withHost(host)
      .withPort(port);
    // Asking for a non-loopback host on the command line is the opt-in
    // the validator wants; DevTools still logs what it exposes.
    if (!isLoopbackHost(host)) devtoolsOptions.withAllowRemote();
    if (options.cluster !== undefined) devtoolsOptions.withCluster(options.cluster);
    try {
      // No banner here: `DevTools.attach` already logs the URL it bound.
      const binding = await DevTools.attach(system, devtoolsOptions);
      // Leave the shared counter past what we took, so a second system
      // in this process does not probe this port again.
      if (options.port === undefined) nextPort = port + 1;
      return binding;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      system.log.warn(`DevTools not attached — continuing without it: ${reason}`);
      return null;
    }
  }
  system.log.warn(
    `DevTools not attached — continuing without it: ports ${first}-${first + slots - 1} `
    + `on ${host} are all in use`,
  );
  return null;
}

/**
 * Is this port free?
 *
 * Answered by binding it through the framework's own HTTP layer and
 * letting go again, so the check works the same on Bun, Node and Deno
 * instead of guessing at each runtime's `EADDRINUSE` wording.  An empty
 * route matches nothing, which is all a probe needs.
 *
 * The probe takes the same interface DevTools will: "free" is a property
 * of the pair, and a port taken on one interface can be free on another.
 */
async function isPortFree(system: ActorSystem, host: string, port: number): Promise<boolean> {
  try {
    const probe = await system.http(port, { host }).bind(concat());
    await probe.unbind();
    return true;
  } catch {
    return false;
  }
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

/**
 * Interface to bind — loopback unless asked otherwise.
 *
 * Unlike the port there is nothing to validate here beyond emptiness:
 * what a host string may say is the runtime's business, and a bind that
 * cannot happen is already handled — the example starts without
 * DevTools rather than dying.
 */
function readHost(): string {
  const raw = argumentValue('--devtools-host') ?? readEnvironment('DEVTOOLS_HOST');
  return raw === undefined || raw.trim() === '' ? '127.0.0.1' : raw.trim();
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
 * A URL that can be pasted into a browser.
 *
 * The binding reports the interface DevTools bound, which is the right
 * answer and the wrong link: a wildcard bind (`0.0.0.0`, `::`) is not an
 * address anything can open, and an IPv6 literal is not a URL until it
 * is bracketed.  Both are reachable over loopback from the machine that
 * ran the example, so that is what the example prints.
 */
function browsableUrl(host: string, port: number): string {
  if (host === '0.0.0.0') return `http://127.0.0.1:${port}`;
  if (host === '::' || host === '[::]') return `http://[::1]:${port}`;
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${port}`;
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
