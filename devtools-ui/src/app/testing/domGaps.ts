/**
 * The two DOM APIs jsdom does not implement, supplied for the specs.
 *
 * Both are gaps in the environment rather than things the components should
 * defend against — a browser has had `ResizeObserver` since 2020 and
 * `HTMLDialogElement.showModal` since 2022, and writing runtime guards for a
 * test runner is how production code slowly becomes shaped by its tests.
 *
 * `ResizeObserver` is a no-op here on purpose: nothing in jsdom lays anything
 * out, so a faithful implementation would have nothing to report.  What matters
 * is that constructing one does not throw, because every chart makes one.
 */

/** A `ResizeObserver` that accepts everything and never fires. */
class InertResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

export function installDomGaps(): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope['ResizeObserver'] ??= InertResizeObserver;

  const prototype = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  if (typeof prototype['showModal'] === 'function') return;
  prototype['showModal'] = function showModal(this: HTMLDialogElement): void {
    this.setAttribute('open', '');
  };
  prototype['close'] = function close(this: HTMLDialogElement): void {
    this.removeAttribute('open');
  };
  Object.defineProperty(prototype, 'open', {
    configurable: true,
    get(this: HTMLDialogElement) { return this.hasAttribute('open'); },
    set(this: HTMLDialogElement, value: boolean) {
      if (value) this.setAttribute('open', '');
      else this.removeAttribute('open');
    },
  });
}
