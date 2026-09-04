import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import {
  readLeaseOptionsFromConfig,
  withLeaseConfigDefaults,
} from '../../../src/coordination/LeaseOptions.js';
import {
  DEFAULT_K8S_OPERATION_TIMEOUT_MS,
  DEFAULT_LEASE_NAME_MAX_LENGTH,
  DEFAULT_SERVICE_ACCOUNT_CA_PATH,
  DEFAULT_SERVICE_ACCOUNT_NAMESPACE_PATH,
  DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH,
  DEFAULT_TOKEN_RELOAD_INTERVAL_MS,
  KubernetesLeaseOptions,
  readKubernetesLeaseOptionsFromConfig,
  withKubernetesLeaseConfigDefaults,
} from '../../../src/coordination/leases/KubernetesLeaseOptions.js';
import { InMemoryLease } from '../../../src/coordination/leases/InMemoryLease.js';
import { KubernetesLease } from '../../../src/coordination/leases/KubernetesLease.js';

/**
 * `Config.parseString` throughout, never `Config.fromObject({'a.b.c': 1})`:
 * the latter keeps the dotted string as a literal top-level key, so `hasPath`
 * would still resolve the *nested* reference.conf value and the assertion
 * would say nothing.
 */
const reference = Config.parseString(REFERENCE_CONF);

/**
 * Run `body` with `ACTOR_TS_CONFIG` pointing at a temporary `application.conf`.
 *
 * The lease constructors call {@link Config.load} themselves — there is no
 * `ActorSystem` in scope to hand them one — so this is the only way to reach
 * the wiring rather than only the reader it calls.  A reader that works while
 * nothing calls it is the exact shape of a dead config key.
 */
function withApplicationConf<T>(source: string, body: () => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'actor-ts-lease-conf-'));
  const path = join(directory, 'application.conf');
  writeFileSync(path, source, 'utf8');
  const previous = process.env.ACTOR_TS_CONFIG;
  process.env.ACTOR_TS_CONFIG = path;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.ACTOR_TS_CONFIG;
    else process.env.ACTOR_TS_CONFIG = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

const releasable: Array<{ release(): Promise<void> }> = [];
afterEach(async () => {
  for (const lease of releasable.splice(0)) await lease.release().catch(() => { /* cleanup */ });
});

describe('readLeaseOptionsFromConfig', () => {
  test('the bundled reference supplies neither key', () => {
    // Both are comment-only in reference.conf, and that is load-bearing: a
    // shipped `ttl` would satisfy `validateRequired` for every lease in the
    // process and make the #596 guard unreachable, and a shipped
    // `renewal-interval` would displace the computed max(500ms, ttl/3).
    expect(readLeaseOptionsFromConfig(reference)).toEqual({});
  });

  test('reads both when an operator sets them', () => {
    const config = Config.parseString(`
      actor-ts.coordination.lease {
        ttl              = 30s
        renewal-interval = 10s
      }
    `);
    expect(readLeaseOptionsFromConfig(config)).toEqual({
      ttlMs: 30_000,
      renewalIntervalMs: 10_000,
    });
  });

  test('an absent block stays absent rather than being filled with defaults', () => {
    // `undefined` from the config layer has to mean "not set" so it falls
    // through to the built-in default instead of shadowing it.
    expect(readLeaseOptionsFromConfig(Config.parseString('actor-ts {}'))).toEqual({});
  });

  test('explicit options outrank the config block', () => {
    const config = Config.parseString('actor-ts.coordination.lease { ttl = 30s, renewal-interval = 10s }');
    expect(withLeaseConfigDefaults(
      { name: 'x', owner: 'o', ttlMs: 9_000 },
      config,
    )).toEqual({ name: 'x', owner: 'o', ttlMs: 9_000, renewalIntervalMs: 10_000 });
  });
});

describe('readKubernetesLeaseOptionsFromConfig', () => {
  test('the bundled reference supplies exactly the six shipped defaults', () => {
    // Exact-object, so a key added to reference.conf without a reader — or a
    // reader that quietly invents a field — shows up here.
    expect(readKubernetesLeaseOptionsFromConfig(reference)).toEqual({
      namespacePath: DEFAULT_SERVICE_ACCOUNT_NAMESPACE_PATH,
      tokenPath: DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH,
      caPath: DEFAULT_SERVICE_ACCOUNT_CA_PATH,
      tokenReloadIntervalMs: DEFAULT_TOKEN_RELOAD_INTERVAL_MS,
      operationTimeoutMs: DEFAULT_K8S_OPERATION_TIMEOUT_MS,
      leaseNameMaxLength: DEFAULT_LEASE_NAME_MAX_LENGTH,
    });
  });

  test('namespace is not among them — unset still means "read it from the mount"', () => {
    expect(readKubernetesLeaseOptionsFromConfig(reference).namespace).toBeUndefined();
  });

  test('reads every key an operator can set, namespace included', () => {
    const config = Config.parseString(`
      actor-ts.coordination.lease.kubernetes {
        namespace             = "actors"
        namespace-path        = "/etc/sa/namespace"
        token-path            = "/etc/sa/token"
        ca-path               = "/etc/sa/ca.crt"
        token-reload-interval = 90s
        operation-timeout     = 4s
        lease-name-max-length = 63
      }
    `);
    expect(readKubernetesLeaseOptionsFromConfig(config)).toEqual({
      namespace: 'actors',
      namespacePath: '/etc/sa/namespace',
      tokenPath: '/etc/sa/token',
      caPath: '/etc/sa/ca.crt',
      tokenReloadIntervalMs: 90_000,
      operationTimeoutMs: 4_000,
      leaseNameMaxLength: 63,
    });
  });

  test('an absent block stays absent', () => {
    expect(readKubernetesLeaseOptionsFromConfig(Config.parseString('actor-ts {}'))).toEqual({});
  });

  test('the common lease block is layered in alongside the kubernetes one', () => {
    const config = Config.parseString(`
      actor-ts.coordination.lease {
        ttl = 30s
        kubernetes { namespace = "actors", operation-timeout = 4s }
      }
    `);
    expect(withKubernetesLeaseConfigDefaults({ name: 'x', owner: 'o' } as never, config)).toEqual({
      name: 'x',
      owner: 'o',
      ttlMs: 30_000,
      namespace: 'actors',
      operationTimeoutMs: 4_000,
    });
  });

  test('explicit options outrank the config block', () => {
    const config = Config.parseString(`
      actor-ts.coordination.lease.kubernetes { namespace = "from-config", operation-timeout = 4s }
    `);
    const resolved = withKubernetesLeaseConfigDefaults(
      { name: 'x', owner: 'o', ttlMs: 5_000, namespace: 'from-code' },
      config,
    );
    expect(resolved.namespace).toBe('from-code');
    expect(resolved.operationTimeoutMs).toBe(4_000);
  });
});

describe('the lease constructors actually read the block (#859)', () => {
  test('InMemoryLease takes ttl and renewal-interval from application.conf', () => {
    const lease = withApplicationConf(
      'actor-ts.coordination.lease { ttl = 30s, renewal-interval = 11s }',
      // No ttlMs in code at all: without the config seam this construction
      // throws `ttlMs is required`.
      () => new InMemoryLease({ name: 'config-driven-lease', owner: 'pod-1' }),
    );
    releasable.push(lease);
    expect(lease).toBeInstanceOf(InMemoryLease);
  });

  test('a bad value in a config file is rejected exactly like a bad one in code', () => {
    expect(() => withApplicationConf(
      'actor-ts.coordination.lease { ttl = 30s, renewal-interval = -1s }',
      () => new InMemoryLease({ name: 'rejected-lease', owner: 'pod-1' }),
    )).toThrow(/renewalIntervalMs/);
  });

  test('KubernetesLease takes its namespace and bounds from application.conf', async () => {
    const requested: string[] = [];
    const lease = withApplicationConf(
      `actor-ts.coordination.lease.kubernetes {
         namespace             = "from-config"
         lease-name-max-length = 32
       }`,
      () => new KubernetesLease(KubernetesLeaseOptions.create()
        .withName(`singleton-${'y'.repeat(200)}`)
        .withOwner('pod-1')
        .withTtlMs(5_000)
        .withApiServerUrl('https://kubernetes.test')
        .withAuthToken('test-token')
        .withCaCert('<<test-ca-cert>>')
        .withAcquireRetries(1)
        .withClient({
          async request(_credentials, options) {
            requested.push(options.path);
            // 404 to the GET, 409 to the CREATE — the shortest path through
            // one acquire pass that touches both without modelling any state.
            return options.method === 'GET'
              ? { status: 404, body: { code: 404 } }
              : { status: 409, body: { code: 409 } };
          },
        })),
    );
    await lease.acquire();

    expect(requested[0]).toContain('/namespaces/from-config/leases/');
    const name = decodeURIComponent(requested[0]!.split('/leases/')[1]!);
    expect(name.length).toBeLessThanOrEqual(32);
  });
});

describe('mount paths and an explicit API server are still all-or-nothing (#599, #859)', () => {
  test('a redirected mount path alongside apiServerUrl is refused', () => {
    // The path keys describe the in-cluster source; an explicit apiServerUrl
    // says that source is not in use. Accepting both is how #599's mix — the
    // Pod's own token sent to an operator-named host — could come back by a
    // new route.
    const contradictory = KubernetesLeaseOptions.create()
      .withName('lease')
      .withNamespace('actors')
      .withOwner('pod-1')
      .withTtlMs(5_000)
      .withApiServerUrl('https://k8s.example.internal')
      .withAuthToken('token')
      .withCaCert('<<ca>>')
      .withTokenPath('/etc/sa/token');
    expect(() => new KubernetesLease(contradictory)).toThrow(OptionsError);
    expect(() => new KubernetesLease(contradictory)).toThrow(/tokenPath/);
  });

  test('the shipped default path is not a redirect, so the ordinary triple still works', () => {
    // reference.conf ships all three paths, so after the config layer merges in
    // they are always present. "Supplied" therefore cannot mean "chosen" — the
    // rule has to compare against the default, and this is what says so.
    const explicitCredential = KubernetesLeaseOptions.create()
      .withName('lease')
      .withNamespace('actors')
      .withOwner('pod-1')
      .withTtlMs(5_000)
      .withApiServerUrl('https://k8s.example.internal')
      .withAuthToken('token')
      .withCaCert('<<ca>>')
      .withTokenPath(DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH);
    expect(() => new KubernetesLease(explicitCredential)).not.toThrow();
  });

  test('a redirected path from a config file is refused just the same', () => {
    expect(() => withApplicationConf(
      'actor-ts.coordination.lease.kubernetes.token-path = "/etc/sa/token"',
      () => new KubernetesLease(KubernetesLeaseOptions.create()
        .withName('lease')
        .withNamespace('actors')
        .withOwner('pod-1')
        .withTtlMs(5_000)
        .withApiServerUrl('https://k8s.example.internal')
        .withAuthToken('token')
        .withCaCert('<<ca>>')),
    )).toThrow(/tokenPath/);
  });
});
