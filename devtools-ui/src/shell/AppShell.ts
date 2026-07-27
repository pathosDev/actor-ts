/**
 * The application frame: branded header, nav rail, panel host.
 *
 * The shell owns exactly one thing — which panel is mounted — and
 * swaps it when the route changes.  Everything else (data, layout,
 * rendering) belongs to the panels, which is what lets later phases add
 * panels without touching this file.
 */
import { h, replaceChildren } from '../core/dom.js';
import { effect } from '../core/signal.js';
import { currentRoute, panelHref } from '../core/router.js';
import { currentTheme, toggleTheme } from '../core/theme.js';
import type { ConnectionStatus, TapClient } from '../core/tapClient.js';
import { findPanel, registeredPanels, type PanelInstance } from './PanelRegistry.js';
import { panelStatusOf } from './panelStatus.js';
import { ACTOR_TS_LOGO_SVG } from '../assets/logo.js';

const STATUS_LABELS: Readonly<Record<ConnectionStatus, string>> = {
  connecting: 'connecting',
  open: 'live',
  closed: 'reconnecting',
  incompatible: 'version mismatch',
};

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

  root.appendChild(h('div', { class: 'dt-app' },
    h('header', { class: 'dt-header' },
      logo,
      systemName,
      h('span', { class: 'dt-header__spacer' }),
      statusBadge,
      themeButton,
    ),
    h('div', { class: 'dt-body' }, navigation, host),
  ));

  effect(() => {
    themeButton.textContent = currentTheme.get() === 'dark' ? 'Light mode' : 'Dark mode';
  }, [currentTheme]);

  effect(() => {
    const status = tap.status.get();
    statusBadge.className = `dt-status dt-status--${status}`;
    replaceChildren(statusBadge, h('span', { class: 'dt-status__dot' }), STATUS_LABELS[status]);
  }, [tap.status]);

  effect(() => {
    systemName.textContent = tap.welcome.get()?.systemName ?? '…';
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
