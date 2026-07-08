// Base class + supporting types
export {
  BrokerActor,
  type ConnectionState,
  type OutboundEnvelope,
} from './BrokerActor.js';
export {
  type BrokerCommonOptionsType,
  BrokerOptionsError,
  DEFAULT_RECONNECT,
  DEFAULT_OUTBOUND_BUFFER,
} from './BrokerOptions.js';
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
  TcpSocketCommand,
  TcpFraming,
  TcpOutbound,
} from './TcpSocketActor.js';
export { TcpSocketOptions, TcpSocketOptionsBuilder } from './TcpSocketOptions.js';
export type { TcpSocketOptionsType } from './TcpSocketOptions.js';
export { UdpSocketActor } from './UdpSocketActor.js';
export type {
  UdpSocketCommand,
  UdpDatagram,
  UdpOutbound,
} from './UdpSocketActor.js';
export { UdpSocketOptions, UdpSocketOptionsBuilder } from './UdpSocketOptions.js';
export type { UdpSocketOptionsType } from './UdpSocketOptions.js';
// Subclass-first typed MQTT actor.
export { MqttActor, matchesMqttPattern, buildPublishProperties } from './MqttActor.js';
export type {
  MqttPublishOptions,
  // Test seams (re-exported so subclasses can satisfy the mock shape).
  MqttClientLike,
  MqttModuleLike,
  MqttInboundPacketLike,
} from './MqttActor.js';
export { MqttOptions, MqttOptionsBuilder } from './MqttOptions.js';
export type { MqttOptionsType, MqttCredentials } from './MqttOptions.js';
// Message types, payload wrapper, and mailbox signals (kind-tagged).
export { MqttPayload } from './MqttMessages.js';
export type {
  MqttMessage,
  MqttPublish,
  MqttCommand,
  MqttQos,
  MqttUserProperties,
  MqttInboundSignal,
  MqttConnectedSignal,
  MqttDisconnectedSignal,
  MqttSignal,
  MqttActorMessage,
  MqttRef,
} from './MqttMessages.js';
// Payload codec seam.
export { mqttJsonCodec, MqttDecodeError, MqttEncodeError } from './MqttCodec.js';
export type { MqttCodec } from './MqttCodec.js';
// NOTE: the client-side WebSocket actor now lives in `src/http/ws/`
// as the typed `WebsocketClientActor`; the server side is the
// `websocket()` routing directive.  The old frame-level
// `WebsocketActor` / `ServerWebsocketActor` were removed.

// Phase 2 actors — enterprise / RPC.
export { KafkaActor } from './KafkaActor.js';
export type {
  KafkaCommand,
  KafkaRecord,
  KafkaPublish,
} from './KafkaActor.js';
export { KafkaOptions, KafkaOptionsBuilder } from './KafkaOptions.js';
export type { KafkaOptionsType } from './KafkaOptions.js';
export { AmqpActor } from './AmqpActor.js';
export type {
  AmqpCommand,
  AmqpDelivery,
  AmqpPublish,
  AmqpQueueBinding,
} from './AmqpActor.js';
export { AmqpOptions, AmqpOptionsBuilder } from './AmqpOptions.js';
export type { AmqpOptionsType } from './AmqpOptions.js';
export { GrpcClientActor } from './GrpcClientActor.js';
export type {
  GrpcClientCommand,
  GrpcInbound,
  GrpcCredentials,
} from './GrpcClientActor.js';
export { GrpcClientOptions, GrpcClientOptionsBuilder } from './GrpcClientOptions.js';
export type { GrpcClientOptionsType } from './GrpcClientOptions.js';
export { GrpcServerActor } from './GrpcServerActor.js';
export type {
  GrpcHandler,
  GrpcUnaryCall,
  GrpcServerStreamCall,
  GrpcBidiCall,
} from './GrpcServerActor.js';
export { GrpcServerOptions, GrpcServerOptionsBuilder } from './GrpcServerOptions.js';
export type { GrpcServerOptionsType } from './GrpcServerOptions.js';

// Phase 3 actors — cloud-native / niche.
export { NatsActor } from './NatsActor.js';
export type {
  NatsCommand,
  NatsMessage,
  NatsPublish,
} from './NatsActor.js';
export { NatsOptions, NatsOptionsBuilder } from './NatsOptions.js';
export type { NatsOptionsType } from './NatsOptions.js';
export { JetStreamActor } from './JetStreamActor.js';
export type {
  JetStreamCommand,
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
export { JetStreamOptions, JetStreamOptionsBuilder } from './JetStreamOptions.js';
export type { JetStreamOptionsType } from './JetStreamOptions.js';
export { RedisStreamsActor } from './RedisStreamsActor.js';
export type {
  RedisStreamsCommand,
  RedisStreamEntry,
  RedisStreamPublish,
} from './RedisStreamsActor.js';
export { RedisStreamsOptions, RedisStreamsOptionsBuilder } from './RedisStreamsOptions.js';
export type { RedisStreamsOptionsType } from './RedisStreamsOptions.js';
export { SseActor } from './SseActor.js';
export type {
  SseCommand,
  SseEvent,
} from './SseActor.js';
export { SseOptions, SseOptionsBuilder } from './SseOptions.js';
export type { SseOptionsType } from './SseOptions.js';
