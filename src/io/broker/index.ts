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
// Client-side TLS material (#743).  `TlsTransportOptionsType` is the shape
// every `withTls` on this side takes; re-exported here because reaching it
// through `actor-ts/cluster` to configure a message broker made no sense.
export { toBrokerDriverTls, findBrokerTlsProblem } from './BrokerTls.js';
export type { BrokerDriverTlsOptions } from './BrokerTls.js';
export type { TlsTransportOptionsType } from '../../runtime/tcp/TcpBackend.js';

// Phase 1 actors
export { TcpSocketActor } from './TcpSocketActor.js';
export type {
  TcpSocketCommand,
  TcpOutbound,
} from './TcpSocketActor.js';
export {
  DEFAULT_TCP_KEEP_ALIVE_MS,
  TcpSocketOptions,
  TcpSocketOptionsBuilder,
  TcpSocketOptionsValidator,
} from './TcpSocketOptions.js';
export type { TcpSocketOptionsType } from './TcpSocketOptions.js';
// Framing is shared by the client and the listener, so it lives on its own.
export type { TcpFraming, TcpFrame } from './TcpFraming.js';
export { TcpServerActor } from './TcpServerActor.js';
export type {
  TcpServerCommand,
  TcpServerMessage,
  TcpConnectionId,
  // The variants too, not just the unions: the `target` actor handles them
  // one by one, and a handler takes the named variant type (#1095).
  SendCommand,
  CloseCommand,
  ConnectionOpenedMessage,
  FrameMessage,
  ConnectionClosedMessage,
} from './TcpServerActor.js';
export { TcpServerOptions, TcpServerOptionsBuilder, TcpServerOptionsValidator } from './TcpServerOptions.js';
export type { TcpServerOptionsType } from './TcpServerOptions.js';
export { UdpSocketActor } from './UdpSocketActor.js';
export type {
  UdpSocketCommand,
  UdpDatagram,
  UdpOutbound,
} from './UdpSocketActor.js';
export { UdpSocketOptions, UdpSocketOptionsBuilder, UdpSocketOptionsValidator } from './UdpSocketOptions.js';
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
export { MqttOptions, MqttOptionsBuilder, MqttOptionsValidator } from './MqttOptions.js';
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
// NOTE: the client-side WebSocket actor now lives in `src/http/websocket/`
// as the typed `WebsocketClientActor`; the server side is the
// `websocket()` routing directive.  The old frame-level
// `WebsocketActor` / `ServerWebsocketActor` were removed.

// Phase 2 actors — enterprise / RPC.
export { KafkaActor } from './KafkaActor.js';
export type {
  KafkaCommand,
  KafkaRecord,
  KafkaPublish,
  // Test seams (re-exported so subclasses can satisfy the mock shape).
  KafkajsModule,
  KafkaConstructor,
} from './KafkaActor.js';
export { KafkaOptions, KafkaOptionsBuilder, KafkaOptionsValidator } from './KafkaOptions.js';
export type { KafkaOptionsType } from './KafkaOptions.js';
export { AmqpActor } from './AmqpActor.js';
export type {
  AmqpCommand,
  AmqpDelivery,
  AmqpPublish,
  AmqpQueueBinding,
  // Test seams (re-exported so subclasses can satisfy the mock shape).
  AmqpModuleLike,
  AmqpConnectionLike,
  AmqpChannelLike,
  AmqpRawMessage,
} from './AmqpActor.js';
export { AmqpOptions, AmqpOptionsBuilder, AmqpOptionsValidator } from './AmqpOptions.js';
export type { AmqpOptionsType } from './AmqpOptions.js';
export { GrpcClientActor, createGrpcStreamHandle } from './GrpcClientActor.js';
export type {
  GrpcClientCommand,
  GrpcInbound,
  GrpcCredentials,
  GrpcStreamHandle,
  ReplyMessage,
  StreamStartedMessage,
  StreamDataMessage,
  StreamEndMessage,
  StreamErrorMessage,
  RpcErrorMessage,
  // Exported so a `createServiceClient` / `instantiateServiceClient`
  // override — the test seam in front of the client's call sites — can be
  // typed without `@grpc/grpc-js`.
  GrpcServiceClient,
  GrpcServiceConstructor,
  GrpcCredentialsLike,
  GrpcCallOptions,
  GrpcUnaryFunction,
  GrpcServerStreamFunction,
  GrpcClientStreamFunction,
  GrpcBidiFunction,
  GrpcReadableCall,
  GrpcWritableCall,
  GrpcDuplexCall,
} from './GrpcClientActor.js';
export { GrpcClientOptions, GrpcClientOptionsBuilder, GrpcClientOptionsValidator } from './GrpcClientOptions.js';
export type { GrpcChannelOptions, GrpcClientOptionsType } from './GrpcClientOptions.js';
export {
  GrpcServerActor,
  GRPC_HEALTH_SERVICE_NAME,
  buildGrpcMethodImplementation,
  grpcHealthCheckImplementation,
  isKnownGrpcServiceName,
  servingStatusOf,
} from './GrpcServerActor.js';
export type {
  GrpcHandler,
  GrpcUnaryCall,
  GrpcServerStreamCall,
  GrpcClientStreamCall,
  GrpcBidiCall,
  GrpcChunkMessage,
  GrpcEndMessage,
  GrpcRequestStreamInbound,
  GrpcServingStatus,
  // Health-service seams (exported so a caller can host `grpc.health.v1.Health`
  // on a server it builds itself, and so the handler is testable standalone).
  GrpcHealthImplementation,
  GrpcServerUnaryRequest,
  GrpcServerReadableCall,
  GrpcCallMetadata,
  GrpcUnaryCallback,
  // Exported so a `loadGrpcModule` / `loadProtoLoader` override — the test
  // seam in front of the server's bind — can be typed without
  // `@grpc/grpc-js`.
  GrpcServerLike,
  GrpcServerModule,
  GrpcProtoLoaderModule,
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
export { NatsOptions, NatsOptionsBuilder, NatsOptionsValidator } from './NatsOptions.js';
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
  JetStreamMessageHandleLike,
  JetStreamMessageInfoLike,
  JetStreamManagerLike,
} from './JetStreamActor.js';
export { JetStreamOptions, JetStreamOptionsBuilder, JetStreamOptionsValidator } from './JetStreamOptions.js';
export type { JetStreamOptionsType } from './JetStreamOptions.js';
// JetStream KV + Object Store (#74) — separate sub-APIs, separate actors.
export { JetStreamKeyValueActor } from './JetStreamKeyValueActor.js';
export type {
  JetStreamKeyValueCommand,
  JetStreamKeyValueMessage,
  KeyValueEntryMessage,
  KeyValueNotFoundMessage,
  KeyValueRemovedMessage,
  KeyValueRevisionMessage,
  KeyValueKeysMessage,
  KeyValueOperationFailedMessage,
  // Test seams (re-exported so subclasses can satisfy the mock shape).
  KeyValueNatsConnectionLike,
  KeyValueJetStreamClientLike,
  KeyValueBucketOptionsLike,
  KeyValueStoreLike,
  KeyValueWatchLike,
  KeyValueEntryLike,
} from './JetStreamKeyValueActor.js';
export {
  JetStreamKeyValueOptions,
  JetStreamKeyValueOptionsBuilder,
  JetStreamKeyValueOptionsValidator,
} from './JetStreamKeyValueOptions.js';
export type { JetStreamKeyValueOptionsType } from './JetStreamKeyValueOptions.js';
export { JetStreamObjectStoreActor } from './JetStreamObjectStoreActor.js';
export type {
  JetStreamObjectStoreCommand,
  JetStreamObjectStoreMessage,
  JetStreamObjectInfo,
  ObjectStoredMessage,
  ObjectBodyMessage,
  ObjectInfoMessage,
  ObjectListMessage,
  ObjectDeletedMessage,
  ObjectNotFoundMessage,
  ObjectStoreOperationFailedMessage,
  // Test seams (re-exported so subclasses can satisfy the mock shape).
  ObjectStoreNatsConnectionLike,
  ObjectStoreJetStreamClientLike,
  ObjectStoreBucketOptionsLike,
  ObjectMetaLike,
  ObjectStoreLike,
  ObjectInfoLike,
} from './JetStreamObjectStoreActor.js';
export {
  DEFAULT_MAX_OBJECT_BYTES,
  JetStreamObjectStoreOptions,
  JetStreamObjectStoreOptionsBuilder,
  JetStreamObjectStoreOptionsValidator,
} from './JetStreamObjectStoreOptions.js';
export type { JetStreamObjectStoreOptionsType } from './JetStreamObjectStoreOptions.js';
export { RedisStreamsActor } from './RedisStreamsActor.js';
export type {
  RedisStreamsCommand,
  RedisStreamEntry,
  RedisStreamPublish,
  // Test seams (re-exported so subclasses can satisfy the mock shape).
  IoredisModuleLike,
  IoredisConstructor,
  IoredisClientLike,
  IoredisClientEvent,
  IoredisClientOptionsLike,
} from './RedisStreamsActor.js';
export { RedisStreamsOptions, RedisStreamsOptionsBuilder, RedisStreamsOptionsValidator } from './RedisStreamsOptions.js';
export type { RedisStreamsOptionsType } from './RedisStreamsOptions.js';
export { SseActor } from './SseActor.js';
export type {
  SseCommand,
  SseEvent,
} from './SseActor.js';
export { SseOptions, SseOptionsBuilder, SseOptionsValidator } from './SseOptions.js';
export type { SseOptionsType } from './SseOptions.js';

// Email bridge (#1133) — IMAP IDLE in, pooled SMTP out.
export { EmailBridgeActor, isMessageLevelSmtpFailure, pickTextParts } from './EmailBridgeActor.js';
export type {
  EmailBridgeCommand,
  // The variants too, not just the union: the target actor handles them one
  // by one, and a handler takes the named variant type (#1095).
  EmailSendCommand,
  EmailAcknowledgmentCommand,
  EmailNegativeAcknowledgmentCommand,
  EmailMessage,
  EmailSend,
  EmailAddress,
  EmailAttachment,
  EmailTextPart,
  // Test seams (re-exported so a fake can satisfy the driver shape).
  ImapFlowModuleLike,
  ImapFlowClientLike,
  ImapFlowOptionsLike,
  ImapEnvelopeLike,
  ImapEnvelopeAddressLike,
  ImapBodyStructureLike,
  ImapFetchedMessageLike,
  ImapSearchQueryLike,
  NodemailerModuleLike,
  NodemailerTransportOptionsLike,
  NodemailerMessage,
  NodemailerAttachment,
  SmtpTransporterLike,
} from './EmailBridgeActor.js';
export {
  DEFAULT_EMAIL_ACKNOWLEDGMENT_TIMEOUT_MS,
  DEFAULT_EMAIL_MAX_MESSAGE_BYTES,
  DEFAULT_IMAP_MAILBOX,
  DEFAULT_IMAP_MAX_IDLE_TIME_MS,
  DEFAULT_IMAP_POLL_INTERVAL_MS,
  DEFAULT_IMAP_PORT,
  DEFAULT_SMTP_MAX_CONNECTIONS,
  DEFAULT_SMTP_MAX_MESSAGES,
  DEFAULT_SMTP_PORT,
  EmailBridgeOptions,
  EmailBridgeOptionsBuilder,
  EmailBridgeOptionsValidator,
} from './EmailBridgeOptions.js';
export type {
  EmailBridgeOptionsType,
  EmailImapOptionsType,
  EmailSmtpOptionsType,
  EmailProcessedAction,
} from './EmailBridgeOptions.js';
export { EmailTemplate, EmailTemplateError } from './EmailTemplate.js';
export type { EmailTemplateValue } from './EmailTemplate.js';
// Re-exported beside the template: filling one with markup on purpose goes
// through the same `SafeHtml` brand the HTTP side uses, and reaching for it
// should not mean importing from `actor-ts/http` to send a mail.  Escaping
// itself is not re-exported — the template already does it.
export { rawHtml, html, SafeHtml } from '../../util/Html.js';
