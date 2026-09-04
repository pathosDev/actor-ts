import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import {
  ObjectStoragePluginOptionsValidator,
  readObjectStoragePluginOptionsFromConfig,
} from '../../../src/persistence/object-storage/ObjectStoragePluginOptions.js';
import { DEFAULT_MAX_DECOMPRESSED_BYTES } from '../../../src/persistence/object-storage/BodyCodec.js';
import { DEFAULT_SNAPSHOT_KEEP_N } from '../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * #873 — the object-storage plugin read no HOCON at all before this, and
 * neither did anything else under `src/persistence/`: bucket, region, prefix,
 * retention and the decompression cap were constructor-only, so a value that
 * differs per environment could only be changed by editing code.
 *
 * Two things have to be right, and they pull in opposite directions.  The
 * mapping (kebab leaf → camelCase field, sub-block → one `backend` spec) and
 * the "absent means absent" rule are the ordinary half.  The other half is
 * what must **not** be readable: the block has no path for an access key, a
 * client-side master key or an integrity key, and `client-aes256-gcm` is
 * refused rather than ignored — a deployment that asked for client-side
 * encryption and silently got plaintext is exactly the failure #960 exists to
 * stop.
 *
 * `Config.parseString` throughout, never `Config.fromObject({'a.b': 1})`:
 * that form keeps the dotted string as a literal top-level key, so `hasPath`
 * would resolve the nested reference.conf value instead and the assertion
 * would be about nothing.
 */

/**
 * The reader's contract is that an absent leaf is **omitted**, not written as
 * an explicit `undefined` — that is what lets a consumer spread the result
 * without shadowing the layer beneath it.  `toEqual` cannot express the
 * difference: it ignores a property whose value is `undefined`, so a reader
 * rewritten to punch holes passes every `toEqual` in this file.  Measured, not
 * assumed — `out.prefix = hasPath ? … : undefined` was tried against these
 * tests and stayed green until this assertion existed.
 */
function ownKeysOf(options: object): string[] {
  return Object.keys(options);
}

/** The block, indented into `actor-ts.persistence.snapshot-store`. */
function objectStorageConfig(body: string): Config {
  return Config.parseString(`
    actor-ts.persistence.snapshot-store.object-storage {
      ${body}
    }
  `);
}

describe('readObjectStoragePluginOptionsFromConfig', () => {
  test('the shipped reference.conf resolves to the documented defaults', () => {
    // Locks the published values to the reader: a rename on either side turns
    // into a failure here rather than into a key that quietly stops applying.
    // `backend` is absent because `backend = ""` is the shape of the selector,
    // not a value — an empty selector leaves the backend to code.
    const options = readObjectStoragePluginOptionsFromConfig(Config.parseString(REFERENCE_CONF));

    expect(options).toEqual({
      prefix: '',
      keepN: DEFAULT_SNAPSHOT_KEEP_N,
      maxDecompressedBytes: DEFAULT_MAX_DECOMPRESSED_BYTES,
      compression: { algorithm: 'gzip' },
      encryption: { mode: 'none' },
    });
    expect(ownKeysOf(options)).toEqual([
      'prefix', 'keepN', 'maxDecompressedBytes', 'compression', 'encryption',
    ]);
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    const options = readObjectStoragePluginOptionsFromConfig(Config.parseString('actor-ts.system.name = x'));

    expect(options).toEqual({});
    expect(ownKeysOf(options)).toEqual([]);
  });

  test('a partial block leaves the unset leaves out', () => {
    const options = readObjectStoragePluginOptionsFromConfig(objectStorageConfig('keep-n = 7'));

    expect(options).toEqual({ keepN: 7 });
    expect(ownKeysOf(options)).toEqual(['keepN']);
  });

  test('reads every leaf of the s3 variant', () => {
    const config = objectStorageConfig(`
      backend = "s3"
      prefix  = "env-prod/"
      keep-n  = 5
      max-decompressed-bytes = 64M
      compression { algorithm = "zstd", level = 9 }
      encryption  { mode = "sse-kms", kms-key-id = "arn:aws:kms:eu-central-1:1:key/abc" }
      s3 {
        bucket = "my-app"
        region = "eu-central-1"
        endpoint = "https://minio.internal:9000"
        force-path-style = on
      }
    `);

    expect(readObjectStoragePluginOptionsFromConfig(config)).toEqual({
      backend: {
        kind: 's3',
        bucket: 'my-app',
        region: 'eu-central-1',
        endpoint: 'https://minio.internal:9000',
        forcePathStyle: true,
      },
      prefix: 'env-prod/',
      keepN: 5,
      maxDecompressedBytes: 64 * 1024 * 1024,
      compression: { algorithm: 'zstd', level: 9 },
      encryption: { mode: 'sse-kms', kmsKeyId: 'arn:aws:kms:eu-central-1:1:key/abc' },
    });
  });

  test('reads every leaf of the filesystem variant, unit suffixes dropped', () => {
    // `lockTimeoutMs` ⇔ `lock-timeout`, `staleLockMs` ⇔ `stale-lock`: the
    // value carries the unit, so the leaf name does not.
    const config = objectStorageConfig(`
      backend = "filesystem"
      filesystem {
        dir = "/var/lib/actor-ts"
        lock-timeout = 2s
        stale-lock   = 45s
      }
    `);

    expect(readObjectStoragePluginOptionsFromConfig(config)).toEqual({
      backend: { kind: 'filesystem', dir: '/var/lib/actor-ts', lockTimeoutMs: 2_000, staleLockMs: 45_000 },
    });
  });

  test('an empty s3 endpoint is dropped rather than passed through as ""', () => {
    // The published placeholder means "plain AWS S3".  Forwarded verbatim it
    // would fail `S3ObjectStorageOptionsValidator`'s URL rule on a leaf the
    // operator never filled in.
    const config = objectStorageConfig(`
      backend = "s3"
      s3 { bucket = "b", region = "auto", endpoint = "" }
    `);

    expect(readObjectStoragePluginOptionsFromConfig(config).backend)
      .toEqual({ kind: 's3', bucket: 'b', region: 'auto' });
  });

  test('the sub-block of the backend that was not selected is ignored', () => {
    // Both sub-blocks always exist in reference.conf, so reading the unselected
    // one would put a filesystem `dir` on an S3 spec.
    const config = objectStorageConfig(`
      backend = "filesystem"
      filesystem { dir = "/tmp/x" }
      s3 { bucket = "unused", region = "unused" }
    `);

    expect(readObjectStoragePluginOptionsFromConfig(config).backend)
      .toEqual({ kind: 'filesystem', dir: '/tmp/x' });
  });

  test('an unknown backend names the two it accepts and says custom is code-only', () => {
    const config = objectStorageConfig('backend = "gcs"');

    expect(() => readObjectStoragePluginOptionsFromConfig(config)).toThrow(OptionsError);
    expect(() => readObjectStoragePluginOptionsFromConfig(config)).toThrow(/filesystem.*s3.*custom/s);
  });

  test('an unknown compression algorithm is refused rather than passed on', () => {
    expect(() => readObjectStoragePluginOptionsFromConfig(objectStorageConfig('compression.algorithm = "brotli"')))
      .toThrow(/compression\.algorithm/);
  });
});

describe('key material has no path through the config block (#873)', () => {
  test("encryption.mode 'client-aes256-gcm' is refused, naming the code-only path", () => {
    const config = objectStorageConfig('encryption.mode = "client-aes256-gcm"');

    expect(() => readObjectStoragePluginOptionsFromConfig(config)).toThrow(OptionsError);
    // The refusal has to be actionable: it names the mode, says why, and points
    // at the builder call that can express it.
    expect(() => readObjectStoragePluginOptionsFromConfig(config)).toThrow(/withEncryption/);
    expect(() => readObjectStoragePluginOptionsFromConfig(config)).toThrow(/key material/);
  });

  test('an unknown encryption mode is refused too, so a typo cannot become plaintext', () => {
    // The dangerous shape is a mode that falls through to no encryption at all.
    expect(() => readObjectStoragePluginOptionsFromConfig(objectStorageConfig('encryption.mode = "sse_kms"')))
      .toThrow(/encryption\.mode/);
  });

  test('a master key written into the block is not read, whatever it is called', () => {
    // There is no leaf for it, so the reader cannot pick it up — the mitigation
    // is the absent path, not a filter that could be forgotten.  HOCON happily
    // parses the keys; nothing in the returned options carries them.
    const config = objectStorageConfig(`
      encryption { mode = "sse-s3", master-key = "AAAA", masterKey = "AAAA", integrity-key = "BBBB" }
      s3 {
        bucket = "b"
        region = "auto"
        credentials { access-key-id = "AKIA", secret-access-key = "s3cret" }
      }
      backend = "s3"
    `);

    const options = readObjectStoragePluginOptionsFromConfig(config);

    expect(options.encryption).toEqual({ mode: 'sse-s3' });
    expect(options.integrity).toBeUndefined();
    expect(options.backend).toEqual({ kind: 's3', bucket: 'b', region: 'auto' });
    expect(JSON.stringify(options)).not.toContain('s3cret');
    expect(JSON.stringify(options)).not.toContain('AKIA');
  });
});

describe('ObjectStoragePluginOptionsValidator over config-sourced values', () => {
  test('s3 without a bucket is named as such, not reported as a missing backend', () => {
    const options = readObjectStoragePluginOptionsFromConfig(objectStorageConfig(`
      backend = "s3"
      s3 { bucket = "", region = "eu-central-1" }
    `));

    expect(() => new ObjectStoragePluginOptionsValidator().validate(options))
      .toThrow(/backend\.bucket/);
  });

  test('s3 without a region is refused as well', () => {
    const options = readObjectStoragePluginOptionsFromConfig(objectStorageConfig(`
      backend = "s3"
      s3 { bucket = "b", region = "" }
    `));

    expect(() => new ObjectStoragePluginOptionsValidator().validate(options))
      .toThrow(/backend\.region/);
  });

  test('filesystem without a directory is refused', () => {
    const options = readObjectStoragePluginOptionsFromConfig(objectStorageConfig(`
      backend = "filesystem"
      filesystem { dir = "" }
    `));

    expect(() => new ObjectStoragePluginOptionsValidator().validate(options))
      .toThrow(/backend\.dir/);
  });

  test('sse-kms without a key ARN is refused', () => {
    const options = readObjectStoragePluginOptionsFromConfig(
      objectStorageConfig('encryption { mode = "sse-kms", kms-key-id = "" }'),
    );

    expect(() => new ObjectStoragePluginOptionsValidator().validate(options))
      .toThrow(/encryption\.kmsKeyId/);
  });

  test('keep-n accepts 0 — that is how pruning is switched off — and rejects a negative', () => {
    const validator = new ObjectStoragePluginOptionsValidator();

    expect(() => validator.validate({ keepN: 0 })).not.toThrow();
    expect(() => validator.validate({ keepN: -1 })).toThrow(/keepN/);
    expect(() => validator.validate({ keepN: 1.5 })).toThrow(/keepN/);
  });

  test('the decompression cap admits Infinity, which positiveInt would reject', () => {
    const validator = new ObjectStoragePluginOptionsValidator();

    expect(() => validator.validate({ maxDecompressedBytes: Infinity })).not.toThrow();
    expect(() => validator.validate({ maxDecompressedBytes: 0 })).toThrow(/maxDecompressedBytes/);
    expect(() => validator.validate({ maxDecompressedBytes: -1 })).toThrow(/maxDecompressedBytes/);
  });

  test('a non-positive filesystem lock timeout is refused', () => {
    const validator = new ObjectStoragePluginOptionsValidator();

    expect(() => validator.validate({ backend: { kind: 'filesystem', dir: '/tmp/x', lockTimeoutMs: 0 } }))
      .toThrow(/backend\.lockTimeoutMs/);
    expect(() => validator.validate({ backend: { kind: 'filesystem', dir: '/tmp/x', staleLockMs: -1 } }))
      .toThrow(/backend\.staleLockMs/);
  });

  test('an unset optional always passes, and so does the shipped reference block', () => {
    const validator = new ObjectStoragePluginOptionsValidator();

    expect(() => validator.validate({})).not.toThrow();
    expect(() => validator.validate(
      readObjectStoragePluginOptionsFromConfig(Config.parseString(REFERENCE_CONF)),
    )).not.toThrow();
  });
});
