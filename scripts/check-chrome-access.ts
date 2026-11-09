// Fails when a file in src/ other than the two adapters mentions `chrome` at runtime.

import { resolve } from 'node:path';
import { Glob } from 'bun';
import { findChromeAccess, isAdapter } from './chrome-access';

const repo = resolve(import.meta.dirname, '..');
const problems: string[] = [];
for await (const path of new Glob('src/**/*.{ts,tsx,js,mjs}').scan({ cwd: repo })) {
  if (isAdapter(path)) continue;
  const hits = findChromeAccess(await Bun.file(resolve(repo, path)).text());
  for (const hit of hits) problems.push(`${path}: ${hit}`);
}
if (problems.length) {
  console.error('✗ chrome access outside the adapters (use the interfaces in src/lib/ports.ts):');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('✓ chrome-access: only the adapter files use the chrome global');
