import { NodeAddress } from '../cluster/NodeAddress.js';
import {
  MessageChannelTransport,
  type BrokeredMessage,
  type PortLike,
} from '../cluster/transports/MessageChannelTransport.js';
import type { Transport } from '../cluster/Transport.js';
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
  ready(): void;
}

interface WorkerScope {
  addEventListener?(ev: string, h: (e: { data: unknown }) => void): void;
  removeEventListener?(ev: string, h: (e: { data: unknown }) => void): void;
  postMessage?(v: unknown): void;
  onmessage?: ((e: { data: unknown }) => void) | null;
}

/**
 * Worker-side helper.  Call `await WorkerNode.join()` from **inside an
 * async function** (`async function main() { … } main();`), NOT as a
 * top-level `await`.  In Bun, top-level await inside a worker suspends
 * the module loader in a way that prevents incoming messages from
 * dispatching to `self.onmessage`, and the handshake hangs forever.
 */
export const WorkerNode = {
  async join<TInit = unknown>(): Promise<WorkerNodeContext<TInit>> {
    const globalScope = globalThis as unknown as { self?: WorkerScope } & WorkerScope;
    const selfScope: WorkerScope = globalScope.self ?? globalScope;
    if (!selfScope) throw new Error('WorkerNode.join() must run inside a Worker');

    const post = selfScope.postMessage ?? globalScope.postMessage;

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
       * a reply could arrive.
       */
      let timer: ReturnType<typeof setTimeout> | undefined;
      // No origin check: this is a dedicated Worker / worker_threads message
      // handler, not window.postMessage.  Messages originate only from the
      // parent that spawned this worker, so `origin` is not applicable here
      // (CodeQL js/missing-origin-check — dismissed as a false positive).
      const onMessage = (e: { data: unknown }): void => {
        const data = e.data as Partial<WorkerInitMessage>;
        if (data && data.kind === 'worker-init') {
          selfScope.onmessage = null;
          if (timer !== undefined) clearTimeout(timer);
          resolve(data as WorkerInitMessage);
        }
      };
      // Bun delivers worker→worker messages to `self.onmessage` (the DOM
      // property) even when addEventListener('message', …) is a no-op.  We
      // set `onmessage` directly so the init frame is seen reliably.
      selfScope.onmessage = onMessage;
      timer = setTimeout(
        () => {
          // Defensive: a timer that has already fired needs no cancelling, but
          // this keeps the two exits from the promise symmetrical, so a later
          // edit cannot leave one of them holding a handle.
          if (timer !== undefined) clearTimeout(timer);
          reject(new Error('WorkerNode.join() timed out waiting for init'));
        },
        30_000,
      );
      const hello: WorkerHelloMessage = { kind: 'worker-hello' };
      post?.call(selfScope, hello);
    });

    const self = NodeAddress.fromJSON(init.self);

    // ---- Phase 2: build a PortLike that multiplexes over the worker's
    //      native postMessage channel.  We already share that channel
    //      with the init/hello/ready frames — filter by `kind` so
    //      transport traffic doesn't collide with lifecycle frames. ----
    const transportPort = buildWorkerPort(selfScope, post);
    const transport = new MessageChannelTransport(self, transportPort);

    return {
      self,
      systemName: init.systemName,
      transport,
      initData: init.data as TInit,
      ready(): void {
        const message: WorkerReadyMessage = { kind: 'worker-ready', self: init.self };
        post?.call(selfScope, message);
      },
    };
  },
};

function buildWorkerPort(
  selfScope: WorkerScope,
  post?: (v: unknown) => void,
): PortLike {
  let handler: ((e: { data: unknown }) => void) | null = null;
  const listener = (e: { data: unknown }): void => {
    const message = e.data as { kind?: string } | undefined;
    if (message && message.kind === 'worker-transport' && handler) {
      handler({ data: (message as WorkerTransportMessage).envelope });
    }
  };
  if (typeof selfScope.addEventListener === 'function') {
    selfScope.addEventListener('message', listener);
  } else {
    const prev = selfScope.onmessage;
    selfScope.onmessage = (e) => {
      listener(e);
      prev?.(e);
    };
  }
  return {
    postMessage(v: unknown) {
      const envelope: BrokeredMessage = v as BrokeredMessage;
      const message: WorkerTransportMessage = { kind: 'worker-transport', envelope };
      post?.call(selfScope, message);
    },
    get onmessage() { return handler; },
    set onmessage(h: ((e: { data: unknown }) => void) | null) { handler = h; },
    close() { handler = null; },
  } as PortLike;
}
