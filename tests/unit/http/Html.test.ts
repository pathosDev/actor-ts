import { describe, expect, test } from 'bun:test';
import { completeHtml, escapeHtml, html, rawHtml, SafeHtml } from '../../../src/http/Html.js';

describe('escapeHtml', () => {
  test('escapes each significant character', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
    expect(escapeHtml('`')).toBe('&#96;');
  });

  test('escapes a mixed string and neutralises a script tag', () => {
    expect(escapeHtml('<script>alert("x")</script>'))
      .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  test('leaves a string with nothing to escape untouched', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });

  test('empty string stays empty', () => {
    expect(escapeHtml('')).toBe('');
  });

  test('is not idempotent — re-escaping doubles the ampersand (encode once!)', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  test('leaves unicode / emoji untouched', () => {
    expect(escapeHtml('héllo 😀 —')).toBe('héllo 😀 —');
  });
});

describe('html tagged template', () => {
  test('escapes a string interpolation', () => {
    const name = '<b>evil</b>';
    expect(html`<p>${name}</p>`.value).toBe('<p>&lt;b&gt;evil&lt;/b&gt;</p>');
  });

  test('escapes quotes in an attribute-value position', () => {
    const cls = '"><script>';
    expect(html`<div class="${cls}">`.value).toBe('<div class="&quot;&gt;&lt;script&gt;">');
  });

  test('renders numbers and booleans', () => {
    expect(html`${1}-${true}-${0}`.value).toBe('1-true-0');
  });

  test('null and undefined render as empty string', () => {
    expect(html`[${null}${undefined}]`.value).toBe('[]');
  });

  test('an array is rendered item-by-item and joined', () => {
    const items = ['a', '<b>', 'c'];
    expect(html`${items}`.value).toBe('a&lt;b&gt;c');
  });

  test('a nested html`` fragment is inserted verbatim (not double-escaped)', () => {
    const row = html`<td>${'<x>'}</td>`;
    expect(html`<tr>${row}</tr>`.value).toBe('<tr><td>&lt;x&gt;</td></tr>');
  });

  test('an array of SafeHtml fragments is concatenated verbatim', () => {
    const rows = [html`<li>${'<1>'}</li>`, html`<li>${'<2>'}</li>`];
    expect(html`<ul>${rows}</ul>`.value).toBe('<ul><li>&lt;1&gt;</li><li>&lt;2&gt;</li></ul>');
  });

  test('rawHtml is inserted verbatim', () => {
    expect(html`<div>${rawHtml('<b>bold</b>')}</div>`.value).toBe('<div><b>bold</b></div>');
  });

  test('a plain object is coerced to string and escaped', () => {
    const obj = { toString: () => '<obj>' };
    expect(html`${obj}`.value).toBe('&lt;obj&gt;');
  });

  test('returns a SafeHtml instance', () => {
    expect(html`x`).toBeInstanceOf(SafeHtml);
    expect(String(html`x`)).toBe('x');
  });
});

describe('completeHtml', () => {
  test('sets text/html and nosniff', () => {
    const response = completeHtml(200, html`<h1>hi</h1>`);
    expect(response.status).toBe(200);
    expect(response.contentType).toBe('text/html; charset=utf-8');
    expect(response.headers?.['x-content-type-options']).toBe('nosniff');
    expect(response.body).toBe('<h1>hi</h1>');
  });

  test('accepts a raw string body', () => {
    expect(completeHtml(200, '<p>raw</p>').body).toBe('<p>raw</p>');
  });

  test('supplied headers win over the nosniff default', () => {
    const response = completeHtml(200, html`x`, { 'x-content-type-options': 'off', 'x-extra': '1' });
    expect(response.headers?.['x-content-type-options']).toBe('off');
    expect(response.headers?.['x-extra']).toBe('1');
  });
});
