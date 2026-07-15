/** Options for the {@link requestId} middleware.  Options-only. */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';

/** Plain settings shape for request-id. */
export interface RequestIdOptionsType {
  /** Header carrying the id, in + out.  Default `'x-request-id'`. */
  readonly headerName?: string;
  /** Accept a well-formed incoming id instead of always generating.  Default true. */
  readonly trustIncoming?: boolean;
  /** Id generator.  Default `crypto.randomUUID()`. */
  readonly generate?: () => string;
}

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
  withGenerate(fn: () => string): this {
    return this.set('generate', fn);
  }
}

/** Accepted input: the builder or a plain object. */
export type RequestIdOptions = RequestIdOptionsBuilder | Partial<RequestIdOptionsType>;
export const RequestIdOptions = RequestIdOptionsBuilder;
