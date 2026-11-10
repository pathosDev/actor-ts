import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditDist, auditPage } from '../../../docs/scripts/check-rendered-output.mjs';

/**
 * #1528 — the classifier behind `bun run check:rendered`, held to the exact
 * shapes it exists to catch.
 *
 * The script runs in CI against a real `dist/`, which is the only place the
 * defect it guards against can appear — but a check that has never been seen
 * to fail proves nothing (#1527's own verification harness reported a perfect
 * match on a build where every diagram was unstyled).  So each rule gets the
 * shape that should trip it, the shape that should not, and — for the
 * whole-build audit — a synthetic `dist/` where the verdict has to move.
 */

/** A rendered mermaid diagram as the healthy build emits it: stylesheet in the element body. */
const HEALTHY_DIAGRAM = '<svg id="mermaid-0" aria-roledescription="flowchart-v2" viewBox="0 0 100 40">'
  + '<style>#mermaid-0{font-family:\'JetBrains Mono\',ui-monospace,monospace;fill:#ccc;}</style>'
  + '<g><rect/><text>discovery</text></g></svg>';

/**
 * The #1527 shape, verbatim from the broken build: the same stylesheet, but as
 * the value of a `set:html` attribute, with the element body empty.
 */
const BROKEN_1527_DIAGRAM = '<svg id="mermaid-0" aria-roledescription="flowchart-v2" viewBox="0 0 100 40">'
  + '<style set:html="#mermaid-0{font-family:&#x27;JetBrains Mono&#x27;,ui-monospace,monospace;fill:#ccc;}"></style>'
  + '<g><rect/><text>discovery</text></g></svg>';

const page = (body: string): string => `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;

describe('check-rendered-output — auditPage', () => {
  test('a healthy diagram raises nothing', () => {
    const { findings, svgs } = auditPage(page(HEALTHY_DIAGRAM));
    expect(findings).toEqual([]);
    expect(svgs).toBe(1);
  });

  test('the #1527 shape trips both the directive rule and the empty-style rule', () => {
    const { findings, svgs } = auditPage(page(BROKEN_1527_DIAGRAM));
    expect(svgs).toBe(1);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatch(/^directive-leaked: set:html /);
    expect(findings[1]).toMatch(/^mermaid-style-empty: 1 diagram\(s\) but only 0 /);
  });

  test('a fence the rehype plugin never turned into an SVG is reported', () => {
    const { findings } = auditPage(page(
      '<pre class="astro-code" data-language="mermaid"><code>graph LR; A-->B</code></pre>',
    ));
    expect(findings).toEqual(['mermaid-unrendered: 1 fence(s) survived as a code block instead of an SVG']);
  });

  test('every Astro directive family is caught, not only set:html', () => {
    for (const directive of ['set:text', 'is:raw', 'client:load', 'server:defer', 'transition:persist']) {
      const { findings } = auditPage(page(`<div ${directive}="x">y</div>`));
      expect(findings, directive).toEqual([`directive-leaked: ${directive} reached the output as an attribute`]);
    }
  });

  test('a directive that is prose or an escaped code sample is not an attribute', () => {
    // The docs may legitimately *talk about* directives.  Text is not markup:
    // in prose the tag closed before the mention, and in a code sample the
    // angle brackets are entities.  Neither is the failure shape.
    const { findings } = auditPage(page(
      '<p>Astro consumes the <code>set:html</code> directive at compile time.</p>'
      + '<pre><code>&lt;div set:html={raw} /&gt;</code></pre>'
      + '<p>Also seen as set:html= in a log line.</p>',
    ));
    expect(findings).toEqual([]);
  });

  test('a page whose <style> is not mermaid\'s, and has no diagram, is fine', () => {
    const { findings, svgs } = auditPage(page('<style>.card{color:red}</style><p>no diagrams here</p>'));
    expect(findings).toEqual([]);
    expect(svgs).toBe(0);
  });

  test('two diagrams need two stylesheets — one styled and one not is still a finding', () => {
    const { findings } = auditPage(page(HEALTHY_DIAGRAM + BROKEN_1527_DIAGRAM));
    expect(findings.some((f) => f.startsWith('mermaid-style-empty: 2 diagram(s) but only 1 '))).toBe(true);
  });
});

describe('check-rendered-output — auditDist', () => {
  const roots: string[] = [];
  const scratch = (): { dist: string; content: string } => {
    const root = mkdtempSync(join(tmpdir(), 'rendered-output-'));
    roots.push(root);
    const dist = join(root, 'dist');
    const content = join(root, 'content');
    mkdirSync(join(dist, 'guide'), { recursive: true });
    mkdirSync(join(content, 'api'), { recursive: true });
    return { dist, content };
  };
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  test('a build with a healthy diagram for a source fence is ok', () => {
    const { dist, content } = scratch();
    writeFileSync(join(content, 'guide.mdx'), '---\ntitle: g\n---\n\n```mermaid\ngraph LR; A-->B\n```\n');
    writeFileSync(join(dist, 'index.html'), page('<p>home</p>'));
    writeFileSync(join(dist, 'guide', 'index.html'), page(HEALTHY_DIAGRAM));

    const audit = auditDist(dist, content);
    expect(audit.problems).toEqual([]);
    expect(audit.findings).toEqual([]);
    expect(audit).toMatchObject({ ok: true, pages: 2, svgs: 1 });
  });

  test('the #1527 build is not ok, and the finding names the page', () => {
    const { dist, content } = scratch();
    writeFileSync(join(content, 'guide.mdx'), '---\ntitle: g\n---\n\n```mermaid\ngraph LR; A-->B\n```\n');
    writeFileSync(join(dist, 'index.html'), page('<p>home</p>'));
    writeFileSync(join(dist, 'guide', 'index.html'), page(BROKEN_1527_DIAGRAM));

    const audit = auditDist(dist, content);
    expect(audit.ok).toBe(false);
    expect(audit.problems).toEqual([]);
    expect(audit.findings.map((f) => f.page)).toEqual(['guide/index.html', 'guide/index.html']);
  });

  test('a source fence with no rendered diagram anywhere is a problem, not a pass', () => {
    // The three page rules are all absent-of-failure checks; a dist where the
    // plugin never ran and the fence was dropped entirely would pass them all.
    const { dist, content } = scratch();
    writeFileSync(join(content, 'guide.mdx'), '---\ntitle: g\n---\n\n```mermaid\ngraph LR; A-->B\n```\n');
    writeFileSync(join(dist, 'index.html'), page('<p>home</p>'));
    writeFileSync(join(dist, 'guide', 'index.html'), page('<p>the fence vanished</p>'));

    const audit = auditDist(dist, content);
    expect(audit.ok).toBe(false);
    expect(audit.findings).toEqual([]);
    expect(audit.problems).toEqual([
      'the content tree has mermaid fences but the output has no rendered diagram — the rehype plugin did not run',
    ]);
  });

  test('generated api/ pages under the content root do not count as source', () => {
    // typedoc writes hundreds of pages there at build time; counting them would
    // make the "partial build" guard fire on every honest build.
    const { dist, content } = scratch();
    for (let i = 0; i < 5; i++) writeFileSync(join(content, 'api', `class-${i}.md`), '# generated');
    writeFileSync(join(content, 'guide.mdx'), '---\ntitle: g\n---\n\nplain prose\n');
    writeFileSync(join(dist, 'index.html'), page('<p>home</p>'));

    const audit = auditDist(dist, content);
    expect(audit.problems).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  test('fewer rendered pages than source pages is a partial build', () => {
    const { dist, content } = scratch();
    for (const name of ['a', 'b', 'c']) writeFileSync(join(content, `${name}.mdx`), '---\ntitle: x\n---\n\ntext\n');
    writeFileSync(join(dist, 'index.html'), page('<p>only one</p>'));

    const audit = auditDist(dist, content);
    expect(audit.ok).toBe(false);
    expect(audit.problems).toEqual(['1 rendered page(s) for 3 source page(s) — a partial or stale build']);
  });

  test('no build output at all is a problem, not an empty pass', () => {
    const { dist, content } = scratch();
    rmSync(dist, { recursive: true, force: true });
    const audit = auditDist(dist, content);
    expect(audit.ok).toBe(false);
    expect(audit.problems).toHaveLength(1);
    expect(audit.problems[0]).toMatch(/^no build output at /);
  });
});
