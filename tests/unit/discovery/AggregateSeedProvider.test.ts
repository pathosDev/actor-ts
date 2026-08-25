/**
 * #943 — the aggregate's empty-vs-threw line.
 *
 * An empty *return* is an authoritative "no peers" and keeps the unconfigured
 * single-node flow self-electing; an all-threw chain is "discovery did not
 * answer" and must reject, because handing the caller `[]` there is what
 * turned a transient DNS outage into a permanently self-elected cluster of
 * one.  The #597 contract — one rejected rung degrades that rung only — is
 * asserted alongside, so the new rejection cannot swallow it.
 */
import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { AggregateSeedProvider, SeedDiscoveryError } from '../../../src/discovery/AggregateSeedProvider.js';
import type { SeedProvider } from '../../../src/discovery/SeedProvider.js';

const peer = new NodeAddress('app', '10.0.0.9', 2552);

function throwing(message: string): SeedProvider & { calls: number } {
  return {
    calls: 0,
    async lookup(): Promise<NodeAddress[]> {
      this.calls++;
      throw new Error(message);
    },
  };
}

function returning(addresses: ReadonlyArray<NodeAddress>): SeedProvider & { calls: number } {
  return {
    calls: 0,
    async lookup(): Promise<NodeAddress[]> {
      this.calls++;
      return [...addresses];
    },
  };
}

describe('AggregateSeedProvider — empty vs threw (#943)', () => {
  test('zero providers resolve to an empty list', async () => {
    expect(await new AggregateSeedProvider([]).lookup()).toEqual([]);
  });

  test('an all-threw chain rejects with SeedDiscoveryError carrying every error in order', async () => {
    const provider = new AggregateSeedProvider([throwing('k8s down'), throwing('dns down')]);
    let caught: unknown;
    try {
      await provider.lookup();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SeedDiscoveryError);
    const err = caught as SeedDiscoveryError;
    expect(err.name).toBe('SeedDiscoveryError');
    expect(err.errors.length).toBe(2);
    expect((err.errors[0] as Error).message).toBe('k8s down');
    expect((err.errors[1] as Error).message).toBe('dns down');
    expect(err.message).toContain('k8s down');
    expect(err.message).toContain('dns down');
  });

  test('a throwing rung falls through to a non-empty one (#597)', async () => {
    const second = returning([peer]);
    const seeds = await new AggregateSeedProvider([throwing('k8s down'), second]).lookup();
    expect(seeds.map((address) => address.toString())).toEqual(['app@10.0.0.9:2552']);
  });

  test('throw-then-empty-return resolves [] — an empty answer is authoritative', async () => {
    const provider = new AggregateSeedProvider([throwing('k8s down'), returning([])]);
    expect(await provider.lookup()).toEqual([]);
  });

  test('the first non-empty rung short-circuits the rest', async () => {
    const first = returning([peer]);
    const never = returning([peer]);
    await new AggregateSeedProvider([first, never]).lookup();
    expect(first.calls).toBe(1);
    expect(never.calls).toBe(0);
  });
});
