// Fails when dist/manifest.json asks for anything outside the allow-list, or when PRIVACY.md does not
// document exactly the allowed permissions (docs/design.md §9.10).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkManifest, checkPrivacyPolicy } from './permissions';

const repo = resolve(import.meta.dirname, '..');
const read = (path: string): string => {
  try {
    return readFileSync(resolve(repo, path), 'utf8');
  } catch {
    console.error(
      `✗ perm:check: cannot read ${path}${path.startsWith('dist') ? ' (run "bun run build" first)' : ''}`,
    );
    process.exit(1);
  }
};

const problems = [
  ...checkManifest(JSON.parse(read('dist/manifest.json'))),
  ...checkPrivacyPolicy(read('PRIVACY.md')),
];
if (problems.length) {
  console.error('✗ perm:check failed:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  '✓ perm:check: manifest matches the allow-list and PRIVACY.md documents every permission',
);
