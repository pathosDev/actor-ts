// Base class + supporting types
export {
  BrokerActor,
  type ConnectionState,
  type OutboundEnvelope,
} from './BrokerActor.js';
export {
  type BrokerCommonSettings,
  BrokerSettingsError,
  DEFAULT_RECONNECT,
  DEFAULT_OUTBOUND_BUFFER,
} from './BrokerSettings.js';
export {
  BrokerConnected,
  BrokerDisconnected,
  BrokerReconnectAttempt,
  BrokerReconnectFailed,
  BrokerBufferOverflow,
  BrokerNotConnected,
} from './BrokerEvents.js';

// Phase 1 actors
export { TcpSocketActor } from './TcpSocketActor.js';
export type {
  TcpSocketActorSettings,
  TcpSocketCmd,
  TcpFraming,
  TcpOutbound,
} from './TcpSocketActor.js';
export { UdpSocketActor } from './UdpSocketActor.js';
export type {
  UdpSocketActorSettings,
  UdpSocketCmd,
  UdpDatagram,
  UdpOutbound,
} from './UdpSocketActor.js';
export { MqttActor, matchesMqttPattern } from './MqttActor.js';
export type {
  MqttActorSettings,
  MqttCmd,
  MqttMessage,
  MqttPublish,
  MqttQos,
  MqttSubscription,
  MqttCredentials,
} from './MqttActor.js';
export { WebSocketActor } from './WebSocketActor.js';
export type {
  WebSocketActorSettings,
  WebSocketCmd,
  WebSocketFrame,
} from './WebSocketActor.js';

// Phase 2 actors — enterprise / RPC.
export { KafkaActor } from './KafkaActor.js';
export type {
  KafkaActorSettings,
  KafkaCmd,
  KafkaRecord,
  KafkaPublish,
} from './KafkaActor.js';
export { AmqpActor } from './AmqpActor.js';
export type {
  AmqpActorSettings,
  AmqpCmd,
  AmqpDelivery,
  AmqpPublish,
  AmqpQueueBinding,
} from './AmqpActor.js';
export { GrpcClientActor } from './GrpcClientActor.js';
export type {
  GrpcClientActorSettings,
  GrpcClientCmd,
  GrpcInbound,
  GrpcCredentials,
} from './GrpcClientActor.js';
export { GrpcServerActor } from './GrpcServerActor.js';
export type {
  GrpcServerSettings,
  GrpcHandler,
  GrpcUnaryCall,
  GrpcServerStreamCall,
  GrpcBidiCall,
} from './GrpcServerActor.js';

// Phase 3 actors — cloud-native / niche.
export { NatsActor } from './NatsActor.js';
export type {
  NatsActorSettings,
  NatsCmd,
  NatsMessage,
  NatsPublish,
} from './NatsActor.js';
export { JetStreamActor } from './JetStreamActor.js';
export type {
  JetStreamActorSettings,
  JetStreamCmd,
  JetStreamMessage,
  JetStreamPublish,
  JetStreamStreamConfig,
  JetStreamConsumerConfig,
  // Test seams (re-exported so subclasses can satisfy the mock shape).
  NatsConnectionLike,
  JetStreamClientLike,
  JetStreamSubscriptionLike,
  JetStreamMsgHandleLike,
  JetStreamMsgInfoLike,
  JetStreamManagerLike,
} from './JetStreamActor.js';
export { RedisStreamsActor } from './RedisStreamsActor.js';
export type {
  RedisStreamsActorSettings,
  RedisStreamsCmd,
  RedisStreamEntry,
  RedisStreamPublish,
} from './RedisStreamsActor.js';
export { SseActor } from './SseActor.js';
export type {
  SseActorSettings,
  SseCmd,
  SseEvent,
} from './SseActor.js';
