import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ALL_PANELS_ACTIVE,
  FAKE_TAP_PROVIDERS,
  FakeTapSocket,
  fakeWelcome,
} from '../../app/testing/fakeTapSocket.js';
import { installDomGaps } from '../../app/testing/domGaps.js';
import { TapClientService } from '../../app/TapClientService.js';
import { ConfigPanelComponent } from './ConfigPanelComponent.js';
import type { ResolvedConfigEntry } from '../../../../src/devtools/protocol/index.js';

/**
 * The resolved-config panel (#553).
 *
 * The value alone is what a merged tree already gives you; what this panel
 * adds is the layer that won and whether it displaced anything, so that is
 * what most of this covers.
 */

function entry(overrides: Partial<ResolvedConfigEntry> = {}): ResolvedConfigEntry {
  return {
    path: 'actor-ts.system.shutdown-drain-timeout',
    value: '5s',
    source: 'reference',
    overridden: false,
    truncated: false,
    ...overrides,
  };
}

describe('ConfigPanelComponent', () => {
  let fixture: ComponentFixture<ConfigPanelComponent>;

  function mount(): void {
    TestBed.configureTestingModule({
      imports: [ConfigPanelComponent],
      providers: [provideZonelessChangeDetection(), ...FAKE_TAP_PROVIDERS],
    });
    TestBed.inject(TapClientService);
    FakeTapSocket.latest.opened();
    FakeTapSocket.latest.receives(fakeWelcome(ALL_PANELS_ACTIVE));
    fixture = TestBed.createComponent(ConfigPanelComponent);
    fixture.detectChanges();
  }

  async function answer(
    entries: readonly ResolvedConfigEntry[],
    extras: { applicationPath?: string | null; attributed?: boolean } = {},
  ): Promise<void> {
    FakeTapSocket.latest.respondTo('config.resolved', {
      entries,
      applicationPath: extras.applicationPath ?? null,
      attributed: extras.attributed ?? true,
    });
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  function rows(): HTMLElement[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement)
        .querySelectorAll('.dt-config__row:not(.dt-config__row--head)'),
    );
  }

  beforeEach(() => {
    installDomGaps();
    FakeTapSocket.reset();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('asks for the resolved config once, not on a poll', async () => {
    mount();
    await answer([entry()]);
    const requests = FakeTapSocket.latest.sentOf('request')
      .filter((frame) => frame['method'] === 'config.resolved');
    // Configuration is fixed when the system is built; there is nothing to
    // watch change, so polling would be a request per second for one answer.
    expect(requests).toHaveLength(1);
  });

  it('names the layer each key came from', async () => {
    mount();
    await answer([
      entry({ path: 'a.default', source: 'reference' }),
      entry({ path: 'a.from-file', source: 'application' }),
      entry({ path: 'a.from-code', source: 'override' }),
    ]);

    expect(rows()).toHaveLength(3);
    expect(rows()[0]!.textContent).toContain('reference.conf');
    expect(rows()[1]!.textContent).toContain('application.conf');
    expect(rows()[2]!.textContent).toContain('code');
  });

  it('says in the row title when a key displaced a lower layer', async () => {
    mount();
    await answer([entry({ source: 'override', overridden: true })]);

    expect(rows()[0]!.getAttribute('title')).toContain('overriding a lower layer');
  });

  it('filters to what differs from the defaults', async () => {
    mount();
    await answer([
      entry({ path: 'a.default', source: 'reference' }),
      entry({ path: 'a.changed', source: 'override' }),
    ]);
    expect(rows()).toHaveLength(2);

    const toggle = (fixture.nativeElement as HTMLElement)
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain('a.changed');
  });

  it('says nothing overrides the defaults, rather than showing an empty box', async () => {
    mount();
    await answer([entry({ source: 'reference' })]);

    const toggle = (fixture.nativeElement as HTMLElement)
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    // A worthwhile answer in its own right, and a different one from "no key
    // matches that filter".
    expect(text()).toContain('Nothing overrides the bundled defaults');
  });

  it('filters on key and on value', async () => {
    mount();
    await answer([
      entry({ path: 'actor-ts.cluster.port', value: 2551 }),
      entry({ path: 'actor-ts.system.name', value: 'orders' }),
    ]);

    const input = (fixture.nativeElement as HTMLElement)
      .querySelector('input[type="search"]') as HTMLInputElement;
    input.value = 'cluster';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(rows()).toHaveLength(1);

    input.value = 'orders';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain('actor-ts.system.name');
  });

  it('keeps a list readable as a list', async () => {
    mount();
    await answer([entry({ path: 'actor-ts.cluster.seed-nodes', value: ['a:1', 'b:2'] })]);
    expect(rows()[0]!.textContent).toContain('["a:1","b:2"]');
  });

  it('reports where application.conf was read from', async () => {
    mount();
    await answer([entry()], { applicationPath: '/srv/app/application.conf' });
    // "My file is ignored" and "my file says something else" are different
    // problems, and the path is what separates them.
    expect(text()).toContain('/srv/app/application.conf');

    TestBed.resetTestingModule();
    FakeTapSocket.reset();
    mount();
    await answer([entry()], { applicationPath: null });
    expect(text()).toContain('No application.conf was found');
  });

  it('admits when it cannot attribute sources instead of guessing', async () => {
    mount();
    await answer([entry()], { attributed: false });
    expect(text()).toContain('Sources are not available');
  });

  it('counts the keys, and how many the filter hid', async () => {
    mount();
    await answer([
      entry({ path: 'a.one' }),
      entry({ path: 'b.two' }),
      entry({ path: 'b.three' }),
    ]);
    expect(text()).toContain('3 keys');

    const input = (fixture.nativeElement as HTMLElement)
      .querySelector('input[type="search"]') as HTMLInputElement;
    input.value = 'b.';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(text()).toContain('2 of 3 keys');
  });
});
