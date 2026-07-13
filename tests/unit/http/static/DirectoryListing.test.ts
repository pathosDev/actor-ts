import { describe, expect, test } from 'bun:test';
import { renderDirectoryListing, type ListingEntry } from '../../../../src/http/static/DirectoryListing.js';

const entry = (name: string, isDirectory: boolean, size = 0): ListingEntry => ({
  name, isDirectory, size, mtime: new Date(0),
});

describe('renderDirectoryListing', () => {
  test('escapes a hostile filename in text and encodes it in the href', () => {
    const html = renderDirectoryListing({
      urlPath: '/files/',
      atMountRoot: false,
      entries: [entry('<script>alert(1)</script>.txt', false, 10)],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;.txt'); // escaped text
    expect(html).toContain('href="%3Cscript%3Ealert(1)%3C%2Fscript%3E.txt"'); // encoded href
  });

  test('lists directories before files, then case-insensitive by name', () => {
    const html = renderDirectoryListing({
      urlPath: '/',
      atMountRoot: true,
      entries: [entry('banana.txt', false), entry('Apple', true), entry('avocado', true)],
    });
    const order = ['Apple/', 'avocado/', 'banana.txt'].map((n) => html.indexOf(n));
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
  });

  test('includes a parent link unless at the mount root', () => {
    expect(renderDirectoryListing({ urlPath: '/x/', atMountRoot: false, entries: [] })).toContain('href="../"');
    expect(renderDirectoryListing({ urlPath: '/', atMountRoot: true, entries: [] })).not.toContain('href="../"');
  });

  test('escapes the heading path', () => {
    const html = renderDirectoryListing({ urlPath: '/a"<b>/', atMountRoot: false, entries: [] });
    expect(html).toContain('Index of /a&quot;&lt;b&gt;/');
  });
});
