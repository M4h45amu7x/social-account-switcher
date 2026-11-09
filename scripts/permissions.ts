// The ONLY permissions this extension may ship with (docs/design.md §4).
// Adding one means changing src/manifest.json, this file and the permission table in PRIVACY.md
// in the same change. checkManifest and checkPrivacyPolicy fail otherwise.
export const ALLOWED_PERMISSIONS = ['cookies', 'scripting', 'storage'] as const;
export const ALLOWED_HOST_PERMISSIONS = [
  '*://*.facebook.com/*',
  '*://*.instagram.com/*',
  '*://*.youtube.com/*',
] as const;

interface Manifest {
  manifest_version?: number;
  version?: string;
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: unknown[];
  externally_connectable?: unknown;
  content_security_policy?: unknown;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Returns a list of problems; empty means the manifest is within the allow-list. */
export function checkManifest(m: Manifest): string[] {
  const problems: string[] = [];
  if (m.manifest_version !== 3)
    problems.push(`manifest_version must be 3 (got ${m.manifest_version})`);
  const perms = m.permissions ?? [];
  const hosts = m.host_permissions ?? [];
  if (!sameSet(perms, ALLOWED_PERMISSIONS))
    problems.push(
      `permissions ${JSON.stringify(perms)} ≠ allowed ${JSON.stringify(ALLOWED_PERMISSIONS)}`,
    );
  if (!sameSet(hosts, ALLOWED_HOST_PERMISSIONS))
    problems.push(
      `host_permissions ${JSON.stringify(hosts)} ≠ allowed ${JSON.stringify(ALLOWED_HOST_PERMISSIONS)}`,
    );
  for (const key of [
    'optional_permissions',
    'optional_host_permissions',
    'content_scripts',
    'externally_connectable',
    'content_security_policy',
  ] as const) {
    if (m[key] !== undefined) problems.push(`"${key}" is not allowed (design §4/§9.10)`);
  }
  return problems;
}

export const PRIVACY_PERMISSIONS_HEADING = '## Permissions and what each one is for';

/** Every `code` token in the first column of the permission table under PRIVACY_PERMISSIONS_HEADING. */
export function privacyPolicyPermissions(markdown: string): string[] | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === PRIVACY_PERMISSIONS_HEADING);
  if (start === -1) return null;
  const tokens: string[] = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (!line.trim().startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const firstCell = line.split('|')[1] ?? '';
    for (const match of firstCell.matchAll(/`([^`]+)`/g)) tokens.push(match[1] ?? '');
  }
  return tokens;
}

/** Returns a list of problems; empty means PRIVACY.md documents exactly the allowed permissions. */
export function checkPrivacyPolicy(markdown: string): string[] {
  const documented = privacyPolicyPermissions(markdown);
  if (documented === null) return [`PRIVACY.md has no "${PRIVACY_PERMISSIONS_HEADING}" section`];
  const allowed: string[] = [...ALLOWED_PERMISSIONS, ...ALLOWED_HOST_PERMISSIONS];
  const problems: string[] = [];
  for (const p of allowed)
    if (!documented.includes(p)) problems.push(`PRIVACY.md does not explain permission ${p}`);
  for (const p of documented)
    if (!allowed.includes(p))
      problems.push(`PRIVACY.md lists ${p}, which is not in the allow-list`);
  return problems;
}
