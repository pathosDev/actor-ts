/**
 * DevTools UI bootstrap.
 *
 * Angular owns the build from #483 on, but not yet the application: this boots
 * a single component that mounts the existing shell, so the toolchain change
 * lands without touching a panel.  See `app/LegacyShellHost.ts` for why the
 * adapter sits at the shell rather than per panel, and #485 for the port that
 * removes it.
 *
 * Zoneless: there is no `zone.js` in `angular.json`'s `polyfills`, and nothing
 * here needs it.  The existing UI drives its own updates through
 * `core/signal.ts`, and the components that replace it in #485 use Angular
 * signals, which is the whole reason Angular 22 was the framework picked — the
 * reactive model ports across rather than being rewritten.
 *
 * The stylesheet is no longer imported here.  `base.css` is a global sheet
 * listed in `angular.json`'s `styles`, which is how Angular's builder extracts
 * it; a side-effect `import './styles/base.css'` was Bun's mechanism and would
 * now produce a second, component-scoped copy.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

import { LegacyShellHostComponent } from './app/LegacyShellHost.js';

await bootstrapApplication(LegacyShellHostComponent, {
  providers: [provideZonelessChangeDetection()],
});
