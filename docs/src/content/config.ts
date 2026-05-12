/**
 * Starlight content-collection schema.
 *
 * The default `docsSchema()` accepts every standard Starlight front-matter
 * field (`title`, `description`, `sidebar.order`, `sidebar.label`, `tableOfContents`,
 * `template`, `editUrl`, `lastUpdated`, …) — see the Starlight docs for the
 * full list.
 *
 * If we need custom front-matter (e.g. an `audience` field tagging which
 * skill level a page targets, or a `since` field for the version the
 * feature was introduced in), we extend the schema here.  Not needed for
 * the initial scaffold.
 */
import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema(),
  }),
};
