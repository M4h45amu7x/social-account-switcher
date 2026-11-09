// In-memory fakes of the browser APIs in src/lib/ports.ts (docs/design.md §9.6).
// B1 covers storage.session and lifecycle events; B2 adds cookies, storage.local, tabs and scripting
// with real cookie rules.
import type { LifecycleApi, SessionAccessLevel, SessionStorageApi } from '../../src/lib/ports';

export interface FakeSessionStorage extends SessionStorageApi {
  accessLevel: SessionAccessLevel | null;
}

export function fakeSessionStorage(): FakeSessionStorage {
  const session: FakeSessionStorage = {
    accessLevel: null,
    async setAccessLevel({ accessLevel }) {
      session.accessLevel = accessLevel;
    },
  };
  return session;
}

export interface FakeLifecycle extends LifecycleApi {
  /** Fires every registered handler, like Chrome does on install/update/startup. */
  fire(): void;
}

export function fakeLifecycle(): FakeLifecycle {
  const handlers: (() => void)[] = [];
  return {
    onInstalledOrStartup: (handler) => {
      handlers.push(handler);
    },
    fire: () => {
      for (const handler of handlers) handler();
    },
  };
}
