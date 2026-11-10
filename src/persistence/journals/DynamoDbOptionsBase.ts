import { MAX_TIMER_DELAY_MS } from '../../util/Constants.js';
import { OptionsError, OptionsValidator } from '../../util/OptionsValidator.js';
import { redactUrlCredentials } from '../../util/RedactUrlCredentials.js';
import { DEFAULT_DYNAMODB_BILLING_MODE } from '../Constants.js';
import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import type { DynamoDbConnection, DynamoDbOperations } from './DynamoDbClient.js';

/**
 * The SDK's two retry modes, as `@smithy/core`'s `RETRY_MODES` spells them —
 * the values `retryMode` takes, and what the validator checks it against.  The
 * SDK reads every other word as `standard` and says nothing, so a typo would
 * quietly pick the other strategy; HOCON spells the two the same way, since
 * they are kebab-case already.
 */
export const DYNAMODB_RETRY_MODES = ['standard', 'adaptive'] as const;

/** One of {@link DYNAMODB_RETRY_MODES}. */
export type DynamoDbRetryMode = (typeof DYNAMODB_RETRY_MODES)[number];

/**
 * Table provisioning, shared by all three DynamoDB stores.  Each default lives
 * in `src/persistence/Constants.ts`, because the three option families share
 * these fields and no one of their options files could hold it.
 */
export type DynamoDbTableProvisioning = {
  /** Create the table on first use.  Default: true (`DEFAULT_AUTO_CREATE_TABLES`). */
  readonly autoCreateTables?: boolean;
  /**
   * `PAY_PER_REQUEST` (default, `DEFAULT_DYNAMODB_BILLING_MODE`) or
   * `PROVISIONED`.  On-demand needs no capacity planning, which suits an event
   * journal's bursty write pattern.
   */
  readonly billingMode?: 'PAY_PER_REQUEST' | 'PROVISIONED';
  /**
   * Capacity units — only read when `billingMode` is `PROVISIONED`.
   *
   * Left unset under `PROVISIONED`, every table the store creates gets 5 read
   * and 5 write capacity units (`DEFAULT_DYNAMODB_PROVISIONED_CAPACITY_UNITS`),
   * and nothing says so: the pair is optional there, so a deployment that
   * provisions on purpose should name it.
   */
  readonly provisionedThroughput?: {
    readonly readCapacityUnits: number;
    readonly writeCapacityUnits: number;
  };
  /**
   * How long to wait for a new table to become ACTIVE.  Default: 30 000 ms
   * (`DEFAULT_DYNAMODB_TABLE_READY_TIMEOUT_MS`).
   */
  readonly tableReadyTimeoutMs?: number;
};

/** Everything the three DynamoDB option families have in common. */
export type DynamoDbOptionsBaseType = DynamoDbConnection & DynamoDbTableProvisioning & StoreSerializerOptionsBase;

/**
 * The connection and provisioning half of a DynamoDB options builder.
 *
 * Every store takes the same twelve settings, so they live here rather than
 * being copied into three builders — the setters stay `withX` ⇔ field `x` in
 * lockstep, and each concrete builder adds only its own table name (and `keepN`
 * for snapshots).
 */
export abstract class DynamoDbOptionsBuilderBase<T extends DynamoDbOptionsBaseType>
  extends StoreSerializerOptionsBuilder<T> {
  /** AWS region, e.g. `eu-central-1`. */
  withRegion(region: string): this {
    return this.set('region' as keyof T, region as T[keyof T]);
  }

  /** Service endpoint override — how you point at `dynamodb-local` or LocalStack. */
  withEndpoint(endpoint: string): this {
    return this.set('endpoint' as keyof T, endpoint as T[keyof T]);
  }

  /**
   * Extra `DynamoDBClient` config (`credentials`, `useFipsEndpoint`, …), handed
   * to the SDK as it is.  The retry and timeout settings have setters of their
   * own, below.
   */
  withClientConfig(clientConfig: Record<string, unknown>): this {
    return this.set('clientConfig' as keyof T, clientConfig as T[keyof T]);
  }

  /** Pre-built operations façade — bypasses the lazy SDK import; share it across stores. */
  withOperations(operations: DynamoDbOperations): this {
    return this.set('operations' as keyof T, operations as T[keyof T]);
  }

  /** Attempts per request, the first included — the SDK's `maxAttempts`.  Unset: the SDK's own (3). */
  withMaxAttempts(maxAttempts: number): this {
    return this.set('maxAttempts' as keyof T, maxAttempts as T[keyof T]);
  }

  /** `standard` or `adaptive` — the SDK's `retryMode`.  Unset: the SDK's own (`standard`). */
  withRetryMode(retryMode: DynamoDbRetryMode): this {
    return this.set('retryMode' as keyof T, retryMode as T[keyof T]);
  }

  /** How long one attempt may take before it fails, in ms — see `DynamoDbConnection.requestTimeoutMs`. */
  withRequestTimeoutMs(requestTimeoutMs: number): this {
    return this.set('requestTimeoutMs' as keyof T, requestTimeoutMs as T[keyof T]);
  }

  /** How long opening the connection may take, in ms — the request handler's `connectionTimeout`. */
  withConnectionTimeoutMs(connectionTimeoutMs: number): this {
    return this.set('connectionTimeoutMs' as keyof T, connectionTimeoutMs as T[keyof T]);
  }

  /** Create the table on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables' as keyof T, autoCreateTables as T[keyof T]);
  }

  /** `PAY_PER_REQUEST` (default) or `PROVISIONED`. */
  withBillingMode(billingMode: 'PAY_PER_REQUEST' | 'PROVISIONED'): this {
    return this.set('billingMode' as keyof T, billingMode as T[keyof T]);
  }

  /**
   * Capacity units — only used when `billingMode` is `PROVISIONED`, where
   * leaving them unset creates every table at 5/5
   * (`DEFAULT_DYNAMODB_PROVISIONED_CAPACITY_UNITS`).
   */
  withProvisionedThroughput(readCapacityUnits: number, writeCapacityUnits: number): this {
    return this.set(
      'provisionedThroughput' as keyof T,
      { readCapacityUnits, writeCapacityUnits } as T[keyof T],
    );
  }

  /** How long to wait for a new table to become ACTIVE.  Default: 30 000 ms. */
  withTableReadyTimeoutMs(tableReadyTimeoutMs: number): this {
    return this.set('tableReadyTimeoutMs' as keyof T, tableReadyTimeoutMs as T[keyof T]);
  }
}

/**
 * The connection and provisioning rules, shared by the three validators.
 *
 * A subclass calls this from `rules()` and then adds its own field checks.  Not
 * a protected helper on `OptionsValidator` because the three validators are
 * separate classes over separate option types.
 *
 * The typed client settings may be made in one place: each beside what it
 * replaces in `clientConfig` is refused rather than given a precedence —
 * `maxAttempts` or `retryMode` beside the same key or beside a
 * `retryStrategy`, which the SDK uses as it is and so makes both moot, and
 * either timeout beside a `requestHandler`.  The SDK reads `clientConfig`'s
 * keys as they are spelled, so they are matched exactly.  The two timeouts are
 * bounded above by {@link MAX_TIMER_DELAY_MS}: the request handler arms both as
 * timers, and a timer asked for longer fires at once.
 */
export abstract class DynamoDbOptionsValidatorBase<T extends DynamoDbOptionsBaseType>
  extends OptionsValidator<T> {
  /** Kept alongside the base class's own copy, which is private. */
  private readonly family: string;

  protected constructor(optionsName: string) {
    super(optionsName);
    this.family = optionsName;
  }

  protected checkConnectionAndProvisioning(s: Partial<T>): void {
    this.nonEmptyString('region' as never);
    if (s.endpoint !== undefined) assertEndpointUrl(this.family, s.endpoint);
    this.checkClient(s);
    this.oneOf('billingMode' as never, ['PAY_PER_REQUEST', 'PROVISIONED'] as never[]);
    this.positiveInt('tableReadyTimeoutMs' as never);
    // Provisioned throughput without PROVISIONED billing is silently ignored by
    // AWS, which makes a capacity typo invisible — so say so instead.  An unset
    // mode is judged as the one the store will apply, so both read the constant.
    if (
      s.provisionedThroughput !== undefined
      && (s.billingMode ?? DEFAULT_DYNAMODB_BILLING_MODE) !== 'PROVISIONED'
    ) {
      this.fail(
        'provisionedThroughput',
        "is only used when billingMode is 'PROVISIONED'",
        s.provisionedThroughput,
      );
    }
    if (s.provisionedThroughput !== undefined) {
      const { readCapacityUnits, writeCapacityUnits } = s.provisionedThroughput;
      for (const [field, value] of [
        ['provisionedThroughput.readCapacityUnits', readCapacityUnits],
        ['provisionedThroughput.writeCapacityUnits', writeCapacityUnits],
      ] as const) {
        if (!Number.isInteger(value) || value < 1) this.fail(field, 'must be an integer >= 1', value);
      }
    }
  }

  /** The typed client settings — see the class comment. */
  private checkClient(s: Partial<T>): void {
    this.positiveInt('maxAttempts' as never);
    this.oneOf('retryMode' as never, DYNAMODB_RETRY_MODES as never);
    this.timerDelay('requestTimeoutMs', s.requestTimeoutMs);
    this.timerDelay('connectionTimeoutMs', s.connectionTimeoutMs);

    const clientConfig: Readonly<Record<string, unknown>> = s.clientConfig ?? {};
    this.notAlsoInClientConfig('maxAttempts', 'max-attempts', s.maxAttempts, clientConfig, ['maxAttempts', 'retryStrategy']);
    this.notAlsoInClientConfig('retryMode', 'retry-mode', s.retryMode, clientConfig, ['retryMode', 'retryStrategy']);
    this.notAlsoInClientConfig('requestTimeoutMs', 'request-timeout', s.requestTimeoutMs, clientConfig, ['requestHandler']);
    this.notAlsoInClientConfig('connectionTimeoutMs', 'connection-timeout', s.connectionTimeoutMs, clientConfig, ['requestHandler']);
  }

  private timerDelay(field: 'requestTimeoutMs' | 'connectionTimeoutMs', value: number | undefined): void {
    this.positiveInt(field as never);
    if (value !== undefined && value > MAX_TIMER_DELAY_MS) {
      this.fail(field, `must be at most ${MAX_TIMER_DELAY_MS} ms: the request handler arms it as a timer, and a longer one fires at once`, value);
    }
  }

  /**
   * Refuse `field` beside any of `keys` in `clientConfig`.  A key set to
   * `undefined` or `null` is no clash: the SDK reads both as unset.
   */
  private notAlsoInClientConfig(
    field: string,
    leaf: string,
    value: unknown,
    clientConfig: Readonly<Record<string, unknown>>,
    keys: ReadonlyArray<string>,
  ): void {
    if (value === undefined) return;
    const clash = keys.find((key) => clientConfig[key] !== undefined && clientConfig[key] !== null);
    if (clash !== undefined) {
      const replaces = clash === 'retryStrategy'
        ? ', which the SDK uses as it is, so the field would be ignored'
        : ', and only one of them can reach the SDK';
      this.fail(field, `(the ${leaf} leaf) is set beside clientConfig.${clash}${replaces} — set it in one place`);
    }
  }
}

/**
 * DynamoDB table names allow `A-Z a-z 0-9 _ - .` and are 3–255 characters.
 * Checking here means a typo fails at wiring time rather than on the first write.
 */
export function assertDynamoDbTableName(optionsName: string, field: string, name: string | undefined): void {
  if (name === undefined) return;
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(name)) {
    throw new OptionsError(
      `${optionsName}: ${field} must be 3-255 characters of A-Z a-z 0-9 _ - . (got ${JSON.stringify(name)})`,
      optionsName,
      field,
      name,
    );
  }
}

/**
 * The endpoint override has to be an `http(s)` URL — a bare `host:port` silently
 * fails to connect.
 *
 * Parsing alone is not enough to catch that: WHATWG `new URL('localhost:8000')`
 * *succeeds*, reading `localhost:` as the scheme and `8000` as the path.  So the
 * protocol has to be checked explicitly, which is the whole point of the rule.
 */
function assertEndpointUrl(optionsName: string, endpoint: string): void {
  const fail = (): never => {
    // Same treatment as every other URL rule, even though a DynamoDB endpoint
    // override does not conventionally carry userinfo: it is
    // operator-supplied, and the rendering path ends in an ERROR log (#590).
    const redacted = redactUrlCredentials(endpoint);
    throw new OptionsError(
      `${optionsName}: endpoint must be a valid http(s) URL, e.g. http://localhost:8000 `
      + `(got ${JSON.stringify(redacted)})`,
      optionsName,
      'endpoint',
      redacted,
    );
  };
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return fail();
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail();
}
