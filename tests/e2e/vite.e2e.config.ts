// Builds the extension plus one extra page (src/popup/e2e/e2e.html) into test-results/popup-dist.
// The page opens the real popup code on sample data; it is not an entry of the normal build, so it
// never reaches dist/ or the zip.
import { resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import base from '../../vite.config';

const root = resolve(import.meta.dirname, '..', '..');

export default defineConfig(async (env) => {
  const config = typeof base === 'function' ? await base(env) : await base;
  return mergeConfig(config, {
    build: {
      outDir: resolve(root, 'test-results', 'popup-dist'),
      rolldownOptions: { input: { 'popup-e2e': resolve(root, 'src/popup/e2e/e2e.html') } },
    },
  });
});
