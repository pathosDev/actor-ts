/**
 * S3 broker runner (B.2 / #20).
 *
 * Boots MinIO, ensures the test bucket exists, then runs every
 * scenario in `scenarios/` sequentially.  Mirrors the shape of
 * `tests/integration/controller.ts` (#313) — small, dependency-free,
 * exit 0 / exit 1.
 */
import { S3ObjectStorageBackend } from '../../../../src/persistence/object-storage/S3ObjectStorageBackend.js';
import { S3ObjectStorageOptions } from '../../../../src/persistence/object-storage/S3ObjectStorageOptions.js';
import { waitForPort } from '../lib/wait-for-port.js';
import { runScenarios, type BrokerScenario, type BrokerScenarioCtx } from '../lib/scenario.js';
import { scenario as putGetScenario } from './scenarios/01-put-get.js';
import { scenario as listScenario } from './scenarios/02-list.js';
import { scenario as casScenario } from './scenarios/03-cas.js';
import { scenario as deleteScenario } from './scenarios/04-delete.js';
import { scenario as sseScenario } from './scenarios/05-sse.js';

export interface S3Ctx extends BrokerScenarioCtx {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly region: string;
  readonly forcePathStyle: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
}

async function ensureBucket(ctx: S3Ctx): Promise<void> {
  // Create the bucket via a direct PUT to MinIO — the SDK helper
  // exists too, but we want this runner self-contained.  MinIO
  // returns 200/409 (already exists), both acceptable.
  const url = `${ctx.endpoint}/${ctx.bucket}`;
  // MinIO uses HTTP basic auth for the management plane only when
  // signed requests are set up; for default credentials a path-style
  // PUT with empty body to the bucket URL just works — MinIO infers
  // root creds from the well-known constants.  For consistency we
  // sign with the SDK by issuing a no-op put.
  // Simplest path: use the SDK's S3Client to issue CreateBucket.
  const sdk = await import('@aws-sdk/client-s3');
  const client = new sdk.S3Client({
    region: ctx.region,
    endpoint: ctx.endpoint,
    forcePathStyle: ctx.forcePathStyle,
    credentials: { accessKeyId: ctx.accessKeyId, secretAccessKey: ctx.secretAccessKey },
  });
  try {
    await client.send(new sdk.CreateBucketCommand({ Bucket: ctx.bucket }));
    console.log(`[runner] created bucket ${ctx.bucket}`);
  } catch (e) {
    const err = e as { name?: string; Code?: string };
    if (err.name === 'BucketAlreadyOwnedByYou' || err.name === 'BucketAlreadyExists'
        || err.Code === 'BucketAlreadyOwnedByYou' || err.Code === 'BucketAlreadyExists') {
      console.log(`[runner] bucket ${ctx.bucket} already exists`);
    } else {
      throw e;
    }
  } finally {
    client.destroy?.();
  }
  void url;
}

async function main(): Promise<void> {
  const ctx: S3Ctx = {
    env: process.env,
    endpoint: requireEnv('S3_ENDPOINT'),
    accessKeyId: requireEnv('S3_ACCESS_KEY'),
    secretAccessKey: requireEnv('S3_SECRET_KEY'),
    bucket: requireEnv('S3_BUCKET'),
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  };

  // Block until MinIO is accepting connections.  The compose
  // healthcheck does the same thing, but this guards against the
  // healthcheck-propagation race on Docker Desktop + Bun on Windows.
  const url = new URL(ctx.endpoint);
  await waitForPort(url.hostname, Number(url.port || '9000'), {
    description: 'MinIO S3 API',
    deadlineMs: 30_000,
  });

  await ensureBucket(ctx);

  const scenarios: BrokerScenario<S3Ctx>[] = [
    putGetScenario,
    listScenario,
    casScenario,
    deleteScenario,
    sseScenario,
  ];
  await runScenarios(scenarios, ctx);
}

/** Build a fresh backend per scenario — scenario isolation. */
export function backend(ctx: S3Ctx): S3ObjectStorageBackend {
  return new S3ObjectStorageBackend(
    S3ObjectStorageOptions.create()
      .withBucket(ctx.bucket)
      .withRegion(ctx.region)
      .withEndpoint(ctx.endpoint)
      .withForcePathStyle(ctx.forcePathStyle)
      .withCredentials({ accessKeyId: ctx.accessKeyId, secretAccessKey: ctx.secretAccessKey }),
  );
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
