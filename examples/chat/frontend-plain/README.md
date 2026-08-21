# Plain HTML frontend

Single-file vanilla HTML/CSS/JS — no build, no `node_modules`, no
framework.  Serves as the "no-magic" baseline for comparison.

The file is at `../static/plain/index.html`, and that is both the
source *and* what the backend serves under `/static/plain/` — edit it
there.  This directory exists only for symmetry with the frontends
that do have a build step; there is nothing here to copy from.

Unlike `static/angular|next|react|svelte/`, which are build output and
are gitignored (#559), this one is committed, because a file nothing
generates is source.

(Future improvement: a small build step that minifies the inline
JS / CSS.  Not necessary for the demo.)
