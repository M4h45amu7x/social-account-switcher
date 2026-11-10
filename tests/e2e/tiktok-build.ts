import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const tiktokDist = resolve(import.meta.dirname, '../../test-results/tiktok-dist');
export function buildTikTok() {
  const root = resolve(import.meta.dirname, '../..');
  mkdirSync(tiktokDist, { recursive: true });
  cpSync(resolve(root, 'dist'), tiktokDist, { recursive: true });
  execFileSync(
    'bun',
    [
      'build',
      'tests/e2e/probe/tiktok-entry.ts',
      '--target=browser',
      '--format=esm',
      `--outfile=${tiktokDist}/service-worker.js`,
    ],
    { cwd: root, stdio: 'pipe' },
  );
}
