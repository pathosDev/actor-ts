export { WorkerCluster } from './WorkerCluster.js';
export { WorkerClusterOptions, WorkerClusterOptionsBuilder, WorkerClusterOptionsValidator } from './WorkerClusterOptions.js';
export type { WorkerClusterOptionsType, WorkerPermanentlyDownInfo } from './WorkerClusterOptions.js';
// Part of the public options shape (`backend`), so it has to be nameable
// from the package root — otherwise the emitted declarations reference a
// type consumers cannot import.  The rest of the runtime seam's vocabulary
// goes with it: a custom `WorkerBackend` has to implement `WorkerLike` and
// speak `WorkerEventMap`, and neither was importable from anywhere (#1288).
export type {
  WorkerBackend,
  WorkerLike,
  WorkerEventMap,
  WorkerMessageEvent,
  WorkerCloseEvent,
  WorkerErrorEvent,
  WorkerSpawnOptions,
} from '../runtime/worker/index.js';
export type {
  WorkerHandle,
  WorkerHelloMessage,
  WorkerInitMessage,
  WorkerReadyMessage,
  RestartPolicy,
} from './WorkerCluster.js';
export { WorkerNode } from './WorkerNode.js';
export type { WorkerNodeContext } from './WorkerNode.js';
export { WorkerBroker } from './WorkerBroker.js';
// The main thread as a member of its own mesh (#1562).
export { WorkerMesh } from './WorkerMesh.js';
export type { WorkerMeshWorker } from './WorkerMesh.js';
export { WorkerMeshOptions, WorkerMeshOptionsBuilder, WorkerMeshOptionsValidator } from './WorkerMeshOptions.js';
export type { WorkerMeshOptionsType } from './WorkerMeshOptions.js';
export { runWorkerMeshNode } from './WorkerMeshBootstrap.js';
export type {
  WorkerMeshInitData,
  WorkerMeshReadyData,
  WorkerMeshSetupContext,
  WorkerMeshSetupModule,
  WorkerActorClass,
} from './WorkerMeshBootstrap.js';
