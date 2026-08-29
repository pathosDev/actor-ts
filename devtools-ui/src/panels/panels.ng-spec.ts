import { provideZonelessChangeDetection, type Type } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ALL_PANELS_ACTIVE, FAKE_TAP_PROVIDERS, FakeTapSocket, fakeWelcome } from '../app/testing/fakeTapSocket.js';
import { installDomGaps } from '../app/testing/domGaps.js';
import { TapClientService } from '../app/TapClientService.js';
import { ActorsPanelComponent } from './actors/ActorsPanelComponent.js';
import { ClusterPanelComponent } from './cluster/ClusterPanelComponent.js';
import { ConfigPanelComponent } from './config/ConfigPanelComponent.js';
import { DeadLettersPanelComponent } from './deadletters/DeadLettersPanelComponent.js';
import { EventStreamPanelComponent } from './eventstream/EventStreamPanelComponent.js';
import { DashboardPanelComponent } from './dashboard/DashboardPanelComponent.js';
import { ExplainPanelComponent } from './explain/ExplainPanelComponent.js';
import { ProfilerPanelComponent } from './profiler/ProfilerPanelComponent.js';
import { SendPanelComponent } from './send/SendPanelComponent.js';
import { TimeTravelPanelComponent } from './timetravel/TimeTravelPanelComponent.js';
import { TracingPanelComponent } from './tracing/TracingPanelComponent.js';

/**
 * One test per panel: it mounts against a connected tap, and says something
 * useful before any data arrives.
 *
 * The empty state is the deliberate target rather than an incidental one.  It
 * is what a reader actually meets first, it is where a panel is most likely to
 * read as broken when it is merely idle — the tracing panel's whole empty state
 * exists because "nothing yet" looked like a fault next to an overview counting
 * hundreds of messages a minute — and it is the only state reachable in jsdom,
 * which has no canvas for ECharts to draw on.  Every panel here guards its
 * chart behind an "is there data" branch, so asserting the empty state
 * exercises that guard rather than working around its absence.
 *
 * What this covers that nothing else does: that each panel can be constructed,
 * injected and rendered at all.  Every one of them subscribes to a stream, sets
 * up a clock or issues a request on construction, and a mistake in any of that
 * is a blank panel in a tool whose job is to explain a system.
 */

type PanelCase = {
  readonly name: string;
  readonly component: Type<unknown>;
  /** Text the panel must show before any data arrives. */
  readonly expects: readonly string[];
};

const PANELS: readonly PanelCase[] = [
  {
    name: 'dashboard',
    component: DashboardPanelComponent,
    expects: ['Overview', 'waiting for first sample', 'Every mailbox is empty'],
  },
  {
    name: 'actors',
    component: ActorsPanelComponent,
    expects: ['Actors', 'Waiting for the actor tree'],
  },
  {
    name: 'cluster',
    component: ClusterPanelComponent,
    expects: ['Cluster', 'Waiting for cluster state', 'No shard map yet'],
  },
  {
    name: 'tracing',
    component: TracingPanelComponent,
    // The long explanation is the point: an idle system shows a message rate on
    // the overview while this list stays empty, and that is not a fault.
    expects: ['Tracing', 'Recording. Nothing from your actors yet', 'that traffic is the tool'],
  },
  {
    name: 'explain',
    component: ExplainPanelComponent,
    expects: ['Explain plan', 'Pick an actor to begin'],
  },
  {
    name: 'time-travel',
    component: TimeTravelPanelComponent,
    expects: ['Time travel', 'Pick a persistence id'],
  },
  {
    name: 'profiler',
    component: ProfilerPanelComponent,
    expects: ['Profiler', 'Start a session to profile the system', 'No profile yet'],
  },
  {
    name: 'dead-letters',
    component: DeadLettersPanelComponent,
    expects: ['Dead letters', 'Loading'],
  },
  {
    name: 'event-stream',
    component: EventStreamPanelComponent,
    // The long explanation is the point: nothing is recorded until the
    // panel is open, so an idle system shows nothing and that is not a fault.
    expects: ['Event stream', 'Waiting for the first event', 'Cluster topics'],
  },
  {
    name: 'config',
    component: ConfigPanelComponent,
    expects: ['Configuration', 'Loading'],
  },
  {

    name: 'send',
    component: SendPanelComponent,
    expects: ['Send message', 'Waiting for the actor tree', 'Nothing sent yet'],
  },
];

describe('panels', () => {
  let fixture: ComponentFixture<unknown>;

  beforeEach(() => {
    installDomGaps();
    FakeTapSocket.reset();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  for (const panel of PANELS) {
    it(`${panel.name} mounts and explains itself before any data arrives`, () => {
      TestBed.configureTestingModule({
        imports: [panel.component],
        providers: [provideZonelessChangeDetection(), ...FAKE_TAP_PROVIDERS],
      });
      TestBed.inject(TapClientService);
      FakeTapSocket.latest.opened();
      FakeTapSocket.latest.receives(fakeWelcome(ALL_PANELS_ACTIVE));

      fixture = TestBed.createComponent(panel.component);
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      for (const expected of panel.expects) expect(text).toContain(expected);
    });
  }

  it('every panel unsubscribes from its streams when destroyed', () => {
    // The refcount is what stops the actor system producing frames for a panel
    // nobody is looking at.  A panel that forgets its teardown is invisible
    // locally and expensive on the server.
    for (const panel of PANELS) {
      FakeTapSocket.reset();
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [panel.component],
        providers: [provideZonelessChangeDetection(), ...FAKE_TAP_PROVIDERS],
      });
      TestBed.inject(TapClientService);
      FakeTapSocket.latest.opened();
      FakeTapSocket.latest.receives(fakeWelcome(ALL_PANELS_ACTIVE));

      const created = TestBed.createComponent(panel.component);
      created.detectChanges();
      const subscribed = FakeTapSocket.latest.sentOf('subscribe').length;
      created.destroy();

      expect(FakeTapSocket.latest.sentOf('unsubscribe').length,
        `${panel.name} left ${subscribed} subscription(s) open`)
        .toBe(subscribed);
    }
  });
});
