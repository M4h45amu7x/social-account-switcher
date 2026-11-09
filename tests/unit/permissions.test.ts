import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  ALLOWED_HOST_PERMISSIONS,
  ALLOWED_PERMISSIONS,
  checkManifest,
  checkPrivacyPolicy,
  privacyPolicyPermissions,
} from '../../scripts/permissions';

const privacy = readFileSync(new URL('../../PRIVACY.md', import.meta.url), 'utf8');
const manifest = JSON.parse(
  readFileSync(new URL('../../src/manifest.json', import.meta.url), 'utf8'),
) as Parameters<typeof checkManifest>[0];

const table = (rows: string[]) =>
  `# Policy\n\n## Permissions and what each one is for\n\n| Permission | Used for |\n|---|---|\n${rows
    .map((r) => `| ${r} | why |`)
    .join('\n')}\n\nAfter the table: \`ignored\`\n\n## Next\n\n| \`also-ignored\` | x |\n`;
const allRows = [
  ...ALLOWED_PERMISSIONS.map((p) => `\`${p}\``),
  ALLOWED_HOST_PERMISSIONS.map((h) => `\`${h}\``).join(', '),
];

describe('manifest allow-list', () => {
  test('the source manifest passes', () => {
    expect(checkManifest(manifest)).toEqual([]);
  });

  test('an extra permission, an extra host and a forbidden key all fail', () => {
    const problems = checkManifest({
      ...manifest,
      permissions: [...(manifest.permissions ?? []), 'tabs'],
      host_permissions: [...(manifest.host_permissions ?? []), '<all_urls>'],
      content_scripts: [],
      manifest_version: 2,
    });
    expect(problems).toHaveLength(4);
  });
});

describe('PRIVACY.md permission table', () => {
  test('the real PRIVACY.md documents exactly the allow-list', () => {
    expect(checkPrivacyPolicy(privacy)).toEqual([]);
  });

  test('reads only the first column of the table under the heading', () => {
    expect(privacyPolicyPermissions(table(allRows))?.sort()).toEqual(
      [...ALLOWED_PERMISSIONS, ...ALLOWED_HOST_PERMISSIONS].sort(),
    );
  });

  test('a missing permission fails', () => {
    expect(checkPrivacyPolicy(table(allRows.slice(1)))).toEqual([
      `PRIVACY.md does not explain permission ${ALLOWED_PERMISSIONS[0]}`,
    ]);
  });

  test('an undocumented extra permission fails', () => {
    expect(checkPrivacyPolicy(table([...allRows, '`tabs`']))).toEqual([
      'PRIVACY.md lists tabs, which is not in the allow-list',
    ]);
  });

  test('a policy without the section fails', () => {
    expect(checkPrivacyPolicy('# Policy\n\nNothing here.\n')).toHaveLength(1);
  });
});
