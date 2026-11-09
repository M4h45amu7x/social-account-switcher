// Runs both chrome guardrails (Biome with the repo's own src/** rules, and scripts/check-chrome-access.ts)
// on the samples in tests/lint-fixtures. Every bad sample must be caught; the good samples must pass.
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findChromeAccess, isAdapter } from '../../scripts/chrome-access';

const repo = resolve(import.meta.dirname, '../..');
const fixtures = join(repo, 'tests/lint-fixtures');

// Biome skips files outside files.includes even when named on the command line, and the fixtures are
// excluded from the normal lint. So copy the fixtures into a temp project whose biome.json is the real
// one with the src/** override applied to every file. Biome only runs its type-aware rules
// (noFloatingPromises) on files inside the project it was started in, hence the copy.
type BiomeConfig = {
  $schema?: string;
  vcs?: { enabled?: boolean };
  files?: { includes?: string[] };
  overrides?: { includes: string[] }[];
};
const real = (await Bun.file(join(repo, 'biome.json')).json()) as BiomeConfig;
const srcOverride = real.overrides?.[0];
if (!srcOverride?.includes.includes('src/**'))
  throw new Error('biome.json overrides[0] must be src/**');
const configDir = mkdtempSync(join(tmpdir(), 'sam-biome-fixtures-'));
const config: BiomeConfig = {
  ...real,
  $schema: join(repo, 'node_modules/@biomejs/biome/configuration_schema.json'),
  vcs: { enabled: false },
  files: { includes: ['**'] },
  overrides: [{ ...srcOverride, includes: ['**'] }],
};
writeFileSync(join(configDir, 'biome.json'), JSON.stringify(config));
cpSync(fixtures, join(configDir, 'fixtures'), { recursive: true });
afterAll(() => rmSync(configDir, { recursive: true, force: true }));

function biomeRejects(file: string): boolean {
  const run = Bun.spawnSync(
    [join(repo, 'node_modules/.bin/biome'), 'lint', join('fixtures', file)],
    { cwd: configDir, stdout: 'pipe', stderr: 'pipe' },
  );
  return run.exitCode !== 0;
}

const scannerRejects = async (file: string): Promise<boolean> =>
  findChromeAccess(await Bun.file(join(fixtures, file)).text()).length > 0;

const list = (dir: string): string[] => readdirSync(join(fixtures, dir)).sort();

// What each guard is expected to catch. Biome has no rule for `document.defaultView`, and the scanner
// only looks for `chrome`, so a dropped promise on a port is Biome's job alone.
const BIOME_MISSES = new Set(['15-document-defaultview.ts']);
const SCANNER_MISSES = new Set(['16-floating-promise-through-port.ts']);

describe('chrome guardrail fixtures', () => {
  test('there are bad and good samples', () => {
    expect(list('bad').length).toBeGreaterThanOrEqual(16);
    expect(list('good').length).toBeGreaterThanOrEqual(1);
  });

  for (const file of list('bad')) {
    test(`bad/${file} is rejected`, async () => {
      const path = `bad/${file}`;
      expect({ biome: biomeRejects(path), scanner: await scannerRejects(path) }).toEqual({
        biome: !BIOME_MISSES.has(file),
        scanner: !SCANNER_MISSES.has(file),
      });
    });
  }

  for (const file of list('good')) {
    test(`good/${file} passes`, async () => {
      const path = `good/${file}`;
      expect({ biome: biomeRejects(path), scanner: await scannerRejects(path) }).toEqual({
        biome: false,
        scanner: false,
      });
    });
  }
});

describe('findChromeAccess', () => {
  test('ignores comments and type-only mentions', () => {
    expect(
      findChromeAccess('// chrome.cookies\nlet x: chrome.cookies.Cookie | undefined;\n'),
    ).toEqual([]);
  });

  test('reports string and property forms', () => {
    expect(findChromeAccess("const k = 'chrome';")).toHaveLength(1);
    expect(findChromeAccess('const c = window.chrome;')).toHaveLength(1);
  });

  test('knows the two adapter files', () => {
    expect(isAdapter('src/popup/runtime.ts')).toBe(true);
    expect(isAdapter('src\\background\\chrome-adapter.ts')).toBe(true);
    expect(isAdapter('src/popup/main.ts')).toBe(false);
  });
});

test('an import of the adapter module is not a chrome access', () => {
  expect(
    findChromeAccess("import { lifecycleApi } from './chrome-adapter';\nlifecycleApi;"),
  ).toEqual([]);
});
