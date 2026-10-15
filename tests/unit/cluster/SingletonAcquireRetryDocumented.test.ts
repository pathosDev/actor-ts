/**
 * #1494 — a drift guard over where
 * `DEFAULT_SINGLETON_ACQUIRE_RETRY_INTERVAL_MS` says its retry can be reached.
 *
 * Its doc comment said the retry was only reachable where a `Lease` was passed
 * in code, "since HOCON has no way to name one".  #1454 made that false:
 * `actor-ts.cluster.singleton.use-lease` gives the singleton a lease built from
 * `actor-ts.coordination.lease`, and `ClusterSingletonLease.test.ts` runs this
 * very retry on one configured from HOCON alone ("use-lease = on gates the
 * singleton on a lease nobody passed in code").  The change that made the
 * comment false rewrote its sharding twin and missed it, because nothing read
 * it.
 *
 * The markers are keys rather than sentences, and they come from `ConfigKeys`,
 * so a rename moves the expectation and a comment left on the old spelling goes
 * red.  The one sentence-level marker is the retired clause itself: adding the
 * new route beside the old claim is the cheapest wrong fix, and it satisfies
 * every key marker.
 *
 * Refs #1454, #1494.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const CONSTANTS_SOURCE = 'src/cluster/Constants.ts';

/** Anchored at a line start, so a mention inside another comment is not the declaration. */
const DECLARATION = /^export const DEFAULT_SINGLETON_ACQUIRE_RETRY_INTERVAL_MS\b/m;

/**
 * The doc comment attached to the declaration: the last `/**` block before it,
 * read to its own close, with nothing but whitespace and plain comments between
 * that close and the declaration.  Those plain comments are no part of it, and
 * neither is the neighbouring constant's doc — which is what keeps a key
 * written in either from counting as this constant's documentation.
 */
function documentationOf(source: string): string {
  const declared = DECLARATION.exec(source);
  if (declared === null) {
    throw new Error(
      `${CONSTANTS_SOURCE}: DEFAULT_SINGLETON_ACQUIRE_RETRY_INTERVAL_MS is gone — re-point this guard.`,
    );
  }
  const openedAt = source.lastIndexOf('/**', declared.index);
  const closedAt = openedAt < 0 ? -1 : source.indexOf('*/', openedAt + 3);
  const attached = closedAt >= 0 && closedAt < declared.index && source
    .slice(closedAt + 2, declared.index)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .trim() === '';
  if (!attached) {
    throw new Error(
      `${CONSTANTS_SOURCE}: no doc comment sits directly above DEFAULT_SINGLETON_ACQUIRE_RETRY_INTERVAL_MS.`,
    );
  }
  return source.slice(openedAt + 3, closedAt);
}

/**
 * What a reader is shown: the gutters stripped, the lines rejoined, and HTML
 * comments dropped, since a hover renders nothing of them.
 */
function proseOf(documentation: string): string {
  return documentation
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `key` itself or a leaf under it — never a longer word that merely starts with it. */
function keyPattern(key: string): RegExp {
  return new RegExp(`${key.split('.').join('\\.')}(?![\\w-])`);
}

const prose = proseOf(documentationOf(readFileSync(join(REPOSITORY_ROOT, CONSTANTS_SOURCE), 'utf8')));

/**
 * The same prose with a key's line break undone.  This file breaks a long key
 * at a dot, as it does `restart-on-termination`, so only a space beside a dot
 * inside a key is dropped: a key followed by a word keeps the space that ends
 * it, where dropping every space would glue the two into one longer word.
 */
const keyProse = prose.replace(/\s+(?=\.[\w-])/g, '').replace(/(?<=[\w-]\.)\s+(?=[\w-])/g, '');

/** `actor-ts.coordination.lease`: the block the backend selector lives in. */
const LEASE_BLOCK = ConfigKeys.coordination.lease.backend.slice(
  0,
  ConfigKeys.coordination.lease.backend.lastIndexOf('.'),
);

describe('DEFAULT_SINGLETON_ACQUIRE_RETRY_INTERVAL_MS names every route to a lease (#1494)', () => {
  test('names the switch that builds the singleton a lease from configuration', () => {
    expect(keyProse).toMatch(keyPattern(ConfigKeys.cluster.singleton.useLease));
  });

  test('names the block that lease is built from', () => {
    expect(keyProse).toMatch(keyPattern(LEASE_BLOCK));
  });

  test('still names the route in code, which wins over the switch', () => {
    expect(prose).toMatch(/\bin code\b|\bwithLease\b/);
  });

  test('no longer says HOCON cannot reach a lease', () => {
    expect(prose).not.toMatch(/HOCON has no way to name/i);
  });
});
