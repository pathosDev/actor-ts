# Plain HTML frontend

Single-file vanilla HTML/CSS/JS — no build, no `node_modules`, no
framework.  Serves as the "no-magic" baseline for comparison.

The shipped frontend is at `../static/plain/index.html`.  This
directory exists as the "source" location for symmetry with the
other frontends; copy the file into `static/plain/` (already done in
the repo) when changes are made.

```bash
cp index.html ../static/plain/index.html
```

(Future improvement: a small build step that minifies the inline
JS / CSS.  Not necessary for the demo.)
