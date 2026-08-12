export type { Serializer, SerializedValue } from './Serializer.js';
export { SerializationError } from './Serializer.js';
export { RESERVED_SERIALIZER_IDS_BELOW } from './Constants.js';
export { JsonSerializer } from './JsonSerializer.js';
export { encodeJsonTree, decodeJsonTree } from './JsonTree.js';
export type { JsonTreeEncodeOptions, UndefinedValueHandling } from './JsonTree.js';
export { CborSerializer } from './CborSerializer.js';
export { CborDecoder, CborEncoder, CborDecodeError, CborEncodeError } from './CborCodec.js';
export { SerializationExtension, SerializationExtensionId } from './SerializationExtension.js';

// #73 — schema-driven binary serializers.  The schema library stays the
// user's (`avsc` / `protobufjs` / generated code); actor-ts takes the
// compiled type structurally and never imports either package.
export { AvroSerializer } from './AvroSerializer.js';
export {
  AvroSerializerOptions,
  AvroSerializerOptionsBuilder,
  AvroSerializerOptionsValidator,
} from './AvroSerializerOptions.js';
export type { AvroSerializerOptionsType, AvroType } from './AvroSerializerOptions.js';
export { ProtobufSerializer } from './ProtobufSerializer.js';
export {
  ProtobufSerializerOptions,
  ProtobufSerializerOptionsBuilder,
  ProtobufSerializerOptionsValidator,
} from './ProtobufSerializerOptions.js';
export type {
  ProtobufSerializerOptionsType,
  ProtobufMessageType,
  ProtobufWriter,
  ProtobufConversionOptions,
} from './ProtobufSerializerOptions.js';
