#!/usr/bin/env node
/**
 * Read what `astro build` actually rendered, rather than trusting that it did.
 *
 * A green build is not proof the site is right.  #1527 shipped 423 unstyled
 * mermaid diagrams through a build that exited 0 with no warnings:
 * `@astrojs/markdown-remark@7.3.1` moved each diagram's CSS into a `set:html`
 * *property* (an Astro directive the compiler is supposed to consume), and
 * `rehype-optimize-static` then serialised the surrounding subtree through
 * `hast-util-to-html`, which knows nothing about directives and wrote it out as
 * an ordinary attribute.  What reached `dist/` was
 * `<style set:html="…"></style>` — the CSS in an attribute, the element body
 * empty, the browser applying none of it.  Every count-based comparison still
 * matched (the CSS *text* was present, just relocated), so this asserts the
 * properties that broke rather than counts that happened to agree:
 *
 *   1. no Astro template directive survives as an attribute in emitted HTML;
 *   2. every ```mermaid fence became an SVG — none is left as a code block;
 *   3. every rendered mermaid SVG carries its stylesheet as a `<style>` *body*.
 *
 * Each is absolute, so no baseline `dist/` is needed.  Two guards keep the
 * three from passing vacuously: the walk must have found pages, and if the
 * content tree contains a mermaid fence the output must contain a rendered
 * diagram.  Run with `bun run check:rendered` from `docs/` after `bun run
 * build`; `docs-checks.yml` and `docs.yml` both do (#1528).
 *
 * `auditPage` is exported so `tests/unit/docs/RenderedOutputCheck.test.ts`
 * can hold the classifier to the exact shapes it exists to catch.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DIST_ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
export const CONTENT_ROOT = fileURLToPath(new URL('../src/content/docs/', import.meta.url));

/**
 * An Astro directive written as an attribute of an emitted tag.  Anchored on
 * the tag so a page that merely *mentions* `set:html` in prose or a code
 * sample — where it is text, not an attribute — does not trip it.
 */
const DIRECTIVE_ATTRIBUTE = /<[a-zA-Z][^>]*?\s((?:set|is|client|server|transition):[a-z-]+)=/g;

/** How a mermaid fence looks when the rehype plugin did not turn it into an SVG. */
const UNRENDERED_FENCE = /data-language="mermaid"|language-mermaid/g;

/** Mermaid stamps every SVG it renders with this attribute. */
const MERMAID_SVG = /<svg\b[^>]*\baria-roledescription=/g;

/** A `<style>` whose *body* carries mermaid's per-diagram stylesheet. */
const MERMAID_STYLE_BODY = /<style\b[^>]*>\s*#mermaid-/g;

/** A mermaid fence in a source page, so the positive guard knows to expect output. */
const MERMAID_FENCE = /^```mermaid\b/m;

const count = (source, pattern) => (source.match(pattern) ?? []).length;

/**
 * The findings for one rendered page.  Every rule is a string in
 * `findings`, so a page with nothing wrong yields `[]`.
 */
export function auditPage(html) {
  const findings = [];

  const directives = [...html.matchAll(DIRECTIVE_ATTRIBUTE)].map((match) => match[1]);
  if (directives.length > 0) {
    findings.push(`directive-leaked: ${[...new Set(directives)].join(', ')} reached the output as an attribute`);
  }

  const unrendered = count(html, UNRENDERED_FENCE);
  if (unrendered > 0) {
    findings.push(`mermaid-unrendered: ${unrendered} fence(s) survived as a code block instead of an SVG`);
  }

  const svgs = count(html, MERMAID_SVG);
  const styledBodies = count(html, MERMAID_STYLE_BODY);
  if (svgs > 0 && styledBodies < svgs) {
    findings.push(
      `mermaid-style-empty: ${svgs} diagram(s) but only ${styledBodies} <style> bod${styledBodies === 1 ? 'y' : 'ies'} `
      + 'carrying a mermaid stylesheet — the CSS is missing or sits in an attribute',
    );
  }

  return { findings, svgs };
}

function walk(dir, extensions, out = [], skip = new Set()) {
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, extensions, out);
    else if (extensions.has(extname(entry))) out.push(full);
  }
  return out;
}

/**
 * `api/` under the content root is typedoc output written at build time and
 * untracked — the frontmatter guard excludes it for the same reason.  Only the
 * top level is skipped, so a hand-written page that happens to live in a
 * nested `api` folder would still count.
 */
const GENERATED_CONTENT = new Set(['api']);

/**
 * Audit a built site.  Returns every finding plus the numbers the guards
 * rest on, and never exits — the caller decides what a failure looks like.
 */
export function auditDist(distRoot = DIST_ROOT, contentRoot = CONTENT_ROOT) {
  if (!existsSync(distRoot)) {
    return { ok: false, problems: [`no build output at ${distRoot} — run \`bun run build\` first`], pages: 0, svgs: 0, findings: [] };
  }

  const pages = walk(distRoot, new Set(['.html']));
  const findings = [];
  let svgs = 0;
  for (const page of pages) {
    const result = auditPage(readFileSync(page, 'utf8'));
    svgs += result.svgs;
    for (const finding of result.findings) {
      findings.push({ page: relative(distRoot, page).replace(/\\/g, '/'), finding });
    }
  }

  const problems = [];
  // Guards the guard: an empty or wrong directory would pass every rule above.
  if (pages.length === 0) problems.push(`no HTML pages found under ${distRoot}`);
  const sourcePages = existsSync(contentRoot) ? walk(contentRoot, new Set(['.mdx', '.md']), [], GENERATED_CONTENT) : [];
  if (pages.length > 0 && pages.length < sourcePages.length) {
    problems.push(`${pages.length} rendered page(s) for ${sourcePages.length} source page(s) — a partial or stale build`);
  }
  const sourceHasMermaid = sourcePages.some((page) => MERMAID_FENCE.test(readFileSync(page, 'utf8')));
  if (sourceHasMermaid && svgs === 0) {
    problems.push('the content tree has mermaid fences but the output has no rendered diagram — the rehype plugin did not run');
  }

  return { ok: findings.length === 0 && problems.length === 0, problems, pages: pages.length, svgs, findings };
}

const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const result = auditDist();
  for (const problem of result.problems) console.error(`✗ ${problem}`);
  // Group by finding so 423 identical lines read as one line and a count.
  const byFinding = new Map();
  for (const { page, finding } of result.findings) {
    const list = byFinding.get(finding) ?? [];
    list.push(page);
    byFinding.set(finding, list);
  }
  for (const [finding, affected] of byFinding) {
    console.error(`✗ ${finding}`);
    console.error(`    on ${affected.length} page(s), e.g. ${affected.slice(0, 3).join(', ')}`);
  }
  if (result.ok) {
    console.log(`✓ rendered output checked — ${result.pages} pages, ${result.svgs} mermaid diagrams, no directive leaked, none unrendered, all styled`);
  } else {
    console.error(`\n${result.findings.length} finding(s) across ${byFinding.size} rule(s) and ${result.problems.length} problem(s).`);
    process.exit(1);
  }
}
