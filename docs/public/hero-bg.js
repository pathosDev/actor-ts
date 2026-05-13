// Animated particle-network background behind the splash hero.
//
// Pure canvas, no dependencies.  Loaded via `<script src="...">` from
// `index.mdx`; on script-load it prepends a `<canvas>` element to
// `<main>` so it paints before the hero content (DOM-order stacking
// puts it visually behind everything that follows).  CSS in
// `custom.css` handles the absolute positioning + bottom fade.
//
// Visitors with `prefers-reduced-motion` get nothing — the script
// bails before creating the canvas, so there's no static placeholder
// either.

(function () {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // Skip on mobile / small viewports.  At narrow widths the particle
  // network reads as distracting clutter behind the hero content
  // rather than a subtle background — the eye can't help following
  // the dots because they're closer to the title.  Threshold matches
  // the splash hero's desktop-layout breakpoint in `custom.css`
  // (`@media (min-width: 50rem)`) so the animation appears exactly
  // when the rest of the page switches to the wider layout.
  if (!window.matchMedia('(min-width: 50rem)').matches) return;

  const main = document.querySelector('main');
  if (!main) return;

  const canvas = document.createElement('canvas');
  canvas.id = 'hero-bg';
  canvas.setAttribute('aria-hidden', 'true');
  main.prepend(canvas);

  const ctx = canvas.getContext('2d');
  let nodes = [];
  let W = 0, H = 0;
  let dpr = 1;
  let raf = 0;

  // Tuned to the actor-ts logo palette so the animation reads as an
  // extension of the brand rather than a stock particle effect.
  const NODE_GRADIENT = ['#fcd34d', '#ef4444']; // amber-300 → red-500
  const LINE_COLOR    = '99, 102, 241';          // indigo-500, rgba below
  const MAX_DIST      = 150;

  function setup() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    W = rect.width;
    H = rect.height;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Node count scales with area — ~one node per 22000 px², clamped
    // so phones stay light and huge monitors don't get too busy.
    const target = Math.floor((W * H) / 22000);
    const count  = Math.max(20, Math.min(70, target));

    nodes = [];
    for (let i = 0; i < count; i++) {
      nodes.push({
        x:  Math.random() * W,
        y:  Math.random() * H,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        r:  1.5 + Math.random() * 1.8,
        // Stable per-node colour from the gradient endpoints.
        color: NODE_GRADIENT[Math.random() < 0.5 ? 0 : 1],
      });
    }
  }

  function tick() {
    ctx.clearRect(0, 0, W, H);

    // Connections first so nodes paint over their own endpoints.
    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d  = Math.sqrt(dx * dx + dy * dy);
        if (d < MAX_DIST) {
          const o = (1 - d / MAX_DIST) * 0.55;
          ctx.strokeStyle = 'rgba(' + LINE_COLOR + ', ' + o + ')';
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // Nodes + drift.
    for (const n of nodes) {
      n.x += n.vx;
      n.y += n.vy;
      if (n.x < 0 || n.x > W) { n.vx = -n.vx; n.x = Math.max(0, Math.min(W, n.x)); }
      if (n.y < 0 || n.y > H) { n.vy = -n.vy; n.y = Math.max(0, Math.min(H, n.y)); }

      ctx.fillStyle = n.color;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }

    raf = requestAnimationFrame(tick);
  }

  setup();
  tick();

  // Re-layout on resize.  Debounced to avoid thrashing.
  let resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(setup, 200);
  });

  // Pause the loop while the tab is hidden — saves CPU on background tabs.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf) {
      tick();
    }
  });
})();
