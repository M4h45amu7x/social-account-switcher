// Service worker entry (B1 skeleton). Switching logic arrives in B3; see docs/design.md sections 3 and 8.
import type { LifecycleApi, SessionStorageApi } from '../lib/ports';
import { lifecycleApi, sessionStorageApi } from './chrome-adapter';

/** Keep chrome.storage.session readable only by extension pages, never by content scripts (design §5). */
export async function hardenSessionStorage(session: SessionStorageApi): Promise<void> {
  await session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export function start(lifecycle: LifecycleApi, session: SessionStorageApi): void {
  lifecycle.onInstalledOrStartup(() => {
    hardenSessionStorage(session).catch((error: unknown) => {
      console.error('Could not restrict storage.session access', error);
    });
  });
}

start(lifecycleApi, sessionStorageApi);
