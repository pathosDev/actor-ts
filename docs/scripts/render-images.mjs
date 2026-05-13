/**
 * Render SVG sources to PNG images at multiple sizes.
 *
 * Why: SVG logos rely on the host having `JetBrains Mono` installed for
 * the wordmark to look right.  On systems without it (most desktops,
 * GitHub.com README rendering, etc.) the SVG falls back to a generic
 * monospace font and the wordmark spacing + glyph shapes shift.  PNG
 * rendering at build time, with the font bundled into a base64 data
 * URL, gives one definitive bitmap that looks the same everywhere.
 *
 * Outputs (under `docs/public/`):
 *   logo.png            — full logo (mesh + wordmark + tagline), 2x density
 *   logo-header.png     — header variant (mesh + wordmark, no tagline)
 *   favicon-{16,32,192,512}.png — favicon at common discrete sizes
 *
 * Run with:
 *   cd docs && bun run images
 *
 * Re-run whenever an SVG source changes.  Outputs are committed —
 * the build pipeline does NOT re-render them on every CI run (would
 * add Playwright/Chromium overhead for unchanged inputs).
 */

import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, '../public');
const FONT_PATH = resolve(
  __dirname,
  '../node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2',
);

const fontBytes = await readFile(FONT_PATH);
const fontBase64 = fontBytes.toString('base64');
const fontFaceCss = `
  @font-face {
    font-family: 'JetBrains Mono';
    src: url('data:font/woff2;base64,${fontBase64}') format('woff2');
    font-weight: 700;
    font-style: normal;
    font-display: block;
  }
`;

/**
 * Render a single SVG file to PNG at a target pixel size.
 *
 * The SVG is loaded inline into a minimal HTML page that pre-loads
 * JetBrains Mono via a base64 data URL.  The viewport is set to the
 * target dimensions, then a full-page screenshot is taken with
 * transparent background.
 */
async function renderSvgToPng(browser, svgPath, outPath, { width, height }) {
  const svg = await readFile(svgPath, 'utf-8');

  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  await page.setContent(
    `<!doctype html>
<html><head>
<style>
${fontFaceCss}
  html, body { margin: 0; padding: 0; background: transparent;
               width: 100%; height: 100%;
               font-family: 'JetBrains Mono', monospace; }
  svg { display: block; width: 100%; height: 100%; }
</style>
</head><body>${svg}</body></html>`,
    { waitUntil: 'domcontentloaded' },
  );

  // Make sure the embedded font is fully loaded before screenshotting.
  await page.evaluate(() => document.fonts.ready);

  await page.screenshot({
    path: outPath,
    omitBackground: true,
    fullPage: false,
    type: 'png',
  });

  await ctx.close();
  console.log(`  ✓ ${outPath.replace(PUBLIC, '<public>')} (${width}×${height})`);
}

console.log('Rendering PNGs from SVG sources...');
const browser = await chromium.launch();

try {
  // Full logo — viewBox 514.47 × 119.03.  Render at 2× density for
  // retina screens (~1029 × 238 px).
  await renderSvgToPng(
    browser,
    resolve(PUBLIC, 'logo.svg'),
    resolve(PUBLIC, 'logo.png'),
    { width: 1029, height: 238 },
  );

  // Header logo — same viewBox as full logo (514.47 × 119.03) but without
  // the tagline.  Renders at the same intrinsic aspect ratio as
  // `logo.png`; Starlight scales it to fit the top-nav height.
  await renderSvgToPng(
    browser,
    resolve(PUBLIC, 'logo-header.svg'),
    resolve(PUBLIC, 'logo-header.png'),
    { width: 1029, height: 238 },
  );

  // Favicons — exact pixel sizes for browser favicon slots.
  for (const size of [16, 32, 192, 512]) {
    await renderSvgToPng(
      browser,
      resolve(PUBLIC, 'favicon.svg'),
      resolve(PUBLIC, `favicon-${size}.png`),
      { width: size, height: size },
    );
  }
} finally {
  await browser.close();
}

console.log('Done.');
