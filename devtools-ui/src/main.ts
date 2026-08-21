/**
 * DevTools UI bootstrap.
 *
 * Angular owns the shell from #485 on: the header, the nav rail, the offline
 * dialog and the panel host are components reading Angular signals.  The panels
 * themselves are still the hand-written modules — each one is ported in its own
 * commit, behind `LegacyPanelHostComponent`, which is deleted with the last of
 * them.
 *
 * Navigation still runs through `core/router.ts`.  `provideRouter(routes,
 * withHashLocation())` arrives with the first panel that becomes a real
 * component; until then two routers writing `location.hash` would be a race for
 * no benefit.  See `AppShellComponent` for why the hash half is mandatory when
 * it does arrive.
 *
 * Zoneless: there is no `zone.js` in `angular.json`'s `polyfills` and nothing
 * needs it.  The panels drive their own updates through `core/signal.ts`, the
 * shell uses Angular signals, and the two coexist because the shell mirrors the
 * few legacy signals it reads (`currentTheme`, `currentRoute`) into its own.
 *
 * The stylesheet is not imported here.  `base.css` is a global sheet listed in
 * `angular.json`'s `styles`, which is how Angular's builder extracts it; a
 * side-effect `import './styles/base.css'` was Bun's mechanism and would now
 * produce a second, component-scoped copy.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

import { AppShellComponent } from './app/AppShellComponent.js';
import { registerAllPanels } from './shell/panelRegistrations.js';

// Before the shell renders: the nav rail and the panel host both read the
// registry, so a panel registered afterwards would be missing from the first
// paint rather than merely late.
registerAllPanels();

await bootstrapApplication(AppShellComponent, {
  providers: [provideZonelessChangeDetection()],
});
