// Same shape as SessionStorageApi in src/lib/ports.ts, declared here so the fixture stands alone.
interface SessionStorageApi {
  setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
}

export async function forgetsAwait(deps: { session: SessionStorageApi }): Promise<void> {
  deps.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}
