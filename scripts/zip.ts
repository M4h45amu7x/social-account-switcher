// Builds release/social-account-switcher-v<version>.zip for GitHub Releases (docs/design.md §9.7).
// Expects a fresh `bun run build`. Deterministic: sorted entries, fixed timestamps.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { type Zippable, zipSync } from 'fflate';
import { checkManifest, checkPrivacyPolicy } from './permissions';

const repo = resolve(import.meta.dirname, '..');
const dist = join(repo, 'dist');
const fail = (msg: string): never => {
  console.error(`✗ zip: ${msg}`);
  process.exit(1);
};

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

let files: string[] = [];
try {
  files = walk(dist).sort();
} catch {
  fail('dist/ not found — run "bun run build" first');
}

// 1) manifest: allow-listed permissions + version matches package.json
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const problems = [
  ...checkManifest(manifest),
  ...checkPrivacyPolicy(readFileSync(join(repo, 'PRIVACY.md'), 'utf8')),
];
if (problems.length) fail(`manifest:\n  - ${problems.join('\n  - ')}`);
if (manifest.version !== pkg.version)
  fail(`manifest version ${manifest.version} ≠ package.json ${pkg.version}`);

// 2) content checks — second line of defence after Biome (design §9.7)
const banned: [RegExp, string][] = [
  [/<script[^>]+src=["']https?:/i, 'remote <script src>'],
  [/import\(\s*["']https?:/, 'remote dynamic import'],
  [/\beval\(/, 'eval('],
  [/new Function\(/, 'new Function('],
  [/\bfetch\(/, 'fetch('],
  [/\bsendBeacon\(/, 'sendBeacon('],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\(/, 'WebSocket('],
];
for (const f of files) {
  const rel = relative(dist, f);
  if (rel.endsWith('.map')) fail(`source map in build: ${rel}`);
  if (!/\.(js|html|css|json)$/.test(rel)) continue;
  const text = readFileSync(f, 'utf8');
  for (const [re, what] of banned) if (re.test(text)) fail(`${what} found in ${rel}`);
}

// 3) deterministic zip (manifest.json at the zip root)
// fflate encodes local calendar fields as DOS time; keep those fields fixed in every TZ.
const mtime = new Date(2000, 0, 1, 0, 0, 0);
const entries: Zippable = {};
for (const f of files) {
  entries[relative(dist, f).split(sep).join('/')] = [readFileSync(f), { mtime, level: 9 }];
}
const zip = zipSync(entries);
const outDir = join(repo, 'release');
mkdirSync(outDir, { recursive: true });
const name = `social-account-switcher-v${pkg.version}.zip`;
writeFileSync(join(outDir, name), zip);
const sha = createHash('sha256').update(zip).digest('hex');
writeFileSync(join(outDir, `${name}.sha256`), `${sha}  ${name}\n`);
console.log(`✓ release/${name} (${files.length} files, ${zip.length} bytes)`);
console.log(`  sha256 ${sha}`);
