import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsError, OptionsValidator } from '../../util/OptionsValidator.js';
import type { DynamoDbConnection, DynamoDbOperations } from './DynamoDbClient.js';

/** Table provisioning, shared by all three DynamoDB stores. */
export interface DynamoDbTableProvisioning {
  /** Create the table on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
  /**
   * `PAY_PER_REQUEST` (default) or `PROVISIONED`.  On-demand needs no capacity
   * planning, which suits an event journal's bursty write pattern.
   */
  readonly billingMode?: 'PAY_PER_REQUEST' | 'PROVISIONED';
  /** Capacity units — only read when `billingMode` is `PROVISIONED`. */
  readonly provisionedThroughput?: {
    readonly readCapacityUnits: number;
    readonly writeCapacityUnits: number;
  };
  /** How long to wait for a new table to become ACTIVE.  Default: 30 000 ms. */
  readonly tableReadyTimeoutMs?: number;
}

/** Everything the three DynamoDB option families have in common. */
export type DynamoDbOptionsBaseType = DynamoDbConnection & DynamoDbTableProvisioning;

/**
 * The connection and provisioning half of a DynamoDB options builder.
 *
 * Every store takes the same eight settings, so they live here rather than being
 * copied into three builders — the setters stay `withX` ⇔ field `x` in lockstep,
 * and each concrete builder adds only its own table name (and `keepN` for
 * snapshots).
 */
export abstract class DynamoDbOptionsBuilderBase<T extends DynamoDbOptionsBaseType>
  extends OptionsBuilder<T> {
  /** AWS region, e.g. `eu-central-1`. */
  withRegion(region: string): this {
    return this.set('region' as keyof T, region as T[keyof T]);
  }

  /** Service endpoint override — how you point at `dynamodb-local` or LocalStack. */
  withEndpoint(endpoint: string): this {
    return this.set('endpoint' as keyof T, endpoint as T[keyof T]);
  }

  /** Extra `DynamoDBClient` config (`credentials`, `maxAttempts`, …). */
  withClientConfig(clientConfig: Record<string, unknown>): this {
    return this.set('clientConfig' as keyof T, clientConfig as T[keyof T]);
  }

  /** Pre-built operations façade — bypasses the lazy SDK import; share it across stores. */
  withOperations(operations: DynamoDbOperations): this {
    return this.set('operations' as keyof T, operations as T[keyof T]);
  }

  /** Create the table on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables' as keyof T, autoCreateTables as T[keyof T]);
  }

  /** `PAY_PER_REQUEST` (default) or `PROVISIONED`. */
  withBillingMode(billingMode: 'PAY_PER_REQUEST' | 'PROVISIONED'): this {
    return this.set('billingMode' as keyof T, billingMode as T[keyof T]);
  }

  /** Capacity units — only used when `billingMode` is `PROVISIONED`. */
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
    this.oneOf('billingMode' as never, ['PAY_PER_REQUEST', 'PROVISIONED'] as never[]);
    this.positiveInt('tableReadyTimeoutMs' as never);
    // Provisioned throughput without PROVISIONED billing is silently ignored by
    // AWS, which makes a capacity typo invisible — so say so instead.
    if (s.provisionedThroughput !== undefined && (s.billingMode ?? 'PAY_PER_REQUEST') !== 'PROVISIONED') {
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
    throw new OptionsError(
      `${optionsName}: endpoint must be a valid http(s) URL, e.g. http://localhost:8000 `
      + `(got ${JSON.stringify(endpoint)})`,
      optionsName,
      'endpoint',
      endpoint,
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
