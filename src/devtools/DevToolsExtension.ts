import type { ActorSystem } from '../ActorSystem.js';
import { CoordinatedShutdownId, Phases } from '../CoordinatedShutdown.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import type { Route } from '../http/index.js';
import {
  DEVTOOLS_DEFAULTS,
  DevToolsOptionsValidator,
  type DevToolsOptions,
  type DevToolsOptionsType,
} from './DevToolsOptions.js';
import { DevToolsServer, type DevToolsBinding } from './DevToolsServer.js';

/**
 * Per-system DevTools handle.
 *
 * Creating the extension does nothing observable — no port, no taps, no
 * instrumentation.  Everything starts at {@link attach}, which is what
 * keeps DevTools free for the systems that never ask for it.
 */
export class DevToolsExtension implements Extension {
  private server: DevToolsServer | null = null;
  private binding: DevToolsBinding | null = null;
  /** Shutdown wiring is per system, not per attachment — see below. */
  private shutdownHooksInstalled = false;

  constructor(private readonly system: ActorSystem) {}

  /** True once {@link attach} (or {@link mount}) has run. */
  isAttached(): boolean {
    return this.server !== null;
  }

  /**
   * Start DevTools on its own HTTP port.  Attaching twice returns the
   * existing binding — a duplicate call in a dev script should not take
   * the tooling down with an error.
   */
  async attach(options: DevToolsOptions = {}): Promise<DevToolsBinding> {
    if (this.binding !== null) {
      this.system.log.warn('DevTools is already attached; returning the existing binding');
      return this.binding;
    }
    const server = this.createServer(options);
    let bound: DevToolsBinding;
    try {
      bound = await server.bind();
    } catch (cause) {
      // A failed bind has to leave the system exactly as it was.  It did
      // not: the server stayed installed, so a caller retrying on
      // another port — which is what a second cluster node started from
      // its own terminal does — tripped over our own half-attachment
      // instead of the port conflict it was working around.
      await this.detach();
      throw cause;
    }
    // Route the handle's `detach` back through the extension so the
    // attachment state is cleared too — otherwise `isAttached()` would
    // keep reporting true and a later `attach()` would hand back a
    // binding whose port is long gone.
    this.binding = { ...bound, detach: () => this.detach() };
    return this.binding;
  }

  /**
   * Build the DevTools routes for mounting into an existing server
   * (next to the management endpoints, say) instead of taking a port
   * of their own.  The caller binds the returned routes.
   */
  mount(options: DevToolsOptions = {}): Route {
    if (this.server !== null) {
      throw new Error('DevTools is already attached on this ActorSystem');
    }
    const server = this.createServer(options);
    server.start();
    return server.routes();
  }

  /** Unbind and uninstall everything.  Safe to call when not attached. */
  async detach(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.binding = null;
    if (server) await server.stop();
  }

  private createServer(options: DevToolsOptions): DevToolsServer {
    const settings: DevToolsOptionsType = {
      ...DEVTOOLS_DEFAULTS,
      ...(options as Partial<DevToolsOptionsType>),
    };
    new DevToolsOptionsValidator().validate(settings);
    const server = new DevToolsServer(this.system, settings);
    this.server = server;
    this.installShutdownHooks();
    return server;
  }

  /**
   * Wire teardown into the system's lifetime, at most once.
   *
   * Both hooks call `detach()`, which is a no-op when nothing is
   * attached, so one registration covers every attachment this extension
   * ever makes.  Registering per attachment threw on the second one —
   * `addTask` rejects a duplicate name — which made attach/detach/attach
   * impossible and turned a retry after a port conflict into a different
   * error.
   */
  private installShutdownHooks(): void {
    if (this.shutdownHooksInstalled) return;
    this.shutdownHooksInstalled = true;
    // Tear down with the rest of the service layer, so a SIGTERM
    // releases the port and stops the taps instead of leaving a
    // half-instrumented system behind.
    this.system.extension(CoordinatedShutdownId).addTask(
      Phases.ServiceUnbind,
      'devtools-detach',
      () => this.detach(),
    );
    // `system.terminate()` does NOT run CoordinatedShutdown, so the task
    // above would never fire for the many programs that just terminate.
    // A debugger attached to a system that no longer exists is useless
    // and holds a port open, keeping the process alive forever — so
    // follow the system's own lifetime as well.
    void this.system.whenTerminated().then(() => this.detach());
  }
}

export const DevToolsExtensionId: ExtensionId<DevToolsExtension> = extensionId(
  'actor-ts/devtools',
  (system) => new DevToolsExtension(system),
);

/** Shortcut for `system.extension(DevToolsExtensionId)`. */
export function devtoolsOf(system: ActorSystem): DevToolsExtension {
  return system.extension(DevToolsExtensionId);
}
