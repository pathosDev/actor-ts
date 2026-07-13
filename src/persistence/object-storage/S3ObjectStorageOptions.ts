import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type {
  S3ClientLike,
  S3Credentials,
} from './S3ObjectStorageBackend.js';

export interface S3ObjectStorageOptionsType {
  /** S3 bucket name. */
  readonly bucket: string;
  /** AWS region.  For Cloudflare R2 use `'auto'`. */
  readonly region: string;
  /**
   * Custom endpoint URL.  Use this for MinIO (`http://localhost:9000`),
   * Cloudflare R2 (`https://<account>.r2.cloudflarestorage.com`),
   * Backblaze B2, DigitalOcean Spaces, Wasabi.  Omit for AWS S3.
   */
  readonly endpoint?: string;
  /**
   * Force path-style URLs (`<endpoint>/<bucket>/<key>`) instead of
   * virtual-host style (`<bucket>.<endpoint>/<key>`).  Required for
   * MinIO and most non-AWS S3-compatible stores.
   */
  readonly forcePathStyle?: boolean;
  /**
   * Static credentials.  Omit to fall back to the SDK's default chain
   * (env vars `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, EC2 instance
   * profile, IAM role for service accounts, …).
   */
  readonly credentials?: S3Credentials;
  /**
   * Allow injecting a pre-built `S3Client` — useful for tests, custom
   * middleware, or sharing one client across multiple backends.  When
   * provided, all other connection options are ignored.
   */
  readonly client?: S3ClientLike;
}

/**
 * Fluent builder for {@link S3ObjectStorageOptionsType}.  `bucket` + `region`
 * are required by the backend, so build the two up front:
 *
 *     new S3ObjectStorageBackend(
 *       S3ObjectStorageOptions.create().withBucket('my-app').withRegion('eu-central-1'),
 *     )
 */
export class S3ObjectStorageOptionsBuilder extends OptionsBuilder<S3ObjectStorageOptionsType> {
  /** Start a fresh builder.  Equivalent to `new S3ObjectStorageOptionsBuilder()`. */
  static create(): S3ObjectStorageOptionsBuilder {
    return new S3ObjectStorageOptionsBuilder();
  }

  /** S3 bucket name. */
  withBucket(bucket: string): this {
    return this.set('bucket', bucket);
  }

  /** AWS region.  For Cloudflare R2 use `'auto'`. */
  withRegion(region: string): this {
    return this.set('region', region);
  }

  /** Custom endpoint URL — MinIO / R2 / Backblaze / Spaces / Wasabi.  Omit for AWS S3. */
  withEndpoint(endpoint: string): this {
    return this.set('endpoint', endpoint);
  }

  /** Force path-style URLs instead of virtual-host style.  Required for MinIO. */
  withForcePathStyle(forcePathStyle = true): this {
    return this.set('forcePathStyle', forcePathStyle);
  }

  /** Static credentials.  Omit to fall back to the SDK's default chain. */
  withCredentials(credentials: S3Credentials): this {
    return this.set('credentials', credentials);
  }

  /** Inject a pre-built `S3Client` — all other connection options are then ignored. */
  withClient(client: S3ClientLike): this {
    return this.set('client', client);
  }
}

/** Validates resolved {@link S3ObjectStorageOptionsType} settings. */
export class S3ObjectStorageOptionsValidator extends OptionsValidator<S3ObjectStorageOptionsType> {
  constructor() {
    super('S3ObjectStorageOptions');
  }
  protected rules(s: Partial<S3ObjectStorageOptionsType>): void {
    if (s.bucket === undefined) this.fail('bucket', 'is required (call withBucket())');
    if (s.region === undefined) this.fail('region', 'is required (call withRegion())');
    this.nonEmptyString('bucket');
    this.nonEmptyString('region');
    this.url('endpoint', ['http', 'https']);
  }
}

/**
 * Accepted input for the S3 object-storage backend constructor: the fluent
 * {@link S3ObjectStorageOptionsBuilder} OR a plain {@link S3ObjectStorageOptionsType} object.
 */
export type S3ObjectStorageOptions = S3ObjectStorageOptionsBuilder | Partial<S3ObjectStorageOptionsType>;
/** Value alias so `S3ObjectStorageOptions.create()` / `new S3ObjectStorageOptions()` resolve to the builder. */
export const S3ObjectStorageOptions = S3ObjectStorageOptionsBuilder;
