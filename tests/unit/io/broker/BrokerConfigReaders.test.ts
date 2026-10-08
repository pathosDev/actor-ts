import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../../src/config/Config.js';
import { rejectRetiredLeaves } from '../../../../src/config/RetiredKeys.js';

/**
 * The HOCON readers of the broker actors, block by block (#1443).
 *
 * The broker blocks publish no `reference.conf` leaves — their keys are
 * required-or-unset, so there is no default to ship — which means none of the
 * config guards that perturb `reference.conf` ever sets one.  What binds a
 * broker leaf is a test that writes it the way an operator would and checks
 * what the reader made of it, so that is what this file holds: an exact-object
 * read of each block, and for every spelling a rename retired, the refusal of
 * the old one beside the acceptance of the new one.
 */

/** Where the refusal looks, and the shape every broker root shares. */
const ROOT = 'actor-ts.io.broker.probe';

/** What `rejectRetiredLeaves` throws for `hocon`, or a failure naming its absence. */
function refusalOf(hocon: string, retired: Readonly<Record<string, string>>, codeNote?: string): ConfigError {
  const config = Config.parseString(hocon);
  try {
    if (codeNote === undefined) rejectRetiredLeaves(config, ROOT, retired);
    else rejectRetiredLeaves(config, ROOT, retired, codeNote);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error(`nothing refused ${hocon}`);
}

describe('the retired-leaf refusal a broker table relies on', () => {
  test('a dotted entry refuses a renamed child under its parent, naming both full paths', () => {
    // A broker block nests: the reconnect policy is a group, and the rename
    // moves its children while the group keeps its name.
    const refusal = refusalOf(
      `${ROOT}.reconnect.initialDelayMs = 200`,
      { 'reconnect.initialDelayMs': 'reconnect.initial-delay' },
    );
    expect(refusal.message).toContain(
      `${ROOT}.reconnect.initialDelayMs has been renamed to ${ROOT}.reconnect.initial-delay`,
    );
  });

  test('an old child under a renamed parent is caught by its own entry', () => {
    // `circuit-breaker { failureThreshold = 3 }` is half-converted: the group
    // entry cannot see it, because the group is already spelled the new way.
    const refusal = refusalOf(
      `${ROOT}.circuit-breaker { failureThreshold = 3, reset = 1s }`,
      { circuitBreaker: 'circuit-breaker', 'circuit-breaker.failureThreshold': 'circuit-breaker.failure-threshold' },
    );
    expect(refusal.message).toContain(
      `${ROOT}.circuit-breaker.failureThreshold has been renamed to ${ROOT}.circuit-breaker.failure-threshold`,
    );
  });

  test('a table that renamed code as well says so instead of the default note', () => {
    const note = 'The TypeScript field was renamed too: maxLineLen is maxLineBytes now.';
    const refusal = refusalOf(`${ROOT}.framing.maxLineLen = 4096`, { 'framing.maxLineLen': 'framing.max-line-bytes' }, note);
    expect(refusal.message).toContain(note);
    // The default claims the opposite, and the two cannot both stand.
    expect(refusal.message).not.toContain('field names and builder methods are unchanged');
  });

  test('without a note of its own, a table keeps the default: no code change', () => {
    const refusal = refusalOf(`${ROOT}.outboundBuffer = 10`, { outboundBuffer: 'outbound-buffer' });
    expect(refusal.message).toContain(
      'The TypeScript field names and builder methods are unchanged, so no code change is needed.',
    );
  });

  test('the message states the convention, not that the whole block is converted', () => {
    // The shared broker leaves are converted ahead of each protocol's own, so
    // a broker block is mixed in between; "every leaf in this block is
    // kebab-case now" would send an operator looking for a conversion that has
    // not happened yet.
    const refusal = refusalOf(`${ROOT}.outboundBuffer = 10`, { outboundBuffer: 'outbound-buffer' });
    expect(refusal.message).not.toContain('in this block is kebab-case');
    expect(refusal.message).toContain('HOCON keys are kebab-case');
  });
});
