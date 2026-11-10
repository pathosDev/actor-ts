/**
 * Fluent builder for {@link NatsOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.nats` > built-in defaults).
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
import { findBrokerTlsProblem } from './BrokerTls.js';
import type { TlsTransportOptionsType } from '../../runtime/tcp/TcpBackend.js';
import type { ActorRef } from '../../ActorRef.js';
import type { NatsMessage } from './NatsActor.js';

export interface NatsOptionsType extends BrokerCommonOptionsType {
  /** NATS server URLs (`'nats://localhost:4222'`). */
  readonly servers?: ReadonlyArray<string> | string;
  /** Optional credentials (token / user-password). */
  readonly token?: string;
  readonly user?: string;
  readonly password?: string;
  /**
   * Subscriptions wired up at connect time.  Subjects support `*` and `>`
   * wildcards (NATS-side).
   *
   * No HOCON leaf: every entry carries an `ActorRef`, which names a live
   * actor in this process and has no config-file spelling.
   */
  readonly subscriptions?: ReadonlyArray<{ readonly subject: string; readonly target: ActorRef<NatsMessage> }>;
  /** Optional client name reported to the server. */
  readonly name?: string;
  /**
   * TLS material forwarded to nats.js as its `tls` option — a private CA to
   * trust, or a client certificate for mTLS, which is the common production
   * posture for NATS.  Carries the material itself, never a path to it.
   *
   * Setting it also asks nats.js to negotiate TLS, so it works with a plain
   * `nats://` server URL.  Deliberately has no HOCON leaf — a config file is
   * the wrong place for a private key.
   */
  readonly tls?: TlsTransportOptionsType;
}

export class NatsOptionsBuilder extends BrokerOptionsBuilder<NatsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new NatsOptionsBuilder()`. */
  static create(): NatsOptionsBuilder {
    return new NatsOptionsBuilder();
  }

  /** NATS server URLs (`'nats://localhost:4222'` or array). */
  withServers(servers: ReadonlyArray<string> | string): this {
    return this.set('servers', servers);
  }

  /** Token credential. */
  withToken(token: string): this {
    return this.set('token', token);
  }

  /** Username credential. */
  withUser(user: string): this {
    return this.set('user', user);
  }

  /** Password credential. */
  withPassword(password: string): this {
    return this.set('password', password);
  }

  /** Subscriptions wired up at connect time. */
  withSubscriptions(subscriptions: NonNullable<NatsOptionsType['subscriptions']>): this {
    return this.set('subscriptions', subscriptions);
  }

  /** Client name reported to the server. */
  withName(name: string): this {
    return this.set('name', name);
  }

  /** TLS material for the NATS dial.  Pass the material, not a file path. */
  withTls(tls: TlsTransportOptionsType): this {
    return this.set('tls', tls);
  }
}

/** A `servers` entry that carries a credential: where it is, why, and the entry with the credential masked. */
type NatsServerCredentialsViolation = {
  readonly field: string;
  readonly reason: string;
  readonly value: string;
};

/**
 * The first `servers` entry that carries a userinfo, or `null` — for every
 * actor that hands `servers` to nats.js, which is this one and the three
 * JetStream ones.
 *
 * nats.js reads a server entry for its host and port only: the userinfo of
 * `nats://user:password@host:4222` is discarded, and a dotless host carrying
 * one throws `Invalid URL` instead.  CONNECT credentials come from `user`,
 * `password` and `token` alone, so a credential written into a server URL is
 * a setting nothing reads — the connection goes out unauthenticated and fails
 * as an authorization error that names neither the entry nor the fix.
 *
 * Any `@` counts.  A NATS server entry has no legitimate use for one, and a
 * userinfo may itself contain `/`, `?` or `#` (#1458), so stopping at the
 * authority's end would let a password with a slash through.  The quoted entry
 * keeps its scheme and what follows the last `@`, because the refusal is logged
 * at ERROR when `preStart` fails and must not repeat the credential it refuses.
 */
export function findNatsServerCredentialsProblem(servers: unknown): NatsServerCredentialsViolation | null {
  const entries: ReadonlyArray<unknown> = Array.isArray(servers) ? servers : [servers];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== 'string') continue;
    const at = entry.lastIndexOf('@');
    if (at < 0) continue;
    const schemeEnd = entry.indexOf('://');
    const scheme = schemeEnd >= 0 && schemeEnd < at ? entry.slice(0, schemeEnd + 3) : '';
    return {
      field: Array.isArray(servers) ? `servers[${index}]` : 'servers',
      reason: 'must not carry credentials — nats.js ignores the userinfo of a server URL, so they would '
        + 'never reach the server; pass them as user / password, or token',
      value: `${scheme}***@${entry.slice(at + 1)}`,
    };
  }
  return null;
}

/** Validates resolved {@link NatsOptionsType} settings. */
export class NatsOptionsValidator extends BrokerOptionsValidator<NatsOptionsType> {
  constructor() {
    super('NatsOptions');
  }
  protected rules(s: Partial<NatsOptionsType>): void {
    this.commonRules(s);
    this.nonEmptyStringOrArray('servers', s.servers);
    const serversProblem = findNatsServerCredentialsProblem(s.servers);
    if (serversProblem !== null) this.fail(serversProblem.field, serversProblem.reason, serversProblem.value);
    const tlsProblem = findBrokerTlsProblem(s.tls);
    if (tlsProblem !== null) this.fail('tls', tlsProblem);
  }
}

/**
 * Accepted input for any NATS-configurable constructor: the fluent
 * {@link NatsOptionsBuilder} OR a plain {@link NatsOptionsType} object.
 */
export type NatsOptions = NatsOptionsBuilder | Partial<NatsOptionsType>;
/** Value alias so `NatsOptions.create()` / `new NatsOptions()` resolve to the builder. */
export const NatsOptions = NatsOptionsBuilder;
