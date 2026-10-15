import { describe, expect, test } from 'bun:test';

import { ClusterOptions, ClusterOptionsValidator } from '../../../src/cluster/ClusterOptions.js';
import type { ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { MAX_APP_VERSION_LENGTH } from '../../../src/cluster/Protocol.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * #843 — the application version a member states, for an operator to read
 * while a rolling update has old and new code in one cluster.
 *
 * Advisory and nothing else: nothing places, routes or downs on it.  What it
 * has to be is *true* and *harmless*, which is why most of what is pinned
 * here is about where a label comes from and what one may contain — it is
 * printed by `Member.toString`, by every log line that prints a member and by
 * `/cluster/members`, and a peer's label arrives off the wire.
 */

describe('the validator holds the label to what every peer admits', () => {
  const validate = (appVersion: unknown): void => {
    new ClusterOptionsValidator().validate({ appVersion } as Partial<ClusterOptionsType>);
  };

  test('the shapes version schemes actually use pass', () => {
    const labels = [
      '1.2.3',
      'v2.4.0-rc.1+build.5',
      '2026.10.15',
      'a1b2c3d',
      'release/1.2',
      'registry.example.com/orders:1.2.3',
      '1.2.3_hotfix',
      'x'.repeat(MAX_APP_VERSION_LENGTH),
    ];
    for (const label of labels) expect(() => validate(label), label).not.toThrow();
    expect(() => validate(undefined)).not.toThrow();
  });

  test('an empty label is refused rather than stated as nothing', () => {
    // What `${?APP_VERSION}` lands over a variable that is set to nothing.
    // Stating no version already has a spelling — an absent key — so an empty
    // one is a deployment that meant to set it and did not.
    expect(() => validate('')).toThrow(OptionsError);
  });

  test('a label over the cap is refused here, not dropped by every peer', () => {
    expect(() => validate('x'.repeat(MAX_APP_VERSION_LENGTH + 1))).toThrow(OptionsError);
  });

  test('a label that could forge or disguise a log line is refused', () => {
    // Control characters end a log line early or rewrite it; whitespace makes
    // two labels that print alike compare unequal; a bidi override reorders
    // what a terminal shows.  Visible ASCII has none of the three.
    const labels = [
      '1.2.3\nERROR forged line',
      '1.2.3\r',
      '1.2.3\t',
      '1.2.3 ',
      ' 1.2.3',
      '1.2.3 (build 42)',
      '1.2.3\u0000',
      '1.2.3\u007f',
      '1.2.3‮',
      'versión-1',
    ];
    for (const label of labels) expect(() => validate(label), JSON.stringify(label)).toThrow(OptionsError);
  });

  test('a value that is not a string is refused', () => {
    expect(() => validate(42)).toThrow(OptionsError);
  });

  test('the refusal names the field and says what a legal label looks like', () => {
    expect(() => validate('1.2.3\n')).toThrow(/appVersion/);
    expect(() => validate('1.2.3\n')).toThrow(new RegExp(`${MAX_APP_VERSION_LENGTH}`));
  });

  test('the builder sets the field the reader and the validator use', () => {
    const clusterOptions = ClusterOptions.create().withAppVersion('2.4.0');

    expect((clusterOptions as Partial<ClusterOptionsType>).appVersion).toBe('2.4.0');
  });
});
