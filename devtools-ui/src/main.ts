/**
 * DevTools UI bootstrap.
 *
 * Angular owns the whole application from #485 on: the shell is components
 * reading signals, every panel is a component, and the router mounts them.
 * Nothing hand-rolled survives — `core/signal.ts`, `core/dom.ts`,
 * `core/router.ts`, `shell/PanelRegistry.ts` and the migration's own adapters
 * are gone with the last panel that needed them.
 *
 * `withHashLocation()` is mandatory, not a style choice.  `UiAssetRoutes.ts`
 * deliberately serves no SPA fallback, so a request for a PATH that is not an
 * asset has to 404 rather than return this document — which is what lets the
 * same bundle be served at the server root (`DevTools.attach`) and under a
 * prefix (`DevTools.mount('/devtools')`).  Keeping every navigation target in
 * the hash is what preserves that while still giving the panels real URLs.
 *
 * Zoneless: there is no `zone.js` in `angular.json`'s `polyfills` and nothing
 * needs it.  The reactive model is Angular signals throughout, which is the
 * reason this framework was the one picked — the previous `signal`/`computed`/
 * `effect` layer ported across rather than being rewritten.
 *
 * The stylesheet is not imported here.  `base.css` is a global sheet listed in
 * `angular.json`'s `styles`, which is how Angular's builder extracts it; a
 * side-effect `import './styles/base.css'` was Bun's mechanism and would now
 * produce a second, component-scoped copy.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withHashLocation } from '@angular/router';

import { AppShellComponent } from './app/AppShellComponent.js';
import { APP_ROUTES } from './app/panelRoutes.js';

await bootstrapApplication(AppShellComponent, {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(APP_ROUTES, withHashLocation()),
  ],
});
