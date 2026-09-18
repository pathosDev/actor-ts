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
// Function-level offload (#1558): the pool, its options, the task naming and
// the errors a run can reject with.  `defineOffloadTask` and the extension id
// are on the package root too, because `context.offload` is the common door.
export { OffloadPool, OffloadExtension, OffloadExtensionId } from './OffloadPool.js';
export type { OffloadRunOptions } from './OffloadPool.js';
export {
  OffloadPoolOptions,
  OffloadPoolOptionsBuilder,
  OffloadPoolOptionsValidator,
  readOffloadPoolOptionsFromConfig,
  DEFAULT_OFFLOAD_POOL_SIZE,
  DEFAULT_OFFLOAD_MIN_SIZE,
  DEFAULT_OFFLOAD_MAX_QUEUE,
  DEFAULT_OFFLOAD_OVERFLOW,
  DEFAULT_OFFLOAD_IDLE_TIMEOUT_MS,
  DEFAULT_OFFLOAD_TASK_TIMEOUT_MS,
  DEFAULT_OFFLOAD_WARM_UP,
} from './OffloadPoolOptions.js';
export type { OffloadPoolOptionsType, OffloadOverflow } from './OffloadPoolOptions.js';
export {
  defineOffloadTask,
  OffloadTaskError,
  OffloadArgumentsError,
  OffloadQueueFullError,
  OffloadTimeoutError,
  OffloadAbortedError,
  OffloadWorkerLostError,
  OffloadPoolUnavailableError,
} from './OffloadTask.js';
export type {
  OffloadTask,
  OffloadRunMessage,
  OffloadResultMessage,
  OffloadErrorMessage,
  OffloadReadyMessage,
  OffloadWireMessage,
} from './OffloadTask.js';
export { serveOffload } from './OffloadWorkerBootstrap.js';
export type { OffloadModuleImporter } from './OffloadWorkerBootstrap.js';
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
