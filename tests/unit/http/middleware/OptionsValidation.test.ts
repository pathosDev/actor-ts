import { describe, expect, test } from 'bun:test';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import { TimeoutOptionsValidator } from '../../../../src/http/middleware/TimeoutOptions.js';
import { HstsOptionsValidator } from '../../../../src/http/middleware/HstsOptions.js';
import { CorsOptionsValidator } from '../../../../src/http/middleware/CorsOptions.js';
import { CsrfOptionsValidator } from '../../../../src/http/middleware/CsrfOptions.js';
import { StaticFilesOptionsValidator } from '../../../../src/http/static/StaticFilesOptions.js';
import { RateLimitOptions, RateLimitOptionsValidator } from '../../../../src/http/cache/RateLimitOptions.js';
import { IdempotencyOptions, IdempotencyOptionsValidator } from '../../../../src/http/cache/IdempotencyOptions.js';

// WP7 — the HTTP middleware / directive options merged after the options-
// validator sweep and were only checked with ad-hoc bare `Error`s (or not at
// all). They now validate through OptionsValidator, throwing OptionsError.
describe('HTTP middleware option validators', () => {
  test('TimeoutOptions.ms must be a positive finite number', () => {
    const validator = new TimeoutOptionsValidator();
    expect(() => validator.validate({ ms: 0 })).toThrow(OptionsError);
    expect(() => validator.validate({ ms: -1 })).toThrow(/ms/);
    expect(() => validator.validate({ ms: Number.NaN })).toThrow(/ms/);
    expect(() => validator.validate({ ms: 30_000 })).not.toThrow();
    expect(() => validator.validate({})).not.toThrow();   // unset → default later
  });

  test('HstsOptions: maxAge non-negative + preload cross-field', () => {
    const validator = new HstsOptionsValidator();
    expect(() => validator.validate({ maxAge: -1 })).toThrow(OptionsError);
    // preload requires maxAge >= 1 year AND includeSubDomains
    expect(() => validator.validate({ preload: true, maxAge: 100, includeSubDomains: true })).toThrow(/preload/);
    expect(() => validator.validate({ preload: true, maxAge: 31_536_000, includeSubDomains: false })).toThrow(/preload/);
    expect(() => validator.validate({ preload: true, maxAge: 31_536_000, includeSubDomains: true })).not.toThrow();
    expect(() => validator.validate({ preload: false, maxAge: 0 })).not.toThrow();
  });

  test('CorsOptions: maxAge non-negative + credentials forbidden with "*"', () => {
    const validator = new CorsOptionsValidator();
    expect(() => validator.validate({ maxAge: -5 })).toThrow(/maxAge/);
    expect(() => validator.validate({ credentials: true, origins: '*' })).toThrow(OptionsError);
    expect(() => validator.validate({ credentials: true, origins: ['https://app.example.com'] })).not.toThrow();
    expect(() => validator.validate({ credentials: false, origins: '*', maxAge: 600 })).not.toThrow();
  });

  test('CsrfOptions: present secret >= 16 bytes + cookie enums', () => {
    const validator = new CsrfOptionsValidator();
    expect(() => validator.validate({ secret: 'too-short' })).toThrow(/secret/);
    expect(() => validator.validate({ secret: 'x'.repeat(32) })).not.toThrow();
    expect(() => validator.validate({ secret: new Uint8Array(8) })).toThrow(OptionsError);
    expect(() => validator.validate({ secret: new Uint8Array(32) })).not.toThrow();
    expect(() => validator.validate({ secret: 'x'.repeat(16), cookie: { sameSite: 'bogus' as never } })).toThrow(/sameSite/);
    expect(() => validator.validate({ secret: 'x'.repeat(16), cookie: { maxAgeSeconds: -1 } })).toThrow(/maxAgeSeconds/);
    expect(() => validator.validate({})).not.toThrow();   // missing secret is a required-field concern, not this validator's
  });

  test('StaticFilesOptions: maxFileSize positive int + policy enums', () => {
    const validator = new StaticFilesOptionsValidator();
    expect(() => validator.validate({ maxFileSize: 0 })).toThrow(/maxFileSize/);
    expect(() => validator.validate({ maxFileSize: 2.5 })).toThrow(OptionsError);
    expect(() => validator.validate({ dotfiles: 'nope' as never })).toThrow(/dotfiles/);
    expect(() => validator.validate({ symlinks: 'maybe' as never })).toThrow(/symlinks/);
    expect(() => validator.validate({ maxFileSize: 1_048_576, dotfiles: 'allow', symlinks: 'follow' })).not.toThrow();
  });
});

describe('rateLimit / idempotent option builders + validators', () => {
  test('RateLimitOptions builder feeds the same fields as a plain object', () => {
    const built = RateLimitOptions.create().withWindowMs(60_000).withMax(100).withKeyPrefix('rl:');
    expect({ ...built }).toMatchObject({ windowMs: 60_000, max: 100, keyPrefix: 'rl:' });
    const validator = new RateLimitOptionsValidator();
    expect(() => validator.validate({ ...built })).not.toThrow();
    expect(() => validator.validate({ windowMs: 0, max: 100 })).toThrow(/windowMs/);
    expect(() => validator.validate({ windowMs: 60_000, max: 0 })).toThrow(OptionsError);
    expect(() => validator.validate({ windowMs: 60_000, max: -1 })).toThrow(/max/);
  });

  test('IdempotencyOptions builder + validator', () => {
    const built = IdempotencyOptions.create().withTtlMs(3_600_000).withMissingHeader('pass-through');
    expect({ ...built }).toMatchObject({ ttlMs: 3_600_000, missingHeader: 'pass-through' });
    const validator = new IdempotencyOptionsValidator();
    expect(() => validator.validate({ ...built })).not.toThrow();
    expect(() => validator.validate({ ttlMs: 0 })).toThrow(/ttlMs/);
    expect(() => validator.validate({ missingHeader: 'bogus' as never })).toThrow(/missingHeader/);
  });
});
