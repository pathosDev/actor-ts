import { describe, expect, test } from 'bun:test';
import { BearerTokenAuth } from '../../../src/http/middleware/BearerToken.js';
import { IpAllowlist } from '../../../src/http/middleware/IpAllowlist.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import {
  DEVTOOLS_DEFAULTS,
  DevToolsOptions,
  DevToolsOptionsValidator,
  isLoopbackHost,
  type DevToolsOptionsType,
} from '../../../src/devtools/DevToolsOptions.js';

const validate = (options: Partial<DevToolsOptionsType>): void =>
  new DevToolsOptionsValidator().validate({ ...DEVTOOLS_DEFAULTS, ...options });

describe('DevToolsOptions builder', () => {
  test('a builder is structurally its settings', () => {
    const options = DevToolsOptions.create()
      .withPort(4444)
      .withHost('0.0.0.0')
      .withAllowRemote();
    expect({ ...options }).toEqual({ port: 4444, host: '0.0.0.0', allowRemote: true });
  });

  test('unset fields stay absent so defaults can fill them in', () => {
    expect(Object.keys({ ...DevToolsOptions.create().withPort(1) })).toEqual(['port']);
  });

  test('panels are set as a whole object', () => {
    const options = DevToolsOptions.create().withPanels({ timeTravel: false });
    expect({ ...options }).toEqual({ panels: { timeTravel: false } });
  });
});

describe('DevToolsOptions defaults', () => {
  test('bind loopback and serve the UI, without remote access', () => {
    expect(DEVTOOLS_DEFAULTS).toEqual({
      host: '127.0.0.1',
      port: 9333,
      allowRemote: false,
      serveUi: true,
    });
  });
});

describe('isLoopbackHost', () => {
  test('recognises the loopback spellings', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost', 'LOCALHOST']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test('treats a wildcard bind as remotely reachable — it is', () => {
    for (const host of ['0.0.0.0', '::', '10.0.0.5', 'example.internal']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('DevToolsOptionsValidator', () => {
  test('accepts the defaults', () => {
    expect(() => validate({})).not.toThrow();
  });

  test('rejects an out-of-range or fractional port', () => {
    expect(() => validate({ port: -1 })).toThrow(OptionsError);
    expect(() => validate({ port: 70_000 })).toThrow(OptionsError);
    expect(() => validate({ port: 8080.5 })).toThrow(OptionsError);
  });

  test('accepts port 0 — "pick a free port" is a real request', () => {
    expect(() => validate({ port: 0 })).not.toThrow();
  });

  test('rejects an empty host or UI development root', () => {
    expect(() => validate({ host: '' })).toThrow(OptionsError);
    expect(() => validate({ uiDevelopmentRoot: '' })).toThrow(OptionsError);
  });

  test('refuses a non-loopback bind that has no gate in front of it', () => {
    // The whole point of the validator: DevTools reads actor state, so
    // a routable interface must not be the result of a typo.
    expect(() => validate({ host: '0.0.0.0' })).toThrow(OptionsError);
    try {
      validate({ host: '0.0.0.0' });
    } catch (error) {
      expect((error as OptionsError).field).toBe('host');
      expect((error as OptionsError).message).toContain('allowRemote');
    }
  });

  test('accepts a non-loopback bind behind auth', () => {
    expect(() => validate({ host: '0.0.0.0', auth: BearerTokenAuth({ tokens: ['secret'] }) }))
      .not.toThrow();
  });

  test('accepts a non-loopback bind behind an IP allowlist', () => {
    expect(() => validate({ host: '10.0.0.5', ipAllowlist: IpAllowlist({ allow: ['10.0.0.0/8'] }) }))
      .not.toThrow();
  });

  test('accepts a non-loopback bind when the operator opts in explicitly', () => {
    expect(() => validate({ host: '0.0.0.0', allowRemote: true })).not.toThrow();
  });
});
