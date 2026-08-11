/**
 * The application frame: branded header, nav rail, panel host.
 *
 * The shell owns exactly one thing — which panel is mounted — and
 * swaps it when the route changes.  Everything else (data, layout,
 * rendering) belongs to the panels, which is what lets later phases add
 * panels without touching this file.
 */
import { h, replaceChildren } from '../core/dom.js';
import { formatDuration } from '../core/format.js';
import { effect } from '../core/signal.js';
import { currentRoute, panelHref } from '../core/router.js';
import { currentTheme, toggleTheme } from '../core/theme.js';
import { DEVTOOLS_PROTOCOL_VERSION, type ConnectionStatus, type TapClient } from '../core/tapClient.js';
import { findPanel, registeredPanels, type PanelInstance } from './PanelRegistry.js';
import { panelStatusOf } from './panelStatus.js';
import { ACTOR_TS_LOGO_SVG } from '../assets/logo.js';

const STATUS_LABELS: Readonly<Record<ConnectionStatus, string>> = {
  connecting: 'connecting',
  open: 'live',
  closed: 'reconnecting',
  incompatible: 'version mismatch',
};

/**
 * How long a lost connection is tolerated before it is announced.
 *
 * Long enough to cover the flicker of an ordinary reconnect — the
 * status goes `connecting` → `closed` → `connecting` while it retries —
 * and short enough that a real outage is named while you are still
 * looking at the screen.
 */
const OFFLINE_GRACE_MS = 2_000;

/** Keeps the "last contact" reading moving while there is none. */
const OFFLINE_CLOCK_MS = 1_000;

/** Build the shell and mount it into `root`. */
export function mountAppShell(root: HTMLElement, tap: TapClient): void {
  const navigation = h('nav', { class: 'dt-nav' });
  const host = h('main', { class: 'dt-panel' });
  const systemName = h('span', { class: 'dt-header__system' }, '…');
  const statusBadge = h('span', { class: 'dt-status' });
  const themeButton = h('button', { class: 'dt-iconbutton', type: 'button', onclick: toggleTheme });

  // Trusted build-time constant, not user data — inlined so the mark
  // inherits the page's theme instead of loading as an opaque image.
  const logo = h('span', { class: 'dt-header__logo', role: 'img', 'aria-label': 'actor-ts' });
  logo.innerHTML = ACTOR_TS_LOGO_SVG;

  const dialogBody = h('div', { class: 'dt-dialog__body' });
  const dismissButton = h('button', {
    class: 'dt-iconbutton',
    type: 'button',
    onclick: () => closeOffline(true),
  }, 'Look at the last data anyway');
  const offlineDialog = h('dialog', { class: 'dt-dialog' },
    dialogBody,
    h('div', { class: 'dt-dialog__actions' }, dismissButton),
  ) as HTMLDialogElement;

  const app = h('div', { class: 'dt-app' },
    h('header', { class: 'dt-header' },
      logo,
      systemName,
      h('span', { class: 'dt-header__spacer' }),
      statusBadge,
      themeButton,
    ),
    h('div', { class: 'dt-body' }, navigation, host),
    offlineDialog,
  );
  root.appendChild(app);

  /**
   * Say so, in the way that is hard to miss, when nothing answers.
   *
   * Every panel keeps rendering the last thing it was told, which is the
   * right behaviour — the final reading before a node died is usually
   * the interesting one — but without saying so it reads as a live
   * dashboard of a healthy system.  The status badge was too quiet for
   * that; it is eight pixels in a corner.
   */
  let offlineSince: number | null = Date.now();
  /** Set when the reader chooses to look past it; cleared on recovery. */
  let dismissed = false;

  // Escape counts as dismissing rather than as a close that reopens on
  // the next tick — a dialog that comes straight back is a trap.
  offlineDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeOffline(true);
  });

  function closeOffline(byReader: boolean): void {
    if (byReader) dismissed = true;
    if (offlineDialog.open) offlineDialog.close();
  }

  function renderConnection(): void {
    const status = tap.status.get();
    if (status === 'open') {
      offlineSince = null;
      // Back on its feet: the dialog goes, and a later outage is allowed
      // to raise it again.
      dismissed = false;
      app.classList.remove('dt-app--offline');
      closeOffline(false);
      return;
    }
    if (offlineSince === null) offlineSince = Date.now();

    const down = Date.now() - offlineSince >= OFFLINE_GRACE_MS;
    app.classList.toggle('dt-app--offline', down);
    if (!down) return;

    replaceChildren(dialogBody, ...(status === 'incompatible'
      ? [
        h('h2', { class: 'dt-dialog__title' }, 'This UI does not match the server'),
        h('p', {},
          'The bundled panels and the tap protocol disagree on their version, '
          + 'so the connection was refused rather than half-understood. '
          + 'Rebuild the UI bundle.'),
      ]
      : [
        h('h2', { class: 'dt-dialog__title' }, 'No node reachable'),
        h('p', {},
          `Nothing has answered for ${formatDuration(Date.now() - offlineSince)}. `
          + 'Everything behind this is the last thing the node said, frozen at '
          + 'that moment — it is not live. Still retrying, and this closes by '
          + 'itself the moment something answers.'),
        h('p', { class: 'dt-dialog__hint' },
          'Each node serves its own DevTools, so another node\'s port may still '
          + 'answer while this one does not.'),
      ]));

    if (!dismissed && !offlineDialog.open) offlineDialog.showModal();
  }

  effect(renderConnection, [tap.status]);
  setInterval(renderConnection, OFFLINE_CLOCK_MS);

  effect(() => {
    themeButton.textContent = currentTheme.get() === 'dark' ? 'Light mode' : 'Dark mode';
  }, [currentTheme]);

  effect(() => {
    const status = tap.status.get();
    statusBadge.className = `dt-status dt-status--${status}`;
    replaceChildren(statusBadge, h('span', { class: 'dt-status__dot' }), STATUS_LABELS[status]);
  }, [tap.status]);

  effect(() => {
    const welcome = tap.welcome.get();
    systemName.textContent = welcome?.systemName ?? '…';
    // The framework version now also has a tile on the overview (#911) —
    // it is the first thing a bug report quotes, and a tooltip does not
    // survive the screenshot.  It stays here as well because this badge
    // is on every panel, and the PROTOCOL version has no tile: it only
    // matters when the two sides disagree, which is not a glanceable
    // figure.
    statusBadge.title = welcome === null
      ? ''
      : `actor-ts ${welcome.serverVersion} · tap protocol v${DEVTOOLS_PROTOCOL_VERSION}`;
  }, [tap.welcome]);

  effect(() => renderNavigation(navigation, tap), [tap.welcome, currentRoute]);

  mountRoutedPanel(host, tap);
}

function renderNavigation(navigation: HTMLElement, tap: TapClient): void {
  const welcome = tap.welcome.get();
  const active = currentRoute.get().panel;
  replaceChildren(navigation, ...registeredPanels().map((panel) => {
    const descriptor = panelStatusOf(welcome, panel.id);
    const usable = descriptor.status === 'active';
    const classes = ['dt-nav__item'];
    if (panel.id === active) classes.push('dt-nav__item--current');
    if (!usable) classes.push('dt-nav__item--unavailable');
    if (usable) return h('a', { class: classes.join(' '), href: panelHref(panel.id) }, panel.title);
    // `title` alone would BECOME the accessible name, so a screen
    // reader would announce the reason and never the panel.  Spell out
    // both, in that order.
    const reason = descriptor.reason ?? 'not available';
    return h('span', {
      class: classes.join(' '),
      title: reason,
      'aria-label': `${panel.title} — ${reason}`,
      'aria-disabled': 'true',
    }, panel.title);
  }));
}

/**
 * Keep the mounted panel in step with the route.
 *
 * Loading is async (each panel is its own chunk), so a fast click
 * sequence can resolve out of order — the epoch guard drops the result
 * of any load the user has already navigated away from.
 */
function mountRoutedPanel(host: HTMLElement, tap: TapClient): void {
  let mounted: PanelInstance | null = null;
  let epoch = 0;

  effect(() => {
    const wanted = currentRoute.get().panel;
    const definition = findPanel(wanted) ?? findPanel('dashboard');
    const usable = definition !== undefined
      && panelStatusOf(tap.welcome.get(), definition.id).status === 'active';

    const current = ++epoch;
    mounted?.dispose();
    mounted = null;

    if (definition === undefined || !usable) {
      replaceChildren(host, unavailableNotice(wanted, tap));
      return;
    }
    replaceChildren(host, h('p', { class: 'dt-empty' }, 'Loading…'));
    void definition.load().then((module) => {
      if (current !== epoch) return;
      replaceChildren(host);
      mounted = module.mount(host, { tap, route: currentRoute });
    }).catch((error: unknown) => {
      if (current !== epoch) return;
      replaceChildren(host, h('div', { class: 'dt-notice' },
        h('div', { class: 'dt-notice__title' }, `Could not load the ${definition.title} panel`),
        h('div', {}, (error as Error).message),
      ));
    });
  }, [currentRoute, tap.welcome]);
}

function unavailableNotice(panelId: string, tap: TapClient): HTMLElement {
  const definition = findPanel(panelId);
  const descriptor = panelStatusOf(tap.welcome.get(), (definition?.id ?? 'dashboard'));
  return h('div', { class: 'dt-notice' },
    h('div', { class: 'dt-notice__title' },
      `${definition?.title ?? panelId} is not available`),
    h('div', {}, descriptor.reason ?? 'This server does not offer the panel.'),
  );
}
