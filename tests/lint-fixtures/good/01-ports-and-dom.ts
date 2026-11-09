interface SessionStorageApi {
  setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
}

// Mentions of chrome in comments are fine.
export async function harden(deps: { session: SessionStorageApi }): Promise<void> {
  await deps.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export function render(): boolean {
  const app = document.querySelector('#app');
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  app?.classList.toggle('dark', dark);
  return dark;
}
