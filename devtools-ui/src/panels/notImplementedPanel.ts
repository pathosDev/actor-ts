/**
 * Stand-in for a panel that is declared but not built yet.
 *
 * Declaring the panel early is deliberate: the dashboard and nav rail
 * get its real title and description, and the server's handshake marks
 * it unavailable with a reason — so the roster a developer sees matches
 * the roster that will exist, instead of tools appearing out of
 * nowhere between releases.  Reaching this module means a server
 * advertised a panel as active that this bundle cannot render, which
 * only happens if the two are out of step.
 */
import { h, replaceChildren } from '../core/dom.js';
import type { PanelContext, PanelInstance } from '../shell/PanelRegistry.js';

export function mount(host: HTMLElement, _context: PanelContext): PanelInstance {
  replaceChildren(host, h('div', { class: 'dt-notice' },
    h('div', { class: 'dt-notice__title' }, 'This tool is not in the loaded UI bundle'),
    h('div', {}, 'The server offers it, but this DevTools build cannot render it yet. '
      + 'Rebuild the UI bundle to pick it up.'),
  ));
  return { dispose(): void { /* nothing acquired */ } };
}
