import { AfterViewInit, Component, ElementRef, inject } from '@angular/core';

import { connectTap, tapUrl } from '../core/tapClient.js';
import { mountAppShell } from '../shell/AppShell.js';
import { registerAllPanels } from '../shell/panelRegistrations.js';

/**
 * The temporary adapter that keeps the whole existing UI running while Angular
 * takes over the build (#483, part of #482).
 *
 * This issue swaps a toolchain and nothing else: no panel is ported, and the
 * user-visible application is byte-for-byte the behaviour it had under
 * `Bun.build`.  So the adapter wraps the *shell* rather than each panel — one
 * `mountAppShell` call inside one Angular component — which is what makes that
 * claim true rather than approximately true.  Wrapping each panel instead would
 * have meant Angular owning navigation, and with it the nav rail, the panel
 * roster from the `welcome` handshake, the route guards and the offline
 * dialog's grace period: a shell port, which is #485's scope, smuggled into the
 * issue that was supposed to change only how the bundle is produced.
 *
 * Two consequences worth stating, because they read as omissions otherwise:
 *
 *   - `provideRouter(routes, withHashLocation())` is not wired up here.  There
 *     are no Angular routes yet, so there is nothing to configure; the existing
 *     hash router in `core/router.ts` still owns navigation.  The constraint
 *     itself is real and does not go away — `UiAssetRoutes.ts` deliberately has
 *     no SPA fallback, so a missing file must 404 — and it binds #485, where
 *     Angular routing actually arrives.
 *   - Per-panel code splitting is unchanged.  `PanelRegistry`'s `load()` is a
 *     dynamic `import()`, which Angular's esbuild builder splits into a lazy
 *     chunk exactly as Bun did, so the per-panel size budgets keep resolving.
 *
 * `mountAppShell` returns no disposer and never needed one: it mounts once into
 * the application root and lives for the lifetime of the document.  That is why
 * there is no `ngOnDestroy` here — adding one that could not actually tear the
 * shell down would be worse than the honest absence.
 */
@Component({
  selector: 'devtools-root',
  template: '',
})
export class LegacyShellHostComponent implements AfterViewInit {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  ngAfterViewInit(): void {
    registerAllPanels();
    mountAppShell(this.host.nativeElement, connectTap(tapUrl()));
  }
}
