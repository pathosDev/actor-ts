import { NodeAddress } from '../cluster/NodeAddress.js';
import {
  MessageChannelTransport,
  type BrokeredMessage,
  type PortLike,
} from '../cluster/transports/MessageChannelTransport.js';
import type { Transport } from '../cluster/Transport.js';
import { nodeWorkerScope, webWorkerScope, type WorkerScope } from '../runtime/worker/WorkerScope.js';
import type {
  WorkerHelloMessage,
  WorkerInitMessage,
  WorkerReadyMessage,
  WorkerTransportMessage,
} from './WorkerCluster.js';

export interface WorkerNodeContext<TInit = unknown> {
  readonly self: NodeAddress;
  readonly systemName: string;
  readonly transport: Transport;
  readonly initData: TInit;
  /**
   * Tell the main thread this node is up.  `data`, if given, rides on the
   * ready frame and lands on the main thread's `WorkerHandle.readyData` —
   * structured-cloneable only, like everything that crosses the channel.
   */
  ready(data?: unknown): void;
}

/**
 * Worker-side helper.  Call `await WorkerNode.join()` from **inside an
 * async function** (`async function main() { … } main();`), NOT as a
 * top-level `await`.  In Bun, top-level await inside a worker suspends
 * the module loader in a way that prevents incoming messages from
 * dispatching to `self.onmessage`, and the handshake hangs forever.
 *
 * Runs on every worker the framework can spawn: the Web Worker globals on
 * Bun and Deno, `parentPort` on Node's `worker_threads` — which has none of
 * those globals, and where this helper therefore never completed a handshake
 * before the runtime seam in `WorkerScope` existed (#1569).
 */
export const WorkerNode = {
  async join<TInit = unknown>(): Promise<WorkerNodeContext<TInit>> {
    // The Web Worker scope is found synchronously so the hello can go out in
    // this very turn; only the Node fallback needs an import.
    const scope = webWorkerScope() ?? await nodeWorkerScope();
    if (scope === null) throw new Error('WorkerNode.join() must run inside a Worker');

    // ---- Phase 1: wait for the init frame from main. ----
    // We install the listener FIRST, arm the timeout second, and only then
    // signal readiness via `hello` — so nothing the parent sends back can
    // arrive before both are in place.
    const init = await new Promise<WorkerInitMessage>((resolve, reject) => {
      /**
       * Hoisted so the success branch can cancel it.
       *
       * This used to lean on `unref()` alone, which is a Node/Bun extension:
       * Deno's `setTimeout` returns a plain number, so the optional call
       * `(timer as { unref?: () => void }).unref?.()` silently did nothing
       * there and the timer stayed referenced for its full 30 s.  A worker
       * that resolves `join()` and then wants to exit promptly — a short-lived
       * compute worker, or one whose bootstrap aborts after join — could not.
       * `clearTimeout` is the same call on all three runtimes, so cancelling
       * instead of unreferencing removes the dialect split rather than
       * papering over it (#778).
       *
       * Armed *before* the hello goes out, so it is always defined by the time
       * a reply could arrive.  That ordering is discipline rather than a guard,
       * and deliberately carries no test: `postMessage` cannot synchronously
       * re-enter the message handler on any runtime this framework targets, so
       * the reply lands a turn later at the earliest and the two statements
       * between them cannot interleave with anything.  A test that forced the
       * re-entrancy would be asserting against a runtime that does not exist.
       */
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onMessage = (data: unknown): void => {
        const frame = data as Partial<WorkerInitMessage> | null;
        if (frame && frame.kind === 'worker-init') {
          scope.offMessage(onMessage);
          if (timer !== undefined) clearTimeout(timer);
          resolve(frame as WorkerInitMessage);
        }
      };
      scope.onMessage(onMessage);
      timer = setTimeout(() => {
        scope.offMessage(onMessage);
        reject(new Error('WorkerNode.join() timed out waiting for init'));
      }, 30_000);
      const hello: WorkerHelloMessage = { kind: 'worker-hello' };
      scope.post(hello);
    });

    const self = NodeAddress.fromJSON(init.self);

    // ---- Phase 2: build a PortLike that multiplexes over the worker's
    //      native channel.  The same channel carries the init/hello/ready
    //      frames — filter by `kind` so transport traffic doesn't collide
    //      with lifecycle frames. ----
    const transportPort = buildWorkerPort(scope);
    const transport = new MessageChannelTransport(self, transportPort);

    return {
      self,
      systemName: init.systemName,
      transport,
      initData: init.data as TInit,
      ready(data?: unknown): void {
        const message: WorkerReadyMessage = data === undefined
          ? { kind: 'worker-ready', self: init.self }
          : { kind: 'worker-ready', self: init.self, data };
        scope.post(message);
      },
    };
  },
};

function buildWorkerPort(scope: WorkerScope): PortLike {
  let handler: ((e: { data: unknown }) => void) | null = null;
  const listener = (data: unknown): void => {
    const message = data as { kind?: string } | null;
    if (message && message.kind === 'worker-transport' && handler) {
      handler({ data: (message as WorkerTransportMessage).envelope });
    }
  };
  scope.onMessage(listener);
  return {
    postMessage(v: unknown) {
      const envelope: BrokeredMessage = v as BrokeredMessage;
      const message: WorkerTransportMessage = { kind: 'worker-transport', envelope };
      scope.post(message);
    },
    get onmessage() { return handler; },
    set onmessage(h: ((e: { data: unknown }) => void) | null) { handler = h; },
    close() {
      handler = null;
      scope.offMessage(listener);
    },
  } as PortLike;
}
