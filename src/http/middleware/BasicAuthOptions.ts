/** Options for the {@link BasicAuth} middleware.  Options-only. */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';

/** Plain settings shape for HTTP Basic auth.  Provide `users` OR `validate`. */
export interface BasicAuthOptionsType {
  /** username→password map (constant-time compared). */
  readonly users?: Readonly<Record<string, string>>;
  /** Custom credential check (e.g. against a store). */
  readonly validate?: (user: string, pass: string) => boolean | Promise<boolean>;
  /** Realm advertised in `WWW-Authenticate` on 401.  Default `'actor-ts'`. */
  readonly realm?: string;
}

/** Fluent builder for {@link BasicAuthOptionsType}. */
export class BasicAuthOptionsBuilder extends OptionsBuilder<BasicAuthOptionsType> {
  static create(): BasicAuthOptionsBuilder {
    return new BasicAuthOptionsBuilder();
  }
  withUsers(users: Readonly<Record<string, string>>): this {
    return this.set('users', users);
  }
  withValidate(fn: (user: string, pass: string) => boolean | Promise<boolean>): this {
    return this.set('validate', fn);
  }
  withRealm(realm: string): this {
    return this.set('realm', realm);
  }
}

/** Accepted input: the builder or a plain object. */
export type BasicAuthOptions = BasicAuthOptionsBuilder | Partial<BasicAuthOptionsType>;
export const BasicAuthOptions = BasicAuthOptionsBuilder;
