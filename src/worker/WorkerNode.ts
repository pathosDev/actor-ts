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
    const g = globalThis as unknown as { self?: WorkerScope } & WorkerScope;
    const selfScope: WorkerScope = g.self ?? g;
    if (!selfScope) throw new Error('WorkerNode.join() must run inside a Worker');

    const post = selfScope.postMessage ?? g.postMessage;

    // ---- Phase 1: wait for the init frame from main. ----
    // We install the listener FIRST, then signal readiness via `hello`.
    const init = await new Promise<WorkerInitMessage>((resolve, reject) => {
      const onMsg = (e: { data: unknown }): void => {
        const data = e.data as Partial<WorkerInitMessage>;
        if (data && data.type === 'actor-ts.worker-init') {
          selfScope.onmessage = null;
          resolve(data as WorkerInitMessage);
        }
      };
      // Bun delivers worker→worker messages to `self.onmessage` (the DOM
      // property) even when addEventListener('message', …) is a no-op.  We
      // set `onmessage` directly so the init frame is seen reliably.
      selfScope.onmessage = onMsg;
      const hello: WorkerHelloMessage = { type: 'actor-ts.worker-hello' };
      post?.call(selfScope, hello);
      const t = setTimeout(
        () => reject(new Error('WorkerNode.join() timed out waiting for init')),
        30_000,
      );
      (t as { unref?: () => void }).unref?.();
    });

    const self = NodeAddress.fromJSON(init.self);

    // ---- Phase 2: build a PortLike that multiplexes over the worker's
    //      native postMessage channel.  We already share that channel
    //      with the init/hello/ready frames — filter by `type` so
    //      transport traffic doesn't collide with lifecycle frames. ----
    const transportPort = buildWorkerPort(selfScope, post);
    const transport = new MessageChannelTransport(self, transportPort);

    return {
      self,
      systemName: init.systemName,
      transport,
      initData: init.data as TInit,
      ready(): void {
        const msg: WorkerReadyMessage = { type: 'actor-ts.worker-ready', self: init.self };
        post?.call(selfScope, msg);
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
    const msg = e.data as { type?: string } | undefined;
    if (msg && msg.type === 'actor-ts.transport' && handler) {
      handler({ data: (msg as WorkerTransportMessage).envelope });
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
      const msg: WorkerTransportMessage = { type: 'actor-ts.transport', envelope };
      post?.call(selfScope, msg);
    },
    get onmessage() { return handler; },
    set onmessage(h: ((e: { data: unknown }) => void) | null) { handler = h; },
    close() { handler = null; },
  } as PortLike;
}
