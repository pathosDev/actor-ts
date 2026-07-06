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
export { TcpSocketOptions } from './TcpSocketOptions.js';
export { UdpSocketActor } from './UdpSocketActor.js';
export type {
  UdpSocketActorSettings,
  UdpSocketCmd,
  UdpDatagram,
  UdpOutbound,
} from './UdpSocketActor.js';
export { UdpSocketOptions } from './UdpSocketOptions.js';
// Subclass-first typed MQTT actor.
export { MqttActor, matchesMqttPattern, buildPublishProperties } from './MqttActor.js';
export type {
  MqttActorSettings,
  MqttPublishOptions,
  MqttCredentials,
  // Test seams (re-exported so subclasses can satisfy the mock shape).
  MqttClientLike,
  MqttModuleLike,
  MqttInboundPacketLike,
} from './MqttActor.js';
export { MqttOptions } from './MqttOptions.js';
// Message types, payload wrapper, and mailbox signals.
export {
  MqttPayload,
  MqttInboundSignal,
  MqttConnectedSignal,
  MqttDisconnectedSignal,
} from './MqttMessages.js';
export type {
  MqttMessage,
  MqttPublish,
  MqttCmd,
  MqttQos,
  MqttUserProperties,
  MqttSignal,
  MqttActorMessage,
  MqttRef,
} from './MqttMessages.js';
// Payload codec seam.
export { mqttJsonCodec, MqttDecodeError, MqttEncodeError } from './MqttCodec.js';
export type { MqttCodec } from './MqttCodec.js';
// NOTE: the client-side WebSocket actor now lives in `src/http/ws/`
// as the typed `WebSocketClientActor`; the server side is the
// `websocket()` routing directive.  The old frame-level
// `WebSocketActor` / `ServerWebSocketActor` were removed.

// Phase 2 actors — enterprise / RPC.
export { KafkaActor } from './KafkaActor.js';
export type {
  KafkaActorSettings,
  KafkaCmd,
  KafkaRecord,
  KafkaPublish,
} from './KafkaActor.js';
export { KafkaOptions } from './KafkaOptions.js';
export { AmqpActor } from './AmqpActor.js';
export type {
  AmqpActorSettings,
  AmqpCmd,
  AmqpDelivery,
  AmqpPublish,
  AmqpQueueBinding,
} from './AmqpActor.js';
export { AmqpOptions } from './AmqpOptions.js';
export { GrpcClientActor } from './GrpcClientActor.js';
export type {
  GrpcClientActorSettings,
  GrpcClientCmd,
  GrpcInbound,
  GrpcCredentials,
} from './GrpcClientActor.js';
export { GrpcClientOptions } from './GrpcClientOptions.js';
export { GrpcServerActor } from './GrpcServerActor.js';
export type {
  GrpcServerSettings,
  GrpcHandler,
  GrpcUnaryCall,
  GrpcServerStreamCall,
  GrpcBidiCall,
} from './GrpcServerActor.js';
export { GrpcServerOptions } from './GrpcServerOptions.js';

// Phase 3 actors — cloud-native / niche.
export { NatsActor } from './NatsActor.js';
export type {
  NatsActorSettings,
  NatsCmd,
  NatsMessage,
  NatsPublish,
} from './NatsActor.js';
export { NatsOptions } from './NatsOptions.js';
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
export { JetStreamOptions } from './JetStreamOptions.js';
export { RedisStreamsActor } from './RedisStreamsActor.js';
export type {
  RedisStreamsActorSettings,
  RedisStreamsCmd,
  RedisStreamEntry,
  RedisStreamPublish,
} from './RedisStreamsActor.js';
export { RedisStreamsOptions } from './RedisStreamsOptions.js';
export { SseActor } from './SseActor.js';
export type {
  SseActorSettings,
  SseCmd,
  SseEvent,
} from './SseActor.js';
export { SseOptions } from './SseOptions.js';
