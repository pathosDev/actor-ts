import { describe, expect, test } from 'bun:test';
import {
  MINIMUM_LEASE_NAME_MAX_LENGTH,
  truncateLeaseName,
} from '../../../src/coordination/leases/LeaseName.js';
import { KubernetesLease } from '../../../src/coordination/leases/KubernetesLease.js';
import { KubernetesLeaseOptions } from '../../../src/coordination/leases/KubernetesLeaseOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import type {
  K8sCredentials,
  K8sRequestOptions,
  K8sResponse,
} from '../../../src/coordination/leases/K8sApi.js';

/**
 * A DNS-1123 subdomain, the shape the API server validates a
 * `coordination.k8s.io/v1` Lease name against: dot-separated lowercase
 * alphanumeric labels, each starting and ending alphanumeric.  Written out here
 * rather than imported from `KubernetesApiSeedProviderOptions` (where it is
 * private) so this file asserts the rule it means rather than agreeing with
 * another module about it.
 */
const DNS_1123_SUBDOMAIN = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;

/** Captures what each request was actually given — the path and the timeout. */
class RecordingClient {
  readonly calls: Array<{ method: string; path: string; timeoutMs: number }> = [];

  async request(_credentials: K8sCredentials, options: K8sRequestOptions): Promise<K8sResponse> {
    this.calls.push({ method: options.method, path: options.path, timeoutMs: options.timeoutMs });
    // Every GET answers 404 so the lease stops after one CREATE attempt, which
    // it also answers as a conflict — enough to observe two paths, no state.
    return options.method === 'GET'
      ? { status: 404, body: { code: 404 } }
      : { status: 409, body: { code: 409 } };
  }
}

describe('truncateLeaseName', () => {
  test('leaves a name that already fits completely alone', () => {
    expect(truncateLeaseName('my-singleton', 253)).toBe('my-singleton');
    // Exactly at the bound is still "fits" — the cut is on `>`, not `>=`, so a
    // name the API server accepts unchanged is never rewritten.
    const exact = 'a'.repeat(253);
    expect(truncateLeaseName(exact, 253)).toBe(exact);
  });

  test('truncates one character past the bound, and the result fits', () => {
    const oneTooLong = 'a'.repeat(254);
    const truncated = truncateLeaseName(oneTooLong, 253);
    expect(truncated).not.toBe(oneTooLong);
    expect(truncated.length).toBeLessThanOrEqual(253);
    expect(truncated).toMatch(DNS_1123_SUBDOMAIN);
  });

  test('is a pure function of the name — two callers derive the same object name', () => {
    // The property the whole helper exists for.  Two pods that disagreed about
    // the object name would each acquire their own record and both believe they
    // held the lease, which is the failure a lease prevents.
    const name = `tenant-${'x'.repeat(300)}`;
    expect(truncateLeaseName(name, 63)).toBe(truncateLeaseName(name, 63));
    expect(truncateLeaseName(name, 63)).toBe(truncateLeaseName(`${name}`, 63));
  });

  test('separates two names that share the truncated head', () => {
    // Prefix-sharing is the realistic case: names composed from an entity id or
    // a tenant key differ in their tail, which is exactly what a plain slice
    // would throw away.
    const shared = 'a'.repeat(300);
    const first = truncateLeaseName(`${shared}-one`, 64);
    const second = truncateLeaseName(`${shared}-two`, 64);
    expect(first).not.toBe(second);
    expect(first.slice(0, 56)).toBe(second.slice(0, 56));
  });

  test('the hash is over the whole original, not over the head it kept', () => {
    // Two names identical up to the cut and different after it must not collide;
    // hashing the retained head would make them the same name.
    const head = 'b'.repeat(100);
    expect(truncateLeaseName(`${head}-alpha`, 40)).not.toBe(truncateLeaseName(`${head}-beta`, 40));
  });

  test('a valid name stays valid wherever the cut lands', () => {
    // The slice can land anywhere, including on a `-` or a `.`, and a DNS-1123
    // label may end on neither.  The claim is that truncation never *introduces*
    // invalidity — a name that was already malformed is not repaired here, and
    // nothing in the adapter pretends otherwise.
    const name = Array.from({ length: 40 }, () => 'abc-def').join('.');
    expect(name).toMatch(DNS_1123_SUBDOMAIN);
    for (let maxLength = MINIMUM_LEASE_NAME_MAX_LENGTH; maxLength <= 64; maxLength++) {
      const truncated = truncateLeaseName(name, maxLength);
      expect(truncated.length).toBeLessThanOrEqual(maxLength);
      expect(truncated).toMatch(DNS_1123_SUBDOMAIN);
    }
  });

  test('stays valid at the smallest bound the validator allows', () => {
    const truncated = truncateLeaseName('some-very-long-lease-name', MINIMUM_LEASE_NAME_MAX_LENGTH);
    expect(truncated.length).toBeLessThanOrEqual(MINIMUM_LEASE_NAME_MAX_LENGTH);
    expect(truncated).toMatch(DNS_1123_SUBDOMAIN);
  });

  test('drops the separator rather than leading with it when the head empties', () => {
    // '----…' has nothing left after the trailing separators are stripped, and a
    // name may not begin with '-'.
    const truncated = truncateLeaseName('-'.repeat(60), 16);
    expect(truncated.startsWith('-')).toBe(false);
    expect(truncated).toMatch(DNS_1123_SUBDOMAIN);
  });
});

describe('KubernetesLease — the truncated name is the one on the wire (#859)', () => {
  const longName = `singleton-${'x'.repeat(300)}`;

  const leaseWith = (client: RecordingClient, leaseNameMaxLength?: number): KubernetesLease => {
    const kubernetesLeaseOptions = KubernetesLeaseOptions.create()
      .withName(longName)
      .withNamespace('actors')
      .withOwner('pod-1')
      .withTtlMs(5_000)
      .withApiServerUrl('https://kubernetes.test')
      .withAuthToken('test-token')
      .withCaCert('<<test-ca-cert>>')
      .withAcquireRetries(1)
      .withClient(client);
    if (leaseNameMaxLength !== undefined) kubernetesLeaseOptions.withLeaseNameMaxLength(leaseNameMaxLength);
    return new KubernetesLease(kubernetesLeaseOptions);
  };

  test('an over-long name reaches the API server truncated, not whole', async () => {
    // Before this it was simply sent, and came back as an opaque K8sLeaseError
    // from the first GET at the moment the singleton was trying to start.
    const client = new RecordingClient();
    await leaseWith(client).acquire();

    const requested = decodeURIComponent(client.calls[0]!.path.split('/leases/')[1]!);
    expect(requested).not.toBe(longName);
    expect(requested).toBe(truncateLeaseName(longName, 253));
    expect(requested.length).toBeLessThanOrEqual(253);
  });

  test('a lowered bound truncates further, and every request uses the same name', async () => {
    const client = new RecordingClient();
    await leaseWith(client, 40).acquire();

    const expected = truncateLeaseName(longName, 40);
    expect(expected.length).toBeLessThanOrEqual(40);
    // GET, then the CREATE body's path — the acquire pass touches both, and an
    // acquire that created one object name while a release deleted another
    // would leave the record claimed by a process that thinks it let go.
    expect(client.calls[0]!.path).toContain(encodeURIComponent(expected));
    expect(client.calls.length).toBeGreaterThan(1);
  });

  test('the per-request timeout is the configured one, not a literal in K8sApi', async () => {
    const client = new RecordingClient();
    const kubernetesLeaseOptions = KubernetesLeaseOptions.create()
      .withName('short')
      .withNamespace('actors')
      .withOwner('pod-1')
      .withTtlMs(5_000)
      .withApiServerUrl('https://kubernetes.test')
      .withAuthToken('test-token')
      .withCaCert('<<test-ca-cert>>')
      .withAcquireRetries(1)
      .withOperationTimeoutMs(2_500)
      .withClient(client);
    await new KubernetesLease(kubernetesLeaseOptions).acquire();

    expect(client.calls.length).toBeGreaterThan(0);
    for (const call of client.calls) expect(call.timeoutMs).toBe(2_500);
  });

  test('rejects a bound no truncated name could satisfy', () => {
    const tooSmall = KubernetesLeaseOptions.create()
      .withName('short')
      .withNamespace('actors')
      .withOwner('pod-1')
      .withTtlMs(5_000)
      .withLeaseNameMaxLength(4);
    expect(() => new KubernetesLease(tooSmall)).toThrow(OptionsError);
    expect(() => new KubernetesLease(tooSmall)).toThrow(/leaseNameMaxLength/);

    // And one the API server itself would not honour: a name past 253 is
    // rejected there, so accepting it here would only wave through a name that
    // fails later.
    const tooLarge = KubernetesLeaseOptions.create()
      .withName('short')
      .withNamespace('actors')
      .withOwner('pod-1')
      .withTtlMs(5_000)
      .withLeaseNameMaxLength(1_024);
    expect(() => new KubernetesLease(tooLarge)).toThrow(/leaseNameMaxLength/);
  });
});
