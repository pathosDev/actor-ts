/**
 * Minimal DOM construction helpers — the stand-in for a view library.
 *
 * There is no virtual DOM and no diffing: views build their nodes once
 * and an `effect` rewrites the parts that change.  At DevTools' scale
 * (tiles, tables, a nav rail) that is both faster and far less code
 * than reconciliation, and it keeps the bundle honest about the
 * "no UI framework" constraint.
 */

/** Attributes, event handlers (`onclick`), and `style`/`class` shorthands. */
export type Attributes = Record<string, string | number | boolean | null | undefined | EventListener>;

/** Anything that can be appended as a child. */
export type Child = Node | string | number | null | undefined | false;

/** Build an HTML element. */
export function h(tag: string, attributes: Attributes = {}, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag);
  applyAttributes(element, attributes);
  append(element, children);
  return element;
}

/** Build an SVG element — SVG needs its own namespace, HTML tags do not. */
export function svg(tag: string, attributes: Attributes = {}, ...children: Child[]): SVGElement {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  applyAttributes(element, attributes);
  append(element, children);
  return element;
}

/** Replace all children of `parent` with `children`. */
export function replaceChildren(parent: Element, ...children: Child[]): void {
  parent.textContent = '';
  append(parent, children);
}

function applyAttributes(element: Element, attributes: Attributes): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === 'function') {
      element.addEventListener(name.replace(/^on/, ''), value);
      continue;
    }
    element.setAttribute(name, String(value));
  }
}

function append(parent: Element, children: ReadonlyArray<Child>): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}
