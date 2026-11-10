import { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * What a mode does with a message that would not survive the boundary it
 * checks: nothing, one warning per message type, or an exception on the
 * sender's stack.
 */
export type MessageBoundaryMode = 'off' | 'warn' | 'fail';

/**
 * Off in production.  The check costs a walk over every local message, and
 * a running system has no one on the stack to tell; the place to find out
 * that a message class does not cross a thread is a test.  `TestKit` turns
 * the structured-clone half to `fail` (#1386).
 */
export const DEFAULT_MESSAGE_BOUNDARY_STRUCTURED_CLONE: MessageBoundaryMode = 'off';
/**
 * Off everywhere, the test kit included, because the framework's own suite
 * says so: the round trip needs a serializer binding for every message
 * class an application sends, and most applications — and this repository's
 * tests — have none for messages that never leave the process.  Switch it on
 * for a suite whose messages are meant to cross a cluster wire.
 */
export const DEFAULT_MESSAGE_BOUNDARY_SERIALIZER_ROUND_TRIP: MessageBoundaryMode = 'off';

/** Plain options-object shape layered over `actor-ts.diagnostics.message-boundary.*`. */
export type MessageBoundaryOptionsType = {
  /**
   * Every local `tell` is checked against the worker hop: an object that
   * would lose its prototype under `structuredClone`, or cannot be cloned at
   * all, is reported with its type and the recipient.
   */
  readonly structuredClone?: MessageBoundaryMode;
  /**
   * Every local `tell` is encoded and decoded through the serialization
   * extension, as it would be for a cluster wire; a message no serializer
   * accepts is reported.
   */
  readonly serializerRoundTrip?: MessageBoundaryMode;
};

export class MessageBoundaryOptionsBuilder extends OptionsBuilder<MessageBoundaryOptionsType> {
  static create(): MessageBoundaryOptionsBuilder {
    return new MessageBoundaryOptionsBuilder();
  }

  withStructuredClone(structuredClone: MessageBoundaryMode): this {
    return this.set('structuredClone', structuredClone);
  }

  withSerializerRoundTrip(serializerRoundTrip: MessageBoundaryMode): this {
    return this.set('serializerRoundTrip', serializerRoundTrip);
  }
}

const MODES: ReadonlyArray<MessageBoundaryMode> = ['off', 'warn', 'fail'];

export class MessageBoundaryOptionsValidator extends OptionsValidator<MessageBoundaryOptionsType> {
  constructor() {
    super('MessageBoundaryOptions');
  }

  protected rules(): void {
    this.oneOf('structuredClone', MODES);
    this.oneOf('serializerRoundTrip', MODES);
  }
}

export function readMessageBoundaryOptionsFromConfig(
  config: Config = Config.load(),
): MessageBoundaryOptionsType {
  const keys = ConfigKeys.messageBoundary;
  const out: { -readonly [K in keyof MessageBoundaryOptionsType]: MessageBoundaryOptionsType[K] } = {};
  if (config.hasPath(keys.structuredClone)) {
    out.structuredClone = config.getString(keys.structuredClone) as MessageBoundaryMode;
  }
  if (config.hasPath(keys.serializerRoundTrip)) {
    out.serializerRoundTrip = config.getString(keys.serializerRoundTrip) as MessageBoundaryMode;
  }
  return out;
}

/**
 * Accepted input for `ActorSystemOptions.withMessageBoundary`: the fluent
 * {@link MessageBoundaryOptionsBuilder} OR a plain {@link MessageBoundaryOptionsType}.
 */
export type MessageBoundaryOptions = MessageBoundaryOptionsBuilder | MessageBoundaryOptionsType;
export const MessageBoundaryOptions = MessageBoundaryOptionsBuilder;
