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
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';

import { ACTOR_TS_LOGO_SVG } from '../assets/logo.js';
import { formatDuration } from '../core/format.js';
import { currentTheme, toggleTheme } from '../core/theme.js';
import { DEVTOOLS_PROTOCOL_VERSION, type ConnectionStatus } from '../core/tapClient.js';
import { panelStatusOf } from '../shell/panelStatus.js';
import { PANEL_ROSTER } from './panelRoutes.js';
import { TapClientService } from './TapClientService.js';

const STATUS_LABELS: Readonly<Record<ConnectionStatus, string>> = {
  connecting: 'connecting',
  open: 'live',
  closed: 'reconnecting',
  incompatible: 'version mismatch',
};

/**
 * How long a lost connection is tolerated before it is announced.
 *
 * Long enough to cover the flicker of an ordinary reconnect — the status goes
 * `connecting` → `closed` → `connecting` while it retries — and short enough
 * that a real outage is named while you are still looking at the screen.
 */
const OFFLINE_GRACE_MS = 2_000;

/** Keeps the "last contact" reading moving while there is none. */
const OFFLINE_CLOCK_MS = 1_000;

/** One nav entry, resolved against the handshake. */
type NavigationItem = {
  readonly id: string;
  readonly title: string;
  readonly usable: boolean;
  readonly current: boolean;
  readonly reason: string;
};

/**
 * The application frame: branded header, nav rail, routed panel.
 *
 * The shell owns exactly one thing — which panel is mounted — and Angular's
 * router does the mounting.  `withHashLocation()` is not a preference:
 * `UiAssetRoutes.ts` deliberately serves no SPA fallback, so a request for a
 * PATH that is not an asset must 404 rather than return this document.  Putting
 * every navigation target in the hash is what keeps that true while still
 * giving the panels real URLs.
 */
@Component({
  selector: 'devtools-root',
  imports: [RouterLink, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './AppShellComponent.html',
})
export class AppShellComponent {
  private readonly tap = inject(TapClientService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  /** Trusted build-time constant, not user data — inlined so the mark inherits the theme. */
  readonly logo: SafeHtml = inject(DomSanitizer).bypassSecurityTrustHtml(ACTOR_TS_LOGO_SVG);

  readonly status = this.tap.status;
  readonly theme = currentTheme;
  readonly statusLabel = computed(() => STATUS_LABELS[this.status()]);
  readonly systemName = computed(() => this.tap.welcome()?.systemName ?? '…');

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('offlineDialog');

  /** First path segment of the current URL — the panel id. */
  private readonly activePanel = signal(this.panelFromUrl(this.router.url));

  /** Ticks so the "nothing has answered for …" reading keeps moving. */
  private readonly now = signal(Date.now());
  private readonly offlineSince = signal<number | null>(Date.now());
  /** Set when the reader chooses to look past it; cleared on recovery. */
  private readonly dismissed = signal(false);

  /**
   * The framework version has its own overview tile (#911) — it is the first
   * thing a bug report quotes, and a tooltip does not survive a screenshot.
   * The PROTOCOL version stays here only: it matters when the two sides
   * disagree, which is not a glanceable figure.
   */
  readonly badgeTitle = computed(() => {
    const welcome = this.tap.welcome();
    return welcome === null
      ? ''
      : `actor-ts ${welcome.serverVersion} · tap protocol v${DEVTOOLS_PROTOCOL_VERSION}`;
  });

  readonly offline = computed(() => {
    const since = this.offlineSince();
    return since !== null && this.now() - since >= OFFLINE_GRACE_MS;
  });

  readonly offlineFor = computed(() => {
    const since = this.offlineSince();
    return since === null ? '' : formatDuration(this.now() - since);
  });

  readonly navigation = computed<readonly NavigationItem[]>(() => {
    const welcome = this.tap.welcome();
    const active = this.activePanel();
    return PANEL_ROSTER.map((panel) => {
      const descriptor = panelStatusOf(welcome, panel.id);
      return {
        id: panel.id,
        title: panel.title,
        usable: descriptor.status === 'active',
        current: panel.id === active,
        // `title` alone would BECOME the accessible name, so a screen reader
        // would announce the reason and never the panel.  The template spells
        // out both, in that order.
        reason: descriptor.reason ?? 'not available',
      };
    });
  });

  readonly unavailable = computed(() => {
    const active = this.activePanel();
    const panel = PANEL_ROSTER.find((entry) => entry.id === active);
    if (panel === undefined) return null;
    const descriptor = panelStatusOf(this.tap.welcome(), panel.id);
    return descriptor.status === 'active'
      ? null
      : { title: panel.title, reason: descriptor.reason ?? 'This server does not offer the panel.' };
  });

  constructor() {
    const subscription = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) this.activePanel.set(this.panelFromUrl(event.urlAfterRedirects));
    });
    this.destroyRef.onDestroy(() => subscription.unsubscribe());

    const clock = setInterval(() => this.now.set(Date.now()), OFFLINE_CLOCK_MS);
    this.destroyRef.onDestroy(() => clearInterval(clock));

    effect(() => {
      if (this.status() === 'open') {
        this.offlineSince.set(null);
        // Back on its feet: a later outage is allowed to raise the dialog again.
        this.dismissed.set(false);
        return;
      }
      if (this.offlineSince() === null) this.offlineSince.set(Date.now());
    });

    /**
     * Say so, in the way that is hard to miss, when nothing answers.
     *
     * Every panel keeps rendering the last thing it was told, which is the right
     * behaviour — the final reading before a node died is usually the
     * interesting one — but without saying so it reads as a live dashboard of a
     * healthy system.  The status badge was too quiet for that; it is eight
     * pixels in a corner.
     */
    effect(() => {
      const element = this.dialog().nativeElement;
      if (this.offline() && !this.dismissed()) {
        if (!element.open) element.showModal();
      } else if (element.open) {
        element.close();
      }
    });
  }

  onToggleTheme(): void { toggleTheme(); }

  onDismissOffline(): void { this.dismissed.set(true); }

  /**
   * Escape counts as dismissing rather than as a close that reopens on the next
   * tick — a dialog that comes straight back is a trap.
   */
  onDialogCancel(event: Event): void {
    event.preventDefault();
    this.dismissed.set(true);
  }

  private panelFromUrl(url: string): string {
    return url.replace(/^\//, '').split(/[/?#]/)[0] ?? '';
  }
}
