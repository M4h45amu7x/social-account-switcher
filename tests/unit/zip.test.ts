import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { unzipSync } from 'fflate';

test('release zip bytes and checksum are identical in UTC and Asia/Bangkok', () => {
  // A UTC instant passed to a local-time ZIP encoder makes this regression fail.
  const root = mkdtempSync(join(tmpdir(), 'sam-zip-tz-'));
  const repo = resolve(import.meta.dirname, '../..');
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'dist'));
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
    for (const file of ['zip.ts', 'permissions.ts']) {
      cpSync(join(repo, 'scripts', file), join(root, 'scripts', file));
    }
    cpSync(join(repo, 'PRIVACY.md'), join(root, 'PRIVACY.md'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    const manifest = JSON.parse(readFileSync(join(repo, 'src/manifest.json'), 'utf8'));
    writeFileSync(
      join(root, 'dist/manifest.json'),
      JSON.stringify({ ...manifest, version: '0.1.0' }),
    );
    writeFileSync(join(root, 'dist/popup.js'), 'console.log("local fixture");\n');
    const archives = ['UTC', 'Asia/Bangkok'].map((tz) => {
      const result = Bun.spawnSync([process.execPath, 'scripts/zip.ts'], {
        cwd: root,
        env: { ...process.env, TZ: tz },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.stderr.toString()).toBe('');
      expect(result.exitCode).toBe(0);
      const archive = readFileSync(join(root, 'release/social-account-switcher-v0.1.0.zip'));
      const sha = createHash('sha256').update(archive).digest('hex');
      expect(
        readFileSync(join(root, 'release/social-account-switcher-v0.1.0.zip.sha256'), 'utf8'),
      ).toBe(`${sha}  social-account-switcher-v0.1.0.zip\n`);
      expect(new TextDecoder().decode(unzipSync(archive)['popup.js'])).toBe(
        'console.log("local fixture");\n',
      );
      // First local header: DOS midnight, 2000-01-01 (independent of host timezone).
      expect(archive.readUInt16LE(10)).toBe(0);
      expect(archive.readUInt16LE(12)).toBe(10273);
      return { archive, sha };
    });
    expect(archives[0]?.sha).toBe(archives[1]?.sha);
    expect(archives[0]?.archive.equals(archives[1]?.archive ?? Buffer.alloc(0))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
