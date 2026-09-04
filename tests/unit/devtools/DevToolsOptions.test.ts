import { describe, expect, test } from 'bun:test';
import { BearerTokenAuth } from '../../../src/http/middleware/BearerToken.js';
import { IpAllowlist } from '../../../src/http/middleware/IpAllowlist.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { BUS_EVENT_BUFFER_DEFAULT } from '../../../src/devtools/protocol/EventStreamFrames.js';
import {
  DEVTOOLS_DEFAULTS,
  DevToolsOptions,
  DevToolsOptionsValidator,
  isLoopbackHost,
  mergeDevToolsOptions,
  type DevToolsOptionsType,
} from '../../../src/devtools/DevToolsOptions.js';

/** What `DevTools.attach` runs: defaults merged under the caller's options. */
const validate = (options: Partial<DevToolsOptionsType>): void =>
  new DevToolsOptionsValidator('attach').validate({ ...DEVTOOLS_DEFAULTS, ...options });

/** The same for `DevTools.mount` — the path with no host to reason from. */
const validateMount = (options: Partial<DevToolsOptionsType> = {}): void =>
  new DevToolsOptionsValidator('mount').validate({ ...DEVTOOLS_DEFAULTS, ...options });

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

  test('the two acknowledgements are separate fields', () => {
    // Naming lockstep, and a reminder that they are not interchangeable:
    // one accepts a routable bind, the other an ungated mount.
    expect({ ...DevToolsOptions.create().withAllowUngatedMount() })
      .toEqual({ allowUngatedMount: true });
    expect({ ...DevToolsOptions.create().withAllowUngatedMount(false) })
      .toEqual({ allowUngatedMount: false });
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
      allowUngatedMount: false,
      serveUi: true,
      mailboxSampleIntervalMs: 1_000,
      mailboxSampleLimit: 50,
      statsIntervalMs: 1_000,
      spanBufferCapacity: 10_000,
      spanFlushIntervalMs: 250,
      eventBufferCapacity: 500,
      eventFlushIntervalMs: 250,
      replayAutoCapture: true,
    });
  });

  test('every published leaf has a default here to be pinned against', () => {
    // #881 publishes these as `actor-ts.devtools.*`, and DocumentedDefaults
    // compares each literal to the constant beside it.  The two event fields
    // were literals at their read site in DevToolsServer until then, which is
    // a second written-down default the moment reference.conf carries one.
    expect(DEVTOOLS_DEFAULTS.eventBufferCapacity).toBe(BUS_EVENT_BUFFER_DEFAULT);
    expect(DEVTOOLS_DEFAULTS.eventFlushIntervalMs).toBe(DEVTOOLS_DEFAULTS.spanFlushIntervalMs);
  });
});

describe('mergeDevToolsOptions', () => {
  test('explicit options beat the config file, which beats the defaults', () => {
    const settings = mergeDevToolsOptions({ host: '0.0.0.0', port: 4444 }, { port: 5555 });
    expect(settings.port).toBe(5555);
    expect(settings.host).toBe('0.0.0.0');
    expect(settings.serveUi).toBe(true); // untouched by either layer
  });

  test('an option the caller never set does not shadow the config file', () => {
    // The `mergeOptions` rule: `undefined` means "not set", not "cleared".
    const settings = mergeDevToolsOptions({ port: 4444 }, { port: undefined });
    expect(settings.port).toBe(4444);
  });

  test('an explicit panels object overrides switch by switch, not wholesale', () => {
    // The security-relevant departure from the shallow merge.  A whole-object
    // replacement would switch `send` — and time travel, dead letters and the
    // event stream — back on because the caller mentioned one unrelated panel.
    const settings = mergeDevToolsOptions(
      { panels: { send: false, timeTravel: true, actors: true } },
      { panels: { timeTravel: false } },
    );
    expect(settings.panels).toEqual({ send: false, timeTravel: false, actors: true });
  });

  test('either side alone is used as it stands', () => {
    expect(mergeDevToolsOptions({ panels: { send: false } }, {}).panels).toEqual({ send: false });
    expect(mergeDevToolsOptions({}, { panels: { send: false } }).panels).toEqual({ send: false });
    expect(mergeDevToolsOptions({}, {}).panels).toBeUndefined();
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

// #594 — the attach rule reads `host`, which is exactly the fact a mount
// does not have: the routes go to a server this process never sees, bound
// to an interface it is never told about.  With the loopback default
// merged in, every ungated mount used to look as safe as a laptop's.
describe('DevToolsOptionsValidator — the mount path', () => {
  test('refuses a mount that has no gate in front of it', () => {
    expect(() => validateMount()).toThrow(OptionsError);
    try {
      validateMount();
    } catch (error) {
      expect((error as OptionsError).field).toBe('allowUngatedMount');
      // The message has to name every way out, the same as the bind rule's.
      expect((error as OptionsError).message).toContain('auth');
      expect((error as OptionsError).message).toContain('ipAllowlist');
      expect((error as OptionsError).message).toContain('allowUngatedMount');
    }
  });

  test('a loopback host does not stand in for the gate', () => {
    // The trap this fix exists for.  `host` defaults to loopback and is
    // never read on the mount path, so accepting it as proof would leave
    // the default configuration ungated — which is what it did.
    expect(() => validateMount({ host: '127.0.0.1' })).toThrow(OptionsError);
  });

  test('`allowRemote` is not the mount acknowledgement', () => {
    // Deliberately distinct: `allowRemote` says "I accept this *bind*",
    // and a mount never binds.  Reusing it would let an operator who
    // configured the attach path inherit a decision they never made.
    expect(() => validateMount({ allowRemote: true })).toThrow(OptionsError);
  });

  test('accepts a mount gated by auth or an IP allowlist', () => {
    // Both wrap the returned tree itself, so the gate travels with it
    // wherever the caller binds it — no acknowledgement needed.
    expect(() => validateMount({ auth: BearerTokenAuth({ tokens: ['secret'] }) })).not.toThrow();
    expect(() => validateMount({ ipAllowlist: IpAllowlist({ allow: ['10.0.0.0/8'] }) }))
      .not.toThrow();
  });

  test('accepts a mount the operator acknowledges', () => {
    expect(() => validateMount({ allowUngatedMount: true })).not.toThrow();
  });

  test('the non-security rules apply on both paths', () => {
    // The exposure switch must not become an early return that skips the
    // field checks — it sits after them for that reason.
    expect(() => validateMount({ allowUngatedMount: true, port: 70_000 })).toThrow(OptionsError);
    expect(() => validateMount({ allowUngatedMount: true, mailboxSampleLimit: 0 }))
      .toThrow(OptionsError);
  });
});
