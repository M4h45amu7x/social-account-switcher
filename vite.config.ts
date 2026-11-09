import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const root = resolve(import.meta.dirname, 'src');
const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as {
  version: string;
};

/** Emit src/manifest.json into dist/ with the version taken from package.json (single source of truth). */
function manifest(): Plugin {
  return {
    name: 'extension-manifest',
    generateBundle() {
      const source = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify({ ...source, version: pkg.version }, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  root,
  base: '/',
  publicDir: resolve(import.meta.dirname, 'public'),
  plugins: [manifest()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    // keep in step with "minimum_chrome_version" in src/manifest.json
    target: 'chrome119',
    sourcemap: mode === 'development',
    minify: mode !== 'development',
    modulePreload: false,
    rolldownOptions: {
      input: {
        popup: resolve(root, 'popup/index.html'),
        'service-worker': resolve(root, 'background/service-worker.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
