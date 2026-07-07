import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type {
  S3ClientLike,
  S3Credentials,
  S3ObjectStorageSettings,
} from './S3ObjectStorageBackend.js';

/**
 * Fluent builder for {@link S3ObjectStorageSettings}.  `bucket` + `region`
 * are required by the backend, so build the two up front:
 *
 *     new S3ObjectStorageBackend(
 *       S3ObjectStorageOptions.create().withBucket('my-app').withRegion('eu-central-1'),
 *     )
 */
export class S3ObjectStorageOptions extends OptionsBuilder<S3ObjectStorageSettings> {
  /** Start a fresh builder.  Equivalent to `new S3ObjectStorageOptions()`. */
  static create(): S3ObjectStorageOptions {
    return new S3ObjectStorageOptions();
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
