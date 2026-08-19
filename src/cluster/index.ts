// Cluster entry points.
export { Cluster, inMemoryTransport } from './Cluster.js';
export { ClusterExtension, ClusterExtensionId, clusterOf } from './ClusterExtension.js';
export {
  CLUSTER_MEMBERSHIP_CHECK_NAME,
  CLUSTER_TRANSPORT_CHECK_NAME,
  clusterMembershipResult,
  clusterTransportResult,
  registerClusterHealthChecks,
  selfIsFullMember,
  transportReachesCluster,
} from './ClusterHealthChecks.js';
export { ClusterOptions, ClusterOptionsBuilder, ClusterOptionsValidator } from './ClusterOptions.js';
export type { ClusterOptionsType, SelfElectionPolicy } from './ClusterOptions.js';
export { bootstrapCluster } from './ClusterBootstrap.js';
export { ClusterBootstrapOptions, ClusterBootstrapOptionsBuilder, ClusterBootstrapOptionsValidator } from './ClusterBootstrapOptions.js';
export type { ClusterBootstrapOptionsType } from './ClusterBootstrapOptions.js';
export type { BootstrappedCluster } from './ClusterBootstrap.js';

// Stable-observation bootstrap (#148).
export {
  StableObservation,
  StableObservationError,
  StableObservationOptions,
  StableObservationOptionsBuilder,
  StableObservationOptionsValidator,
  readStableObservationOptionsFromConfig,
  isWildcardHost,
} from './bootstrap/index.js';
export type {
  JoinTargets,
  StableObservationOptionsType,
  StableObservationTuning,
  StableObservationConfigDefaults,
} from './bootstrap/index.js';

export { NodeAddress } from './NodeAddress.js';
export type { NodeAddressData } from './NodeAddress.js';

export { Member } from './Member.js';
export type { MemberData, MemberStatus, WireMessage } from './Protocol.js';

export {
  SelfUp,
  SelfRemoved,
  LeaderChanged,
  CurrentClusterState,
  MemberJoined,
  MemberUp,
  MemberWeaklyUp,
  MemberUnreachable,
  MemberReachable,
  ReachabilityChanged,
  MemberDown,
  MemberLeft,
  MemberRemoved,
  ShardMapChanged,
} from './ClusterEvents.js';
export type { ClusterEvent } from './ClusterEvents.js';
export type { ClusterSubscriptionReplayMode } from './Cluster.js';

export { RemoteActorRef } from './RemoteActorRef.js';

export { InMemoryTransport, TcpTransport } from './Transport.js';
export type { Transport, WireHandler, TlsTransportOptionsType } from './Transport.js';
export { MessageChannelTransport } from './transports/MessageChannelTransport.js';
export type { PortLike, BrokeredMessage } from './transports/MessageChannelTransport.js';

export {
  FailureDetector,
  defaultFailureDetectorOptions,
} from './FailureDetector.js';
export { FailureDetectorOptions, FailureDetectorOptionsBuilder, FailureDetectorOptionsValidator } from './FailureDetectorOptions.js';
export type { FailureDetectorOptionsType } from './FailureDetectorOptions.js';
export type { FailureDecision } from './FailureDetector.js';
export {
  PhiAccrualFailureDetector,
  defaultPhiAccrualOptions,
} from './PhiAccrualFailureDetector.js';
export { PhiAccrualOptions, PhiAccrualOptionsBuilder, PhiAccrualOptionsValidator } from './PhiAccrualOptions.js';
export type { PhiAccrualOptionsType } from './PhiAccrualOptions.js';

// Split-Brain Resolver strategies.
export {
  KeepMajority,
  KeepOldest,
  KeepOldestOptions,
  KeepOldestOptionsBuilder,
  StaticQuorum,
  StaticQuorumOptions,
  StaticQuorumOptionsBuilder,
  KeepReferee,
  KeepRefereeOptions,
  KeepRefereeOptionsBuilder,
  KeepMajorityOptions,
  KeepMajorityOptionsBuilder,
  LeaseMajority,
  LeaseMajorityOptions,
  LeaseMajorityOptionsBuilder,
} from './downing/index.js';
export type {
  DowningProvider,
  DowningDecision,
  ClusterPartitionView,
  KeepMajorityOptionsType,
  KeepOldestOptionsType,
  StaticQuorumOptionsType,
  KeepRefereeOptionsType,
  LeaseMajorityOptionsType,
} from './downing/index.js';

// Cluster Singleton.
export {
  ClusterSingleton,
  ClusterSingletonId,
  ClusterSingletonManager,
  ClusterSingletonProxy,
  ClusterSingletonManagerOptions,
  ClusterSingletonManagerOptionsBuilder,
  ClusterSingletonManagerOptionsValidator,
  StartSingletonOptions,
  StartSingletonOptionsBuilder,
  StartSingletonOptionsValidator,
  SingletonKey,
  singletonKeyOf,
  singletonManagerPath,
  asWarmHandOverActor,
  handOverStateFitsFrame,
} from './singleton/index.js';
export type {
  StartSingletonOptionsType,
  SingletonActorClass,
  SingletonKeyedClass,
  SingletonReference,
  ClusterSingletonManagerOptionsType,
  SingletonDeliver,
  WarmHandOverActor,
} from './singleton/index.js';

// Distributed Pub-Sub.
export {
  DistributedPubSub,
  DistributedPubSubId,
  DistributedPubSubMediator,
  DistributedPubSubOptions,
  DistributedPubSubOptionsBuilder,
  mediatorPath,
  CurrentTopics,
  GetTopics,
  Publish,
  Subscribe,
  SubscribeAcknowledgment,
  SubscribeRejected,
  Unsubscribe,
  UnsubscribeAcknowledgment,
  UnsubscribeAll,
} from './pubsub/index.js';
export type {
  DistributedPubSubOptionsType,
  PubSubDelivery,
  PubSubSubscriberRef,
  PubSubSubscribeRejectionReason,
} from './pubsub/index.js';

// Sharding.
export { ClusterSharding } from './sharding/ClusterSharding.js';
export { StartShardingOptions, StartShardingOptionsBuilder, StartShardingOptionsValidator } from './sharding/StartShardingOptions.js';
export type { StartShardingOptionsType } from './sharding/StartShardingOptions.js';
export { ShardKey, shardKeyOf } from './sharding/ShardKey.js';
export type { ShardEntityClass, ShardKeyedClass, ShardReference } from './sharding/ShardKey.js';
export { ShardedDaemonProcess } from './sharding/ShardedDaemonProcess.js';
export { ShardedDaemonProcessOptions, ShardedDaemonProcessOptionsBuilder, ShardedDaemonProcessOptionsValidator } from './sharding/ShardedDaemonProcessOptions.js';
export type { ShardedDaemonProcessOptionsType } from './sharding/ShardedDaemonProcessOptions.js';
export type { ShardedDaemonProcessHandle } from './sharding/ShardedDaemonProcess.js';
export { ShardRegion } from './sharding/ShardRegion.js';
export { Shard } from './sharding/Shard.js';
export type { ShardConfig, ShardMessage } from './sharding/Shard.js';
export { EntityRef } from './sharding/EntityRef.js';
export type { ShardInfo } from './sharding/ShardInfo.js';
// The commands a shard ref accepts — ROADMAP #151.
export type {
  EntityEnvelope,
  GetShardStats,
  ShardStats,
  StartEntity,
} from './sharding/ShardingProtocol.js';
export { ShardingOptions, ShardingOptionsBuilder, ShardingOptionsValidator } from './sharding/ShardingOptions.js';
export type { ShardingOptionsType } from './sharding/ShardingOptions.js';
export { ShardCoordinator } from './sharding/ShardCoordinator.js';
export { ShardCoordinatorOptions, ShardCoordinatorOptionsBuilder } from './sharding/ShardCoordinatorOptions.js';
export type { ShardCoordinatorOptionsType } from './sharding/ShardCoordinatorOptions.js';
export { Passivate } from './sharding/Passivate.js';
export {
  JournalRememberEntitiesStore,
} from './sharding/RememberEntitiesStore.js';
export type {
  RememberEntitiesStore,
  RememberEvent,
} from './sharding/RememberEntitiesStore.js';
// The coordinator-state opt-in.  Exported because the option JSDoc on
// `StartShardingOptionsType.coordinatorStateStore` tells the user to pass
// `new DistributedDataCoordinatorStateStore(...)`, and until now that
// instruction was impossible to follow from outside this repository — the
// class reached no public entry point (#682).
export {
  DistributedDataCoordinatorStateStore,
} from './sharding/CoordinatorState.js';
export type {
  CoordinatorStateStore,
  CoordinatorStateData,
  RegionInfoData,
} from './sharding/CoordinatorState.js';
export { shardMapViewOf } from './sharding/ShardMapView.js';
export type {
  ShardMapView,
  ShardMapViewRegion,
  ShardMapViewAssignment,
} from './sharding/ShardMapView.js';
export {
  CassandraRememberEntitiesStore,
  rememberEntitiesDdl,
} from './sharding/CassandraRememberEntitiesStore.js';
export { CassandraRememberEntitiesStoreOptions, CassandraRememberEntitiesStoreOptionsBuilder } from './sharding/CassandraRememberEntitiesStoreOptions.js';
export type {
  CassandraRememberEntitiesStoreOptionsType,
} from './sharding/CassandraRememberEntitiesStoreOptions.js';
export {
  HashAllocationStrategy,
  LeastShardAllocationStrategy,
} from './sharding/AllocationStrategy.js';
export type { AllocationStrategy } from './sharding/AllocationStrategy.js';
export {
  moduloAllocator,
  rendezvousAllocator,
  hashShardId,
} from './sharding/ShardAllocator.js';
export type { ShardAllocator } from './sharding/ShardAllocator.js';

// Cluster-aware routing.
export {
  ClusterRouter,
  pickRendezvous,
  ClusterRouterOptions,
  ClusterRouterOptionsBuilder,
  ClusterRouterOptionsValidator,
  ClusterMailboxDepthAgent,
  MAILBOX_DEPTH_AGENT_PATH,
} from './router/index.js';
export type {
  ClusterRouterOptionsType,
  ClusterRouterType,
  MailboxDepthMessage,
  MailboxDepthQueryMessage,
  MailboxDepthReportMessage,
} from './router/index.js';

// Outside-in client (#86).
export { ClusterClient } from './ClusterClient.js';
export { ClusterClientOptions, ClusterClientOptionsBuilder, ClusterClientOptionsValidator } from './ClusterClientOptions.js';
export type { ClusterClientOptionsType } from './ClusterClientOptions.js';
export {
  ClusterClientReceptionist,
  ClusterClientReceptionistId,
} from './ClusterClientReceptionist.js';
export { ClusterClientReceptionistOptions, ClusterClientReceptionistOptionsBuilder, ClusterClientReceptionistOptionsValidator } from './ClusterClientReceptionistOptions.js';
export type { ClusterClientReceptionistOptionsType } from './ClusterClientReceptionistOptions.js';
export type {
  ClusterClientEnvelopeMessage,
  ClusterClientReplyMessage,
} from './ClusterClientReceptionist.js';
