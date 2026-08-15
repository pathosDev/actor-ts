import { OptionsError, OptionsValidator } from '../../util/OptionsValidator.js';
import { redactUrlCredentials } from '../../util/RedactUrlCredentials.js';
import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import type { D1ClientLike, D1Connection } from './D1Client.js';

/** Everything the three D1 option families have in common. */
export type D1OptionsBaseType = D1Connection & StoreSerializerOptionsBase;

/**
 * The connection half of a D1 options builder.
 *
 * All three stores take the same six connection settings, so they live here
 * rather than being copied into three builders — the setters stay `withX` ⇔ field
 * `x` in lockstep, and each concrete builder adds only its own table name.
 */
export abstract class D1OptionsBuilderBase<T extends D1OptionsBaseType> extends StoreSerializerOptionsBuilder<T> {
  /** Cloudflare account id. */
  withAccountId(accountId: string): this {
    return this.set('accountId' as keyof T, accountId as T[keyof T]);
  }

  /** D1 database id — the UUID, not the database name. */
  withDatabaseId(databaseId: string): this {
    return this.set('databaseId' as keyof T, databaseId as T[keyof T]);
  }

  /** API token with the `D1:Edit` permission. */
  withApiToken(apiToken: string): this {
    return this.set('apiToken' as keyof T, apiToken as T[keyof T]);
  }

  /** API base URL — override only for a proxy or a test double. */
  withBaseUrl(baseUrl: string): this {
    return this.set('baseUrl' as keyof T, baseUrl as T[keyof T]);
  }

  /** Per-request timeout in milliseconds.  Default: 30 000. */
  withTimeoutMs(timeoutMs: number): this {
    return this.set('timeoutMs' as keyof T, timeoutMs as T[keyof T]);
  }

  /**
   * Ceiling on one D1 response body, in bytes.  Default: 64 MiB.  Raise it
   * for an actor whose replay outgrows that — the whole history arrives as a
   * single response.
   */
  withMaxResponseBytes(maxResponseBytes: number): this {
    return this.set('maxResponseBytes' as keyof T, maxResponseBytes as T[keyof T]);
  }

  /** Pre-built transport — bypasses the HTTP client; share it across stores. */
  withClient(client: D1ClientLike): this {
    return this.set('client' as keyof T, client as T[keyof T]);
  }
}

/** The connection rules, shared by the three validators. */
export abstract class D1OptionsValidatorBase<T extends D1OptionsBaseType> extends OptionsValidator<T> {
  /** Kept alongside the base class's own copy, which is private. */
  private readonly family: string;

  protected constructor(optionsName: string) {
    super(optionsName);
    this.family = optionsName;
  }

  protected checkConnection(s: Partial<T>): void {
    this.nonEmptyString('accountId' as never);
    this.nonEmptyString('databaseId' as never);
    this.nonEmptyString('apiToken' as never);
    this.positiveInt('timeoutMs' as never);
    this.positiveInt('maxResponseBytes' as never);
    if (s.baseUrl !== undefined) assertD1BaseUrl(this.family, s.baseUrl);
    // Partial credentials are the mistake worth catching: two of three set means
    // a forgotten environment variable, and the store would otherwise fail on
    // first use with a message about all three.
    const supplied = [s.accountId, s.databaseId, s.apiToken].filter((value) => value !== undefined).length;
    if (s.client === undefined && supplied > 0 && supplied < 3) {
      this.fail(
        'accountId/databaseId/apiToken',
        'must all be set together (or pass a pre-built client)',
        supplied,
      );
    }
  }
}

/**
 * The base URL has to be an `http(s)` URL.
 *
 * Parsing alone would not catch a bare `host:port`: WHATWG
 * `new URL('api.example.com:443')` *succeeds*, reading `api.example.com:` as the
 * scheme.  So the protocol is checked explicitly.
 */
export function assertD1BaseUrl(optionsName: string, baseUrl: string): void {
  const fail = (): never => {
    // Same treatment as every other URL rule, even though a Cloudflare API
    // base URL does not conventionally carry userinfo: an override is
    // operator-supplied, and the rendering path ends in an ERROR log (#590).
    const redacted = redactUrlCredentials(baseUrl);
    throw new OptionsError(
      `${optionsName}: baseUrl must be a valid http(s) URL (got ${JSON.stringify(redacted)})`,
      optionsName,
      'baseUrl',
      redacted,
    );
  };
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return fail();
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail();
}
