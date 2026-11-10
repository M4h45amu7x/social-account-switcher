// Turns the popup's effects into requests for the service worker (src/lib/messages.ts) and the worker's
// answers into popup actions. It talks through functions it is given, so it holds no `chrome` and the
// unit tests drive it with a fake worker. Whatever happens (a dead port, an answer that makes no sense)
// it ends by dispatching an action that releases the busy state: the popup is never left waiting.
import type { Request } from '../lib/messages';
import { hostPattern, SITES } from '../lib/sites';
import { type Account, isAccount, type StoreV1 } from '../lib/store';
import { READ_DEADLINE_MS, SWITCH_DEADLINE_MS, WRITE_DEADLINE_MS } from '../lib/timing';
import type { App } from './app';
import type { Effect, Loaded } from './controller';
import { parseLanguagePref } from './i18n';
import type { AccountView, Platform, UsedLine } from './state';
import { parseThemePref } from './theme';
import { PLATFORM_INFO, PLATFORM_ORDER, stepCount } from './view';

export interface BridgeDeps {
  /** Frozen id from the same current-window tab query that selected the initial platform. */
  tabId?: number;
  /** One request to the worker; resolves with whatever it answered, rejects when it can't be reached. */
  send(message: Request): Promise<unknown>;
  openTab(url: string): Promise<unknown>;
  /** Open tabs of the platform's site. */
  countTabs(platform: Platform): Promise<number>;
  /** Runs `fn` after `ms` (setTimeout in the popup, a fake clock in tests). */
  later(fn: () => void, ms: number): void;
  now(): number;
}

/** How long each moment stays on screen. The same numbers as mockup/popup.html. */
export const TIMING = {
  step: 700,
  flash: 1400,
  toast: 4000,
  unlocked: 450,
  tryAgain: 1100,
} as const;

const SITE_URLS: Record<Platform, { home: string; login: string }> = {
  facebook: { home: 'https://www.facebook.com/', login: 'https://www.facebook.com/login/' },
  instagram: {
    home: 'https://www.instagram.com/',
    login: 'https://www.instagram.com/accounts/login/',
  },
  youtube: { home: 'https://www.youtube.com/', login: 'https://www.youtube.com/' },
};

export const siteUrl = (platform: Platform, login: boolean): string =>
  login ? SITE_URLS[platform].login : SITE_URLS[platform].home;

/** What the worker's answer must look like to be believed: `{ ok: true, value }` or `{ ok: false, error }`. */
export function parseReply(
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'unknown' };
  const r = raw as Record<string, unknown>;
  if (r.ok === true) return { ok: true, value: r.value };
  if (r.ok === false && typeof r.error === 'string') return { ok: false, error: r.error };
  return { ok: false, error: 'unknown' };
}

const HOUR = 3_600_000;

function usedLine(a: Account, now: number): UsedLine {
  const hours = Math.max(0, Math.floor((now - (a.lastUsedAt ?? a.createdAt)) / HOUR));
  if (hours < 1) return { kind: 'justNow' };
  if (hours < 24) return { kind: 'hoursAgo', n: hours };
  if (hours < 48) return { kind: 'yesterday' };
  return { kind: 'daysAgo', n: Math.floor(hours / 24) };
}

/** One saved account in the shape the popup draws. */
export function toAccountView(a: Account, now: number): AccountView {
  return {
    id: a.id,
    label: a.label,
    initials: a.initials,
    sub: a.youtube
      ? { kind: 'google', n: a.youtube.authuser + 1, brand: a.youtube.pageid !== undefined }
      : { kind: 'id', tail: (a.platformUserId ?? '').slice(-4) },
    used: usedLine(a, now),
    expired: a.status !== 'ok',
  };
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Checks the worker's state.get answer and maps it; null when it is not what the worker promises. */
export function decodeState(raw: unknown, now: number): Omit<Loaded, 'openTabs'> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const settings = r.settings as Partial<StoreV1['settings']> | null | undefined;
  const active = r.active as Record<string, unknown> | null | undefined;
  if (!Array.isArray(r.accounts) || !r.accounts.every(isAccount)) return null;
  if (typeof r.hasVault !== 'boolean' || typeof r.locked !== 'boolean') return null;
  if (!isStringArray(r.busy) || typeof settings !== 'object' || settings === null) return null;
  if (typeof active !== 'object' || active === null) return null;
  const accounts = r.accounts as Account[];
  const platforms = {} as Loaded['platforms'];
  for (const p of PLATFORM_ORDER) {
    const id = active[p];
    platforms[p] = {
      accounts: accounts.filter((a) => a.platform === p).map((a) => toAccountView(a, now)),
      activeId: typeof id === 'string' ? id : null,
      busy: (r.busy as string[]).includes(p),
    };
  }
  return {
    hasVault: r.hasVault,
    locked: r.locked,
    theme: parseThemePref(settings.theme),
    language: parseLanguagePref(settings.language),
    platforms,
  };
}

/** The tab pattern of a platform's site (src/lib/sites.ts), for counting its open tabs. */
export const tabPattern = (p: Platform): string => {
  const site = SITES.find((x) => x.platform === p);
  return site ? hostPattern(site) : '';
};

export function createBridge(deps: BridgeDeps): (effect: Effect, app: App) => void {
  // Cookie accounts outside the contextual flow are profile-wide. YouTube is always page-specific.
  const tabTarget = (app: App, platform: Platform) =>
    deps.tabId !== undefined && (platform === 'youtube' || app.state().here?.platform === platform)
      ? { tabId: deps.tabId }
      : {};
  /** Runs `work`, giving up with `fallback` after `ms`. An answer that comes later is dropped, never applied. */
  const withDeadline = <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> =>
    new Promise<T>((resolve) => {
      deps.later(() => resolve(fallback), ms);
      // `work` is always built not to reject (ask() and the tab count both catch), so only the clock can give up
      void work.then(resolve);
    });

  /** The one place every request passes: a deadline by kind, a dead port, a malformed answer. */
  const ask = async (request: Request) => {
    const ms =
      request.type === 'state.get' || request.type === 'account.probe'
        ? READ_DEADLINE_MS
        : request.type === 'account.switch'
          ? SWITCH_DEADLINE_MS
          : WRITE_DEADLINE_MS;
    const gone = { ok: false, error: 'unknown' } as const;
    const late = { ok: false, error: 'timeout' } as const;
    try {
      const raw = deps.send(request).then(parseReply, () => gone);
      return await withDeadline<ReturnType<typeof parseReply>>(raw, ms, late);
    } catch {
      return gone;
    }
  };

  /** Asks the worker what it holds and draws it. Says nothing on failure: the caller decides what to tell the person. */
  async function fetchState(
    app: App,
    closeForms = false,
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    const reply = await ask({ type: 'state.get' });
    const data = reply.ok ? decodeState(reply.value, deps.now()) : null;
    if (!data) return { ok: false, code: reply.ok ? 'unknown' : reply.error };
    const counts = await Promise.all(
      PLATFORM_ORDER.map((p) =>
        withDeadline(
          deps.countTabs(p).catch(() => 0),
          READ_DEADLINE_MS,
          0,
        ),
      ),
    );
    const openTabs = Object.fromEntries(PLATFORM_ORDER.map((p, i) => [p, counts[i] ?? 0]));
    app.dispatch({
      type: 'loaded',
      data: { ...data, openTabs: openTabs as Loaded['openTabs'] },
      closeForms,
    });
    void markHere(app);
    return { ok: true };
  }

  /**
   * The popup opened over one of the sites: ask the worker (account.probe, which only reads the browser's
   * own cookies or the open YouTube page) which saved account that tab is logged in to. Quiet on failure:
   * the badge is a hint, never a reason for an error.
   */
  async function markHere(app: App): Promise<void> {
    const s = app.state();
    if (!s.here || s.page !== 'main' || s.platforms[s.here.platform].accounts.length === 0) return;
    const { platform } = s.here;
    const reply = await ask({ type: 'account.probe', platform, ...tabTarget(app, platform) });
    if (!reply.ok) return;
    const id = (reply.value as { accountId?: unknown } | null)?.accountId;
    app.dispatch({ type: 'here-account', platform, accountId: typeof id === 'string' ? id : null });
  }

  async function load(app: App, closeForms = false): Promise<void> {
    const got = await fetchState(app, closeForms);
    if (got.ok) return;
    // a read that timed out leaves nothing on screen to trust: same words and the same way out as a failed reconcile
    app.dispatch({
      type: 'failed',
      code: got.code === 'timeout' ? 'timeoutStale' : got.code,
      retry: { type: 'load' },
    });
  }

  /**
   * The one way out of a timeout, for every request: drop what the popup set while waiting, ask the worker what is
   * true now, draw it, and only then say so. If that read fails too, the notice says the state is stale, every
   * write stays off and the only button repeats the read. The timed-out write itself is never sent again.
   */
  async function timedOut(app: App, id?: string): Promise<void> {
    app.dispatch({ type: 'settle' });
    const got = await fetchState(app);
    app.dispatch(
      got.ok
        ? { type: 'failed', code: 'timeout', ...(id ? { id } : {}) }
        : { type: 'failed', code: 'timeoutStale', retry: { type: 'load' }, ...(id ? { id } : {}) },
    );
    if (id) deps.later(() => app.dispatch({ type: 'flash-clear' }), TIMING.flash);
  }

  /** The step text follows the clock: the worker answers once, when the whole switch is done. */
  function walkSteps(app: App, platform: Platform, id: string): void {
    const tick = (): void => {
      const sw = app.state().switching;
      if (!sw || sw.id !== id || sw.step + 1 >= stepCount(platform)) return;
      app.dispatch({ type: 'switch-step', step: sw.step + 1 });
      deps.later(tick, TIMING.step);
    };
    deps.later(tick, TIMING.step);
  }

  const finishUnlock = async (app: App): Promise<void> => {
    app.dispatch({ type: 'unlock-result', ok: true });
    await load(app);
    deps.later(() => app.dispatch({ type: 'unlock-done' }), TIMING.unlocked);
  };

  const failUnlock = async (app: App, code: string): Promise<void> => {
    if (code === 'timeout') return timedOut(app);
    app.dispatch({ type: 'unlock-result', ok: false, code });
    deps.later(() => app.dispatch({ type: 'unlock-reset' }), TIMING.tryAgain);
    // the worker says there is (or is not) a vault: show the page that fits
    if (code === 'no_vault' || code === 'vault_exists') await load(app);
  };

  /** Something failed: say so, then fetch the truth so optimistic changes on screen are corrected. */
  async function failAndReload(
    app: App,
    code: string,
    extra: { id?: string; retry?: Effect } = {},
  ) {
    // A write that timed out may or may not have happened: read the truth first, never run it again by itself.
    if (code === 'timeout') return timedOut(app, extra.id);
    const { retry, ...rest } = extra;
    app.dispatch({ type: 'failed', code, ...rest, ...(retry ? { retry } : {}) });
    if (extra.id) deps.later(() => app.dispatch({ type: 'flash-clear' }), TIMING.flash);
    await load(app);
  }

  let adding = false;
  let reading: Promise<void> | null = null;

  async function run(effect: Effect, app: App): Promise<void> {
    // stale state: only a read may go out (the buttons are off too; this is the backstop)
    if (app.state().stale && effect.type !== 'load' && effect.type !== 'open-site') {
      app.dispatch({ type: 'settle' });
      return;
    }
    switch (effect.type) {
      case 'load': {
        // Try again pressed again while a read is out: share that read instead of sending another
        if (!reading) {
          reading = load(app).finally(() => {
            reading = null;
          });
        }
        return reading;
      }
      case 'switch': {
        walkSteps(app, effect.platform, effect.id);
        const reply = await ask({
          type: 'account.switch',
          accountId: effect.id,
          ...(effect.force ? { force: true } : {}),
        });
        if (!reply.ok) {
          const retry: Effect | undefined =
            reply.error === 'unsaved_current' ? { ...effect, force: true } : undefined;
          return failAndReload(app, reply.error, { id: effect.id, ...(retry ? { retry } : {}) });
        }
        const v = reply.value as { reloadedTabs?: unknown } | null;
        const tabs = typeof v?.reloadedTabs === 'number' ? v.reloadedTabs : 0;
        app.dispatch({ type: 'switch-done', ok: true, tabs });
        deps.later(() => app.dispatch({ type: 'flash-clear' }), TIMING.flash);
        deps.later(() => app.dispatch({ type: 'toast-clear' }), TIMING.toast);
        return load(app);
      }
      case 'rename': {
        const reply = await ask({
          type: 'account.rename',
          accountId: effect.id,
          label: effect.label,
        });
        if (!reply.ok) await failAndReload(app, reply.error, { retry: effect });
        return;
      }
      case 'delete': {
        const reply = await ask({ type: 'account.remove', accountId: effect.id });
        if (!reply.ok) await failAndReload(app, reply.error, { retry: effect });
        return;
      }
      case 'probe-add': {
        const reply = await ask({
          type: 'account.probe',
          platform: effect.platform,
          ...tabTarget(app, effect.platform),
        });
        if (!reply.ok) return failAndReload(app, reply.error, { retry: effect });
        const found = reply.value as { tail?: unknown; brand?: unknown } | null;
        const tail = found?.tail;
        if (tail === null) return app.dispatch({ type: 'add-probed', found: null });
        if (typeof tail !== 'string') return failAndReload(app, 'unknown', { retry: effect });
        const view = app.state().platforms[effect.platform];
        const defaultName = app.translator().text('add_defaultName', {
          platform: PLATFORM_INFO[effect.platform].name,
          n: view.accounts.length + 1,
        });
        return app.dispatch({
          type: 'add-probed',
          found: { idTail: tail, defaultName, ...(found?.brand === true ? { brand: true } : {}) },
        });
      }
      case 'add': {
        if (adding) return;
        adding = true;
        try {
          const reply = await ask({
            type: 'account.addCurrent',
            ...tabTarget(app, effect.platform),
            platform: effect.platform,
            label: effect.label,
          });
          if (reply.ok) return await load(app, true);
          if (reply.error === 'not_logged_in')
            return app.dispatch({ type: 'add-probed', found: null });
          const again = reply.error === 'duplicate' ? {} : { retry: effect };
          return await failAndReload(app, reply.error, again);
        } finally {
          adding = false;
        }
      }
      case 'update-session': {
        const reply = await ask({
          type: 'account.updateSession',
          accountId: effect.id,
          ...(deps.tabId !== undefined ? { tabId: deps.tabId } : {}),
        });
        if (reply.ok) return load(app, true);
        return failAndReload(app, reply.error, { id: effect.id, retry: effect });
      }
      case 'open-site':
        try {
          await deps.openTab(siteUrl(effect.platform, effect.login));
        } catch {
          app.dispatch({ type: 'failed', code: 'unknown' });
        }
        return;
      case 'unlock': {
        const reply = await ask({ type: 'vault.unlock', password: effect.password });
        return reply.ok ? finishUnlock(app) : failUnlock(app, reply.error);
      }
      case 'setup': {
        const reply = await ask({ type: 'vault.setup', password: effect.password });
        return reply.ok ? finishUnlock(app) : failUnlock(app, reply.error);
      }
      case 'lock': {
        const reply = await ask({ type: 'vault.lock' });
        if (!reply.ok) return failAndReload(app, reply.error, { retry: effect });
        return load(app);
      }
      case 'wipe': {
        const reply = await ask({ type: 'vault.wipe', scope: effect.scope });
        if (!reply.ok) return failAndReload(app, reply.error, { retry: effect });
        return load(app);
      }
      case 'settings': {
        const reply = await ask({
          type: 'settings.set',
          ...(effect.theme ? { theme: effect.theme } : {}),
          ...(effect.language ? { language: effect.language } : {}),
        });
        if (!reply.ok) await failAndReload(app, reply.error, { retry: effect });
        return;
      }
    }
  }

  return (effect, app) => {
    // run() answers every failure itself; this only keeps an unexpected throw from becoming an unhandled rejection
    run(effect, app).catch(() => app.dispatch({ type: 'failed', code: 'unknown' }));
  };
}
