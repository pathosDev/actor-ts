import type { ActorSystem } from '../ActorSystem.js';
import type { Route } from '../http/index.js';
import type { DevToolsOptions } from './DevToolsOptions.js';
import { devtoolsOf } from './DevToolsExtension.js';
import type { DevToolsBinding } from './DevToolsServer.js';

/**
 * Entry point of the DevTools suite (#445).
 *
 *     import { DevTools, DevToolsOptions } from 'actor-ts/devtools';
 *
 *     const devtoolsOptions = DevToolsOptions.create().withPort(9333);
 *     const devtools = await DevTools.attach(system, devtoolsOptions);
 *     console.log(devtools.url);   // http://127.0.0.1:9333
 *
 * DevTools binds loopback and stays unauthenticated by default, which
 * is right for a laptop and wrong for anything else: it can read every
 * actor's class and mailbox, and — once the time-travel panel lands —
 * persisted events too.  Treat the port like a debugger port.  Binding
 * a routable interface requires `auth`, `ipAllowlist`, or an explicit
 * `allowRemote` acknowledgement; see `DevToolsOptions`.
 */
export class DevTools {
  private constructor() {}

  /** Start DevTools on its own port and return the browser URL. */
  static attach(system: ActorSystem, options: DevToolsOptions = {}): Promise<DevToolsBinding> {
    return devtoolsOf(system).attach(options);
  }

  /**
   * Build the DevTools routes for an existing server instead of taking
   * a port.  The caller binds them — usually behind the same auth as
   * the management endpoints.
   */
  static mount(system: ActorSystem, options: DevToolsOptions = {}): Route {
    return devtoolsOf(system).mount(options);
  }

  /** Unbind and uninstall.  Safe when DevTools was never attached. */
  static detach(system: ActorSystem): Promise<void> {
    return devtoolsOf(system).detach();
  }
}
