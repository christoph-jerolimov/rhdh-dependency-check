import { defineConfig } from 'astro/config';

// GitHub Pages serves project sites under /<repository>/; the workflow passes
// the real values from actions/configure-pages.
const site = process.env.SITE || 'https://christoph-jerolimov.github.io';
const base = process.env.BASE_PATH || '/rhdh-dependency-check';

export default defineConfig({
  site,
  base,
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory' },
});
