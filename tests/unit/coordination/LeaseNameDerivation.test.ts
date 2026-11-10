import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  MINIMUM_LEASE_NAME_MAX_LENGTH,
  deriveLeaseName,
  truncateLeaseName,
} from '../../../src/coordination/leases/LeaseName.js';

/**
 * `deriveLeaseName` — the object name the framework gives a lease it builds
 * from configuration (#1454).
 *
 * `truncateLeaseName` only bounds the length, which was enough while every
 * name was one a caller typed.  A name the framework composes is built from a
 * system name and a singleton or sharded type name, and those are whatever the
 * application called them: `OrderService`, `cart_v2`.  The API server rejects
 * anything that is not a DNS-1123 subdomain on the first GET, at the moment the
 * singleton tries to start, so the derivation has to produce one — and has to
 * keep two application names apart when the cleaning maps them onto the same
 * text, or two consumers would contend for one record.
 */

/** Written out rather than imported, for the reason `LeaseNameTruncation.test.ts` states. */
const DNS_1123_SUBDOMAIN = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;

describe('deriveLeaseName', () => {
  test('a name that is already a valid object name comes back unchanged', () => {
    expect(deriveLeaseName('orders-sharding-cart', 253)).toBe('orders-sharding-cart');
    expect(deriveLeaseName('orders-split-brain-resolver', 253)).toBe('orders-split-brain-resolver');
  });

  test('upper case is lowered, and the change is marked with a hash of the original', () => {
    const derived = deriveLeaseName('Orders-singleton-JobScheduler', 253);
    expect(derived).toMatch(/^orders-singleton-jobscheduler-[0-9a-z]{7}$/);
    expect(derived).toMatch(DNS_1123_SUBDOMAIN);
  });

  test('two names the cleaning maps onto one text stay two names', () => {
    // Without the hash these three would all be `orders-sharding-cart` and
    // contend for one record: the over-exclusion is harmless only until it
    // is two *different* consumers waiting on each other's lease.
    const clean = deriveLeaseName('orders-sharding-cart', 253);
    const capitalised = deriveLeaseName('orders-sharding-Cart', 253);
    const underscored = deriveLeaseName('orders_sharding-cart', 253);
    expect(new Set([clean, capitalised, underscored]).size).toBe(3);
  });

  test('anything outside lower-case letters, digits and the hyphen becomes one hyphen', () => {
    const derived = deriveLeaseName('my_app--sharding-Order Line/v2.1', 253);
    expect(derived).toMatch(/^my-app-sharding-order-line-v2-1-[0-9a-z]{7}$/);
  });

  test('a leading or trailing separator is dropped rather than kept', () => {
    // A label may neither begin nor end with `-`, so `_internal` must not
    // become `-internal`.
    expect(deriveLeaseName('_internal-singleton-x_', 253)).toMatch(/^internal-singleton-x-[0-9a-z]{7}$/);
  });

  test('a dot beside a separator is cleaned away rather than kept', () => {
    // The property below's counterexample against a cleaning that kept dots:
    // `_Z./Z` became `z.-z`, whose second label starts with `-`.
    const derived = deriveLeaseName('_Z./Z', 173);
    expect(derived).toMatch(/^z-z-[0-9a-z]{7}$/);
    expect(derived).toMatch(DNS_1123_SUBDOMAIN);
  });

  test('a name with nothing left after cleaning is the hash alone', () => {
    expect(deriveLeaseName('___', 253)).toMatch(/^[0-9a-z]{7}$/);
  });

  test('is a pure function of the name — every node derives the same object', () => {
    // The property the truncation already has, carried through the cleaning:
    // two nodes that disagreed would each hold their own record.
    expect(deriveLeaseName('Orders-singleton-Scheduler', 63)).toBe(deriveLeaseName('Orders-singleton-Scheduler', 63));
  });

  test('a long derived name is truncated to the bound and stays valid', () => {
    const derived = deriveLeaseName(`Orders-sharding-${'Entity'.repeat(60)}`, 63);
    expect(derived.length).toBeLessThanOrEqual(63);
    expect(derived).toMatch(DNS_1123_SUBDOMAIN);
    // Truncation runs over the cleaned name, hash included, so it is exactly
    // what `truncateLeaseName` makes of that — one rule for the length, not two.
    expect(derived).toBe(truncateLeaseName(deriveLeaseName(`Orders-sharding-${'Entity'.repeat(60)}`, 10_000), 63));
  });

  test('every input, at every bound the validator admits, yields a valid name within the bound', () => {
    // Two alphabets.  Arbitrary code points cover the long tail, but they
    // almost never put a `.` beside a separator, so a cleaning that kept dots
    // passed on them alone; the narrow alphabet is made of exactly the
    // characters a label's edges and separators are decided by.
    const edgeCharacters = fc.constantFrom('a', 'Z', '0', '9', '-', '.', '_', ' ', '/', 'É', 'İ');
    fc.assert(fc.property(
      fc.oneof(
        fc.string({ unit: 'binary', maxLength: 300 }),
        fc.string({ unit: edgeCharacters, maxLength: 300 }),
      ),
      fc.integer({ min: MINIMUM_LEASE_NAME_MAX_LENGTH, max: 253 }),
      (raw, maxLength) => {
        const derived = deriveLeaseName(raw, maxLength);
        return derived.length <= maxLength && DNS_1123_SUBDOMAIN.test(derived);
      },
    ));
  });
});
