/**
 * The dashboard — the page DevTools opens on.
 *
 * Two jobs.  First, answer "what am I looking at and is it healthy?"
 * at a glance, without picking a tool.  Second, be the map: one card
 * per panel, each either a link or a greyed card saying *why* it is
 * not available, so nothing about this system's capabilities is
 * hidden behind a click that fails.
 *
 * Phase 0 shows what the handshake already carries.  The live figures
 * (actor counts, message rates, mailbox backlog) and their spike-
 * revealing time series arrive with the `stats` stream in #204.
 */
import { h, replaceChildren } from '../../core/dom.js';
import { panelHref } from '../../core/router.js';
import { effect } from '../../core/signal.js';
import { formatDuration, formatTime } from '../../core/format.js';
import { DEVTOOLS_PROTOCOL_VERSION } from '../../core/tapClient.js';
import { registeredPanels, type PanelContext, type PanelInstance } from '../../shell/PanelRegistry.js';
import { panelStatusOf } from '../../shell/panelStatus.js';
import type { WelcomeFrame } from '../../../../src/devtools/protocol/index.js';

/** Refresh cadence of the uptime tile — the only self-driven clock here. */
const CLOCK_INTERVAL_MS = 1000;

export function mount(host: HTMLElement, context: PanelContext): PanelInstance {
  const tiles = h('div', { class: 'dt-tiles' });
  const cards = h('div', { class: 'dt-cards' });

  replaceChildren(host,
    h('h1', { class: 'dt-panel__title' }, 'Overview'),
    h('p', { class: 'dt-panel__subtitle' }, 'System at a glance, and the way into every tool.'),
    tiles,
    h('h2', { class: 'dt-section' }, 'Tools'),
    cards,
  );

  const renderTiles = (): void => replaceChildren(tiles, ...buildTiles(context.tap.welcome.get()));
  const disposeTiles = effect(renderTiles, [context.tap.welcome]);
  const disposeCards = effect(
    () => replaceChildren(cards, ...buildCards(context.tap.welcome.get())),
    [context.tap.welcome],
  );

  // Uptime has to advance on its own — nothing pushes a frame just
  // because a second passed.
  const clock = setInterval(renderTiles, CLOCK_INTERVAL_MS);

  return {
    dispose(): void {
      clearInterval(clock);
      disposeTiles();
      disposeCards();
    },
  };
}

function buildTiles(welcome: WelcomeFrame | null): ReadonlyArray<HTMLElement> {
  if (welcome === null) {
    return [tile('Connection', 'connecting…')];
  }
  const activePanels = welcome.panels.filter((panel) => panel.status === 'active').length;
  return [
    tile('Actor system', welcome.systemName, true),
    tile('Uptime', formatDuration(Date.now() - welcome.startedAtMs)),
    tile('Attached since', formatTime(welcome.startedAtMs)),
    tile('Framework', welcome.serverVersion),
    tile('Tap protocol', `v${DEVTOOLS_PROTOCOL_VERSION}`),
    tile('Live streams', String(welcome.streams.length)),
    tile('Tools available', `${activePanels} / ${welcome.panels.length}`),
  ];
}

function tile(label: string, value: string, accent = false): HTMLElement {
  return h('div', { class: 'dt-tile' },
    h('div', { class: 'dt-tile__label' }, label),
    h('div', { class: `dt-tile__value${accent ? ' dt-tile__accent' : ''}` }, value),
  );
}

function buildCards(welcome: WelcomeFrame | null): ReadonlyArray<HTMLElement> {
  const panels = registeredPanels().filter((panel) => panel.id !== 'dashboard');
  if (panels.length === 0) {
    return [h('p', { class: 'dt-empty' }, 'No tools are registered in this build.')];
  }
  return panels.map((panel) => {
    const descriptor = panelStatusOf(welcome, panel.id);
    if (descriptor.status === 'active') {
      return h('a', { class: 'dt-card', href: panelHref(panel.id) },
        h('div', { class: 'dt-card__title' }, panel.title),
        h('div', { class: 'dt-card__text' }, panel.description),
        h('span', { class: 'dt-card__badge' }, 'open'),
      );
    }
    return h('div', { class: 'dt-card dt-card--unavailable' },
      h('div', { class: 'dt-card__title' }, panel.title),
      h('div', { class: 'dt-card__text' }, descriptor.reason ?? panel.description),
      h('span', { class: 'dt-card__badge dt-card__badge--unavailable' }, descriptor.status),
    );
  });
}
