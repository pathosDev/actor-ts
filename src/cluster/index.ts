// Cluster entry points.
export { Cluster, inMemoryTransport } from './Cluster.js';
export type { ClusterSettings } from './Cluster.js';

export { NodeAddress } from './NodeAddress.js';
export type { NodeAddressData } from './NodeAddress.js';

export { Member } from './Member.js';
export type { MemberData, MemberStatus, WireMessage } from './Protocol.js';

export {
  SelfUp,
  SelfRemoved,
  LeaderChanged,
  MemberJoined,
  MemberUp,
  MemberWeaklyUp,
  MemberUnreachable,
  MemberReachable,
  MemberDown,
  MemberLeft,
  MemberRemoved,
  ShardMapChanged,
} from './ClusterEvents.js';
export type { ClusterEvent } from './ClusterEvents.js';

export { RemoteActorRef } from './RemoteActorRef.js';

export { InMemoryTransport, TcpTransport } from './Transport.js';
export type { Transport, WireHandler, TlsTransportSettings } from './Transport.js';
export { MessageChannelTransport } from './transports/MessageChannelTransport.js';
export type { PortLike, BrokeredMessage } from './transports/MessageChannelTransport.js';

export {
  FailureDetector,
  defaultFailureDetectorSettings,
} from './FailureDetector.js';
export type { FailureDetectorSettings, FailureDecision } from './FailureDetector.js';
export {
  PhiAccrualFailureDetector,
  defaultPhiAccrualSettings,
} from './PhiAccrualFailureDetector.js';
export type { PhiAccrualSettings } from './PhiAccrualFailureDetector.js';

// Split-Brain Resolver strategies.
export {
  KeepMajority,
  KeepOldest,
  StaticQuorum,
  KeepReferee,
} from './downing/index.js';
export type {
  DowningProvider,
  DowningDecision,
  ClusterPartitionView,
  KeepMajoritySettings,
  KeepOldestSettings,
  StaticQuorumSettings,
  KeepRefereeSettings,
} from './downing/index.js';

// Cluster Singleton.
export {
  ClusterSingleton,
  ClusterSingletonId,
  ClusterSingletonManager,
  ClusterSingletonProxy,
  singletonManagerPath,
} from './singleton/index.js';
export type {
  StartSingletonSettings,
  SingletonHandle,
  ClusterSingletonManagerSettings,
  SingletonDeliver,
} from './singleton/index.js';

// Distributed Pub-Sub.
export {
  DistributedPubSub,
  DistributedPubSubId,
  DistributedPubSubMediator,
  mediatorPath,
  CurrentTopics,
  GetTopics,
  Publish,
  Subscribe,
  SubscribeAck,
  Unsubscribe,
  UnsubscribeAck,
  UnsubscribeAll,
} from './pubsub/index.js';
export type { DistributedPubSubSettings } from './pubsub/index.js';

// Sharding.
export { ClusterSharding } from './sharding/ClusterSharding.js';
export type { StartSettings } from './sharding/ClusterSharding.js';
export { ShardedDaemonProcess } from './sharding/ShardedDaemonProcess.js';
export type {
  ShardedDaemonProcessSettings,
  ShardedDaemonProcessHandle,
} from './sharding/ShardedDaemonProcess.js';
export { ShardRegion } from './sharding/ShardRegion.js';
export type { ShardingSettings } from './sharding/ShardRegion.js';
export { ShardCoordinator } from './sharding/ShardCoordinator.js';
export type { ShardCoordinatorSettings } from './sharding/ShardCoordinator.js';
export { Passivate } from './sharding/Passivate.js';
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
export { ClusterRouter, pickRendezvous } from './router/index.js';
export type {
  ClusterRouterOptions,
  ClusterRouterType,
} from './router/index.js';
