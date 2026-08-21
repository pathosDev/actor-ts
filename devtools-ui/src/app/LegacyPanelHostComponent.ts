import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';

import { currentRoute } from '../core/router.js';
import { findPanel, type PanelInstance } from '../shell/PanelRegistry.js';
import { panelStatusOf } from '../shell/panelStatus.js';
import { TapClientService } from './TapClientService.js';

/** What the host is showing, beside the panel itself. */
type HostState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'mounted' }
  | { readonly kind: 'unavailable'; readonly title: string; readonly reason: string }
  | { readonly kind: 'failed'; readonly title: string; readonly message: string };

/**
 * Mounts the panel the route names, and keeps it in step.
 *
 * The panels are still the hand-written modules from before the Angular
 * migration: each exports `mount(host, context)` and returns something with a
 * `dispose()`.  This component is the adapter that lets them keep working while
 * they are ported one at a time (#485) — it is deleted with the last of them.
 *
 * Two properties are carried over from the shell's `mountRoutedPanel`, and both
 * are easy to lose in a port:
 *
 *   - **The epoch guard.** Every panel is its own lazy chunk, so loading is
 *     async and a fast click sequence can resolve out of order.  Without the
 *     guard a slow panel can land after the user has already moved on and paint
 *     over whatever is now correct.
 *   - **Disposal before replacement.** `dispose()` is what detaches a panel's
 *     effects and its tap subscriptions; the refcount in the tap client is what
 *     then tells the server to stop producing that stream.  Skipping it does not
 *     look broken locally — it quietly leaves the actor system doing work for a
 *     panel nobody is looking at.
 */
@Component({
  selector: 'devtools-legacy-panel-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (state().kind) {
      @case ('loading') {
        <p class="dt-empty">Loading…</p>
      }
      @case ('unavailable') {
        <div class="dt-notice">
          <div class="dt-notice__title">{{ unavailableTitle() }} is not available</div>
          <div>{{ unavailableReason() }}</div>
        </div>
      }
      @case ('failed') {
        <div class="dt-notice">
          <div class="dt-notice__title">Could not load the {{ failedTitle() }} panel</div>
          <div>{{ failedMessage() }}</div>
        </div>
      }
    }
    <div #host></div>
  `,
})
export class LegacyPanelHostComponent {
  private readonly tap = inject(TapClientService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  private readonly route = signal(currentRoute.get());
  private readonly hostState = signal<HostState>({ kind: 'loading' });

  readonly state = this.hostState.asReadonly();
  readonly unavailableTitle = computed(() => {
    const current = this.hostState();
    return current.kind === 'unavailable' ? current.title : '';
  });
  readonly unavailableReason = computed(() => {
    const current = this.hostState();
    return current.kind === 'unavailable' ? current.reason : '';
  });
  readonly failedTitle = computed(() => {
    const current = this.hostState();
    return current.kind === 'failed' ? current.title : '';
  });
  readonly failedMessage = computed(() => {
    const current = this.hostState();
    return current.kind === 'failed' ? current.message : '';
  });

  private mounted: PanelInstance | null = null;
  private epoch = 0;

  constructor() {
    this.destroyRef.onDestroy(currentRoute.subscribe((value) => this.route.set(value)));
    this.destroyRef.onDestroy(() => this.disposeMounted());

    effect(() => {
      const wanted = this.route().panel;
      const welcome = this.tap.welcome();
      const definition = findPanel(wanted) ?? findPanel('dashboard');

      const current = ++this.epoch;
      this.disposeMounted();

      if (definition === undefined) {
        this.hostState.set({ kind: 'unavailable', title: wanted, reason: 'This server does not offer the panel.' });
        return;
      }
      const descriptor = panelStatusOf(welcome, definition.id);
      if (descriptor.status !== 'active') {
        this.hostState.set({
          kind: 'unavailable',
          title: definition.title,
          reason: descriptor.reason ?? 'This server does not offer the panel.',
        });
        return;
      }

      this.hostState.set({ kind: 'loading' });
      void definition.load().then((module) => {
        if (current !== this.epoch) return;
        this.hostState.set({ kind: 'mounted' });
        this.mounted = module.mount(this.host().nativeElement, {
          tap: this.tap.client,
          route: currentRoute,
        });
      }).catch((error: unknown) => {
        if (current !== this.epoch) return;
        this.hostState.set({
          kind: 'failed',
          title: definition.title,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  private disposeMounted(): void {
    this.mounted?.dispose();
    this.mounted = null;
    const element = this.host().nativeElement;
    while (element.firstChild !== null) element.removeChild(element.firstChild);
  }
}
