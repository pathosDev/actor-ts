import { describe, expect, test } from 'bun:test';
import { OptionsError, OptionsValidator } from '../../../src/util/OptionsValidator.js';

interface Sample {
  readonly pos?: number;
  readonly count?: number;
  readonly nnNum?: number;
  readonly nnInt?: number;
  readonly ranged?: number;
  readonly port?: number;
  readonly mode?: 'a' | 'b' | 'c';
  readonly version?: 4 | 5;
  readonly name?: string;
  readonly seeds?: readonly string[];
  readonly endpoint?: string;
  readonly low?: number;
  readonly high?: number;
}

/** Exercises every helper; each field is validated only if the flag names it. */
class SampleValidator extends OptionsValidator<Sample> {
  constructor(private readonly enabled: ReadonlySet<string> = new Set()) {
    super('SampleOptions');
  }
  protected rules(s: Partial<Sample>): void {
    if (this.enabled.has('pos')) this.positiveNumber('pos');
    if (this.enabled.has('count')) this.positiveInt('count');
    if (this.enabled.has('nnNum')) this.nonNegativeNumber('nnNum');
    if (this.enabled.has('nnInt')) this.nonNegativeInt('nnInt');
    if (this.enabled.has('ranged')) this.numberInRange('ranged', 1, 10);
    if (this.enabled.has('port')) this.port('port');
    if (this.enabled.has('mode')) this.oneOf('mode', ['a', 'b', 'c']);
    if (this.enabled.has('version')) this.oneOf('version', [4, 5]);
    if (this.enabled.has('name')) this.nonEmptyString('name');
    if (this.enabled.has('seeds')) this.nonEmptyArray('seeds');
    if (this.enabled.has('endpoint')) this.url('endpoint', ['mqtt', 'mqtts']);
    if (this.enabled.has('cross') && s.low !== undefined && s.high !== undefined && s.high <= s.low) {
      this.fail('high', 'must exceed low', s.high);
    }
  }
}

const validate = (fields: string[], settings: Partial<Sample>): void =>
  new SampleValidator(new Set(fields)).validate(settings);

describe('OptionsValidator — unset fields', () => {
  test('an unset field always passes (no rule fires)', () => {
    expect(() => validate(['pos', 'port', 'mode', 'name'], {})).not.toThrow();
  });

  test('an explicit undefined is treated as unset', () => {
    expect(() => validate(['pos'], { pos: undefined })).not.toThrow();
  });
});

describe('OptionsValidator — numeric helpers', () => {
  test('positiveNumber accepts > 0, rejects 0 / negative / non-finite', () => {
    expect(() => validate(['pos'], { pos: 0.5 })).not.toThrow();
    expect(() => validate(['pos'], { pos: 0 })).toThrow(OptionsError);
    expect(() => validate(['pos'], { pos: -1 })).toThrow(OptionsError);
    expect(() => validate(['pos'], { pos: Infinity })).toThrow(OptionsError);
  });

  test('positiveInt accepts >= 1 integers, rejects 0 / fractional', () => {
    expect(() => validate(['count'], { count: 1 })).not.toThrow();
    expect(() => validate(['count'], { count: 0 })).toThrow(OptionsError);
    expect(() => validate(['count'], { count: 1.5 })).toThrow(OptionsError);
  });

  test('nonNegativeNumber accepts 0 and positive, rejects negative', () => {
    expect(() => validate(['nnNum'], { nnNum: 0 })).not.toThrow();
    expect(() => validate(['nnNum'], { nnNum: -0.1 })).toThrow(OptionsError);
  });

  test('nonNegativeInt accepts 0, rejects fractional and negative', () => {
    expect(() => validate(['nnInt'], { nnInt: 0 })).not.toThrow();
    expect(() => validate(['nnInt'], { nnInt: -1 })).toThrow(OptionsError);
    expect(() => validate(['nnInt'], { nnInt: 2.5 })).toThrow(OptionsError);
  });

  test('numberInRange respects inclusive bounds', () => {
    expect(() => validate(['ranged'], { ranged: 1 })).not.toThrow();
    expect(() => validate(['ranged'], { ranged: 10 })).not.toThrow();
    expect(() => validate(['ranged'], { ranged: 0 })).toThrow(OptionsError);
    expect(() => validate(['ranged'], { ranged: 11 })).toThrow(OptionsError);
  });

  test('port accepts 1 and 65535, rejects 0 / 65536', () => {
    expect(() => validate(['port'], { port: 1 })).not.toThrow();
    expect(() => validate(['port'], { port: 65535 })).not.toThrow();
    expect(() => validate(['port'], { port: 0 })).toThrow(OptionsError);
    expect(() => validate(['port'], { port: 65536 })).toThrow(OptionsError);
  });
});

describe('OptionsValidator — enum / string / array helpers', () => {
  test('oneOf accepts listed values, rejects others', () => {
    expect(() => validate(['mode'], { mode: 'b' })).not.toThrow();
    expect(() => validate(['version'], { version: 4 })).not.toThrow();
    expect(() => validate(['version'], { version: 6 as unknown as 4 })).toThrow(OptionsError);
  });

  test('nonEmptyString rejects the empty string', () => {
    expect(() => validate(['name'], { name: 'x' })).not.toThrow();
    expect(() => validate(['name'], { name: '' })).toThrow(OptionsError);
  });

  test('nonEmptyArray rejects the empty array', () => {
    expect(() => validate(['seeds'], { seeds: ['a'] })).not.toThrow();
    expect(() => validate(['seeds'], { seeds: [] })).toThrow(OptionsError);
  });
});

describe('OptionsValidator — url helper', () => {
  test('accepts a listed protocol', () => {
    expect(() => validate(['endpoint'], { endpoint: 'mqtt://host:1883' })).not.toThrow();
    expect(() => validate(['endpoint'], { endpoint: 'mqtts://host:8883' })).not.toThrow();
  });

  test('rejects an unlisted protocol', () => {
    expect(() => validate(['endpoint'], { endpoint: 'http://host' })).toThrow(OptionsError);
  });

  test('rejects an unparseable URL', () => {
    expect(() => validate(['endpoint'], { endpoint: 'not a url' })).toThrow(OptionsError);
  });
});

describe('OptionsValidator — cross-field via fail()', () => {
  test('passes when the relation holds', () => {
    expect(() => validate(['cross'], { low: 1, high: 2 })).not.toThrow();
  });

  test('throws when the relation is violated', () => {
    expect(() => validate(['cross'], { low: 5, high: 5 })).toThrow(/high must exceed low/);
  });

  test('does not fire when a participant is unset', () => {
    expect(() => validate(['cross'], { low: 5 })).not.toThrow();
  });
});

describe('OptionsError shape and message', () => {
  test('carries options / field / value', () => {
    try {
      validate(['version'], { version: 6 as unknown as 4 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OptionsError);
      const err = e as OptionsError;
      expect(err.name).toBe('OptionsError');
      expect(err.options).toBe('SampleOptions');
      expect(err.field).toBe('version');
      expect(err.value).toBe(6);
    }
  });

  test('message is prefixed with the options name and includes the value', () => {
    expect(() => validate(['name'], { name: '' })).toThrow(
      'SampleOptions: name must be a non-empty string (got "")',
    );
  });

  test('oneOf message lists the allowed literals', () => {
    expect(() => validate(['version'], { version: 6 as unknown as 4 })).toThrow(
      'SampleOptions: version must be one of 4, 5 (got 6)',
    );
  });
});

describe('OptionsValidator — misuse guard', () => {
  test('a check helper called outside rules() throws', () => {
    class Leaky extends OptionsValidator<Sample> {
      constructor() {
        super('Leaky');
      }
      protected rules(): void {
        /* no-op */
      }
      leak(): void {
        this.positiveNumber('pos');
      }
    }
    expect(() => new Leaky().leak()).toThrow(/must be called from within rules/);
  });
});
