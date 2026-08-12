/** Options for the {@link requestId} middleware.  Options-only. */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';

/**
 * Built-in default for {@link RequestIdOptionsType.headerName} — the header
 * the middleware reads and echoes unless configured otherwise, and the one
 * `requestIdOf` looks at by default.  A single spelling so the middleware
 * and the framework's own error log cannot drift apart.
 */
export const DEFAULT_REQUEST_ID_HEADER = 'x-request-id';

/** Plain settings shape for request-id. */
export type RequestIdOptionsType = {
  /** Header carrying the id, in + out.  Default `'x-request-id'`. */
  readonly headerName?: string;
  /** Accept a well-formed incoming id instead of always generating.  Default true. */
  readonly trustIncoming?: boolean;
  /** Id generator.  Default `randomUuid`, exported from the root entry point. */
  readonly generate?: () => string;
};

/** Fluent builder for {@link RequestIdOptionsType}. */
export class RequestIdOptionsBuilder extends OptionsBuilder<RequestIdOptionsType> {
  static create(): RequestIdOptionsBuilder {
    return new RequestIdOptionsBuilder();
  }
  withHeaderName(name: string): this {
    return this.set('headerName', name);
  }
  withTrustIncoming(flag = true): this {
    return this.set('trustIncoming', flag);
  }
  withGenerate(generate: () => string): this {
    return this.set('generate', generate);
  }
}

/** Accepted input: the builder or a plain object. */
export type RequestIdOptions = RequestIdOptionsBuilder | Partial<RequestIdOptionsType>;
export const RequestIdOptions = RequestIdOptionsBuilder;
