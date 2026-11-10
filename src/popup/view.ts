import { type AccountProfile, sanitizeProfile } from '../lib/profile';
import { initialsOf } from '../lib/store';
// Pure render: PopupState → DOM. No chrome.*, no timers, no storage. The markup, class names, data-testid
// and data-act values are the ones in mockup/popup.html, so popup.css and the e2e selectors carry over.
// Every dynamic value goes through the escaping `html` builder (html.ts).
import { ERROR_TEXT } from './errors';
import { esc, html, raw, type Safe } from './html';
import type { MessageKey, Translator } from './i18n';
import {
  type AccountProblem,
  type AccountView,
  type AddView,
  type Platform,
  type PopupState,
  type SubLine,
  screenOf,
  type UsedLine,
  WRITE_ACTIONS,
} from './state';

export const PLATFORM_ORDER: readonly Platform[] = ['facebook', 'instagram', 'youtube'];

/** Brand names and sites are not translated. */
export const PLATFORM_INFO: Record<Platform, { name: string; site: string }> = {
  facebook: { name: 'Facebook', site: 'facebook.com' },
  instagram: { name: 'Instagram', site: 'instagram.com' },
  youtube: { name: 'YouTube', site: 'youtube.com' },
};

const stroke = (size: number, body: string, width = 2, extra = ''): Safe =>
  raw(
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`,
  );

/** The official marks, shipped inside the extension (public/brands, see SOURCES.md there). Never loaded from the web. */
const logo = (p: Platform): Safe =>
  raw(`<img class="mark" src="/brands/${p}.svg" alt="" aria-hidden="true" draggable="false">`);

export const ICON = {
  facebook: logo('facebook'),
  instagram: logo('instagram'),
  youtube: logo('youtube'),
  pencil: stroke(16, '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>'),
  trash: stroke(16, '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  eye: stroke(
    18,
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  ),
  eyeOff: stroke(
    18,
    '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.7-1.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  ),
  gear: stroke(
    18,
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  ),
  back: stroke(18, '<path d="M15 5l-7 7 7 7"/>'),
  lockBig: stroke(
    28,
    '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="12" cy="16" r="1.2"/>',
    1.8,
  ),
  shield: stroke(13, '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>'),
  plus: stroke(16, '<path d="M12 5v14M5 12h14"/>', 2.2),
  check: stroke(12, '<path d="M5 12l5 5 9-10"/>', 3),
  cross: stroke(12, '<path d="M6 6l12 12M18 6L6 18"/>', 3),
  alert: stroke(16, '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>'),
  swap: raw(
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/></svg>',
  ),
} as const;

/** The big platform mark on the empty screen (the same icon without its `mark` class). */
const bigIcon = (p: Platform): Safe =>
  raw(ICON[p].value.replace('class="mark"', 'class="big-mark"'));

// --- small text helpers ---

const STEPS: Record<Platform, readonly ('save' | 'apply' | 'reload' | 'google')[]> = {
  facebook: ['save', 'apply', 'reload'],
  instagram: ['save', 'apply', 'reload'],
  youtube: ['google', 'reload'],
};

export function stepCount(p: Platform): number {
  return STEPS[p].length;
}

function stepLabel(tr: Translator, s: PopupState, step: number): string {
  const steps = STEPS[s.platform];
  const which = steps[Math.min(step, steps.length - 1)];
  if (which === 'reload') {
    const tabs = tr.count('tabs', s.platforms[s.platform].openTabs);
    return `${tr.text('step_reload', { tabs })}…`;
  }
  return `${tr.text(`step_${which ?? 'save'}` as MessageKey)}…`;
}

function subText(tr: Translator, sub: SubLine): string {
  if (sub.kind === 'id') return `ID ••••${sub.tail}`;
  return tr.text(sub.brand ? 'sub_googleBrand' : 'sub_google', { n: sub.n });
}

function usedText(tr: Translator, used: UsedLine, active: boolean): string {
  if (active) return tr.text('used_now');
  switch (used.kind) {
    case 'hoursAgo':
      return tr.text('used_hoursAgo', { n: used.n });
    case 'daysAgo':
      return tr.text('used_daysAgo', { n: used.n });
    case 'now':
      return tr.text('used_now');
    case 'justNow':
      return tr.text('used_justNow');
    case 'yesterday':
      return tr.text('used_yesterday');
    case 'updated':
      return tr.text('used_updated');
  }
}

// --- pieces ---

function header(tr: Translator, s: PopupState, mode: 'main' | 'settings' | 'locked'): Safe {
  if (mode === 'settings') {
    return html`<header class="head">
      <button class="icon-btn" data-act="settings-close" title="${tr.text('app_back')}" aria-label="${tr.text('app_back')}" data-testid="settings-back">${ICON.back}</button><h1>${tr.html('settings_title')}</h1>
    </header>`;
  }
  return html`<header class="head">
      <div class="logo">${ICON.swap}</div><h1>${tr.html('app_title')}</h1>
      ${mode === 'main' && html`<button class="icon-btn" data-act="settings-open" title="${tr.text('app_settings')}" aria-label="${tr.text('app_settings')}" data-testid="settings-btn" ${s.switching ? 'disabled' : ''}>${ICON.gear}</button>`}
    </header>`;
}

const footer = (tr: Translator): Safe =>
  html`<footer class="foot">${ICON.shield}<span>${tr.html('foot')}</span></footer>`;

function slot(tr: Translator, s: PopupState, a: AccountView, switchingThis: boolean): Safe {
  if (switchingThis) {
    return html`<span class="slot" data-id="${a.id}"><span class="spinner" role="progressbar" aria-label="${tr.text('switching_aria')}"></span></span>`;
  }
  if (s.flash && s.flash.id === a.id) {
    const ok = s.flash.kind === 'ok';
    return html`<span class="slot" data-id="${a.id}"><span class="flash ${ok ? 'ok' : 'bad'}" data-testid="flash-${a.id}">${ok ? ICON.check : ICON.cross}</span></span>`;
  }
  const dis = s.switching ? 'disabled' : '';
  return html`<span class="slot" data-id="${a.id}"><span class="actions">
        <button class="icon-btn" data-act="rename" data-id="${a.id}" title="${tr.text('row_rename')}" aria-label="${tr.text('row_renameAria', { name: a.label })}" data-testid="rename-${a.id}" ${dis}>${ICON.pencil}</button>
        <button class="icon-btn danger" data-act="delete" data-id="${a.id}" title="${tr.text('row_delete')}" aria-label="${tr.text('row_deleteAria', { name: a.label })}" data-testid="delete-${a.id}" ${dis}>${ICON.trash}</button>
      </span></span>`;
}

function row(tr: Translator, s: PopupState, a: AccountView): Safe {
  const p = s.platform;
  const active = a.id === s.platforms[p].activeId;
  const avatar = html`<span class="avatar" aria-hidden="true">${a.initials}<span class="pf">${ICON[p]}</span></span>`;

  if (s.confirmDelete === a.id) {
    const detail =
      p === 'youtube'
        ? tr.text('delete_youtube')
        : tr.text('delete_cookie', { platform: PLATFORM_INFO[p].name });
    return html`<li class="row confirm" data-testid="confirm-delete" data-id="${a.id}">
      <p>${tr.html('delete_title', { name: a.label })}
        <small>${detail}${active && tr.text('delete_stillIn')}</small></p>
      <div class="btns">
        <button class="btn" data-act="del-cancel" data-testid="delete-cancel">${tr.html('common_cancel')}</button>
        <button class="btn danger" data-act="del-ok" data-id="${a.id}" data-testid="delete-confirm">${tr.html('common_delete')}</button>
      </div></li>`;
  }
  if (s.editing && s.editing.id === a.id) {
    const e = s.editing;
    return html`<li class="row editing" data-id="${a.id}">${avatar}
      <div class="edit">
        <label class="sr" for="rename-input">${tr.html('rename_label')}</label>
        <input id="rename-input" dir="auto" data-testid="rename-input" maxlength="40" value="${e.value}" data-autofocus>
        <div class="hint ${e.bad ? 'bad' : ''}" data-testid="rename-hint">${tr.html(e.bad ? 'rename_bad' : 'rename_hint')}</div>
        <div class="btns">
          <button class="btn ghost" data-act="rename-cancel" data-testid="rename-cancel">${tr.html('common_cancel')}</button>
          <button class="btn primary" data-act="rename-save" data-testid="rename-save">${tr.html('common_save')}</button>
        </div>
      </div></li>`;
  }

  const busy = s.switching !== null && s.switching.id === a.id;
  let sub: Safe;
  if (busy && s.switching) {
    const { step } = s.switching;
    const bars = Array.from(
      { length: stepCount(p) },
      (_, i) => html`<i class="${i <= step ? 'done' : ''}"></i>`,
    );
    sub = html`<div class="sub" data-testid="switch-step">${stepLabel(tr, s, step)}</div><div class="steps">${bars}</div>`;
  } else {
    sub = html`<div class="sub">${subText(tr, a.sub)} · ${usedText(tr, a.used, active)}</div>`;
  }
  // what the tab under the popup is logged in to wins over what the extension last switched to
  const onTab = s.here?.platform === p && s.here.accountId === a.id;
  const chip = busy
    ? ''
    : onTab
      ? html`<span class="chip on here" data-testid="chip-here">${tr.html('chip_here')}</span>`
      : active
        ? html`<span class="chip on">${tr.html('chip_active')}</span>`
        : a.expired
          ? html`<span class="chip bad">${tr.html('chip_relogin')}</span>`
          : '';
  const label = tr.text(active ? 'row_activeAria' : 'row_switchTo', { name: a.label });
  return html`<li class="row ${active ? 'active' : ''} ${busy ? 'busy' : ''}" data-id="${a.id}" data-testid="row-${a.id}">
    <button class="main" data-act="switch" data-id="${a.id}" ${active || s.switching || s.platforms[p].busy ? 'disabled' : ''} aria-label="${label}">
      ${avatar}<span class="who"><div class="name"><span class="nm" dir="auto"></span>${chip}</div><div class="profile-details" dir="auto"></div>${sub}</span>
    </button>${slot(tr, s, a, busy)}</li>`;
}

/** The tab under the popup is already on this platform's site: no need to send the person there. */
const onSite = (s: PopupState): boolean => s.here?.platform === s.platform;

function addView(tr: Translator, s: PopupState, adding: AddView): Safe {
  const p = s.platform;
  const info = PLATFORM_INFO[p];
  if (adding.kind === 'notLoggedIn') {
    if (onSite(s)) {
      return html`<div class="note warn" data-testid="add-not-logged-in">${ICON.alert}<span>${tr.html('add_notLoggedInHere', { platform: info.name })}</span></div>
      <div class="btns"><button class="btn" data-act="add-cancel" data-testid="add-cancel">${tr.html('common_close')}</button></div>`;
    }
    return html`<div class="note warn" data-testid="add-not-logged-in">${ICON.alert}<span>${tr.html('add_notLoggedIn', { platform: info.name, site: info.site })}</span></div>
      <div class="btns"><button class="btn" data-act="add-cancel" data-testid="add-cancel">${tr.html('common_close')}</button><button class="btn primary" data-act="open-site">${ICON[p]}${tr.html('add_open', { site: info.site })}</button></div>`;
  }
  // YouTube: only what the worker really read (which Google account, brand or not); nothing when it read none
  const who =
    p === 'youtube'
      ? adding.idTail
        ? tr.text(adding.brand ? 'sub_googleBrand' : 'sub_google', { n: adding.idTail })
        : ''
      : tr.text('add_metaCookie', { platform: info.name, tail: adding.idTail });
  return html`<div class="panel add-form" data-testid="add-form">
    <div class="ttl">${tr.html('add_found')}</div>
    ${who && html`<div class="meta">${who}</div>`}
    <div class="profile-preview" data-profile-preview><span class="avatar" aria-hidden="true"></span><span class="profile-details" dir="auto"></span></div>
    <div class="edit">
      <label class="sr" for="add-input">${tr.html('add_label')}</label>
      <input id="add-input" dir="auto" data-testid="add-input" maxlength="40" placeholder="${tr.text('add_placeholder')}" data-autofocus>
      <div class="hint ${adding.bad ? 'bad' : ''}" data-testid="add-hint">${tr.html(adding.bad ? 'rename_bad' : 'add_hint')}</div>
      <div class="btns">
        <button class="btn ghost" data-act="add-cancel" data-testid="add-cancel">${tr.html('common_cancel')}</button>
        <button class="btn primary" data-act="add-save" data-testid="add-save">${tr.html('add_save')}</button>
      </div>
    </div></div>`;
}

function emptyView(tr: Translator, s: PopupState): Safe {
  const p = s.platform;
  const info = PLATFORM_INFO[p];
  if (onSite(s)) {
    // already on the site: log in right there, then one button, no "Open facebook.com"
    return html`<div class="empty" data-testid="empty" data-here="1">
    <div class="big">${bigIcon(p)}</div>
    <h2>${tr.html('empty_title', { platform: info.name })}</h2>
    <ol>
      <li>${tr.html('empty_hereStep1')}</li>
      <li>${tr.html('empty_hereStep2')}</li>
    </ol>
    <div class="note info">${tr.html('empty_note')}</div>
    <div class="row-btns">
      <button class="btn primary" data-act="add" data-testid="add-account">${tr.html('add_here')}</button>
    </div></div>`;
  }
  return html`<div class="empty" data-testid="empty">
    <div class="big">${bigIcon(p)}</div>
    <h2>${tr.html('empty_title', { platform: info.name })}</h2>
    <ol>
      <li>${tr.html('empty_step1', { site: info.site })}</li>
      <li>${tr.html('empty_step2')}</li>
      <li>${tr.html('empty_step3')}</li>
    </ol>
    <div class="note info">${tr.html('empty_note')}</div>
    <div class="row-btns">
      <button class="btn" data-act="open-site" data-testid="open-site">${ICON[p]}${tr.html('add_open', { site: info.site })}</button>
      <button class="btn primary" data-act="add" data-testid="add-account">${tr.html('empty_addShort')}</button>
    </div></div>`;
}

function errorNote(tr: Translator, s: PopupState, id: string, code: AccountProblem): Safe {
  const a = s.platforms[s.platform].accounts.find((x) => x.id === id);
  const name = a?.label ?? '';
  const info = PLATFORM_INFO[s.platform];
  const wait = s.platforms[s.platform].busy ? 'disabled' : '';
  const [title, detail] =
    code === 'checkpoint'
      ? [
          tr.html('error_checkpointTitle', { platform: info.name }),
          tr.html('error_checkpointDetail', { name }),
        ]
      : code === 'wrong_account'
        ? [tr.html('error_wrongTitle'), tr.html('error_wrongDetail', { name })]
        : [
            tr.html('error_title', { name }),
            html`${tr.html('error_detail', { platform: info.name })}<br>${tr.html('error_fix', { name })}`,
          ];
  const open =
    code === 'checkpoint'
      ? html`<button class="btn primary" data-act="open-site" data-testid="error-open">${ICON[s.platform]}${tr.html('add_open', { site: info.site })}</button>`
      : html`<button class="btn" data-act="open-site" data-testid="error-open">${tr.html('error_openLogin')}</button>
      <button class="btn primary" data-act="err-update" data-testid="error-update" ${wait}>${tr.html('error_update')}</button>`;
  return html`<div class="note err" role="alert" data-testid="error" data-code="${code}">
    <div class="t">${ICON.alert}${title}</div>
    <div class="d">${detail}</div>
    <div class="btns">
      <button class="btn ghost" data-act="err-close" data-testid="error-close">${tr.html('common_close')}</button>
      ${open}
    </div></div>`;
}

/** Any other failure, in words. The retry button only shows when repeating the request can help. */
function noticeNote(
  tr: Translator,
  notice: NonNullable<PopupState['notice']>,
  stale: boolean,
): Safe {
  // stale: Try again is always there and always only reads (the reducer turns it into a load)
  const again = notice.retry ?? (stale ? ({ type: 'load' } as const) : null);
  const label =
    again?.type === 'switch' && again.force ? 'err_switchAnyway' : ('common_retry' as const);
  return html`<div class="note err" role="alert" data-testid="notice" data-code="${notice.code}">
    <div class="t">${ICON.alert}${tr.html(ERROR_TEXT[notice.code])}</div>
    <div class="btns">
      <button class="btn ghost" data-act="notice-close" data-testid="notice-close">${tr.html('common_close')}</button>
      ${again && html`<button class="btn primary" data-act="notice-retry" data-testid="notice-retry">${tr.html(label)}</button>`}
    </div></div>`;
}

function unlockButton(tr: Translator, s: PopupState): Safe {
  const k = s.lock.button;
  const face =
    k === 'loading'
      ? html`<span class="spinner" aria-hidden="true"></span>${tr.html('lock_unlocking')}`
      : k === 'ok'
        ? html`${ICON.check}${tr.html('lock_unlocked')}`
        : k === 'err'
          ? html`${ICON.cross}${tr.html('lock_tryAgain')}`
          : tr.html('lock_unlock');
  const cls = k === 'ok' ? 'is-ok' : k === 'err' ? 'is-err' : '';
  return html`<button class="btn primary sbtn ${cls}" data-sbtn data-act="unlock" data-testid="unlock" data-btn-state="${k}" ${k === 'loading' ? 'disabled' : ''}>${face}</button>`;
}

/** The words under the password box: the worker's reason, "wrong password", or the password rule. */
export function lockHint(s: PopupState): MessageKey {
  const { lock } = s;
  if (lock.error) return ERROR_TEXT[lock.error];
  return lock.bad && s.page !== 'setup' ? 'lock_bad' : 'lock_hint';
}

function setupButton(tr: Translator, s: PopupState): Safe {
  const k = s.lock.button;
  const face =
    k === 'loading'
      ? html`<span class="spinner" aria-hidden="true"></span>${tr.html('setup_creating')}`
      : k === 'ok'
        ? html`${ICON.check}${tr.html('setup_created')}`
        : k === 'err'
          ? html`${ICON.cross}${tr.html('lock_tryAgain')}`
          : tr.html('setup_create');
  const cls = k === 'ok' ? 'is-ok' : k === 'err' ? 'is-err' : '';
  return html`<button class="btn primary sbtn ${cls}" data-sbtn data-act="setup" data-testid="setup-create" data-btn-state="${k}" ${k === 'loading' ? 'disabled' : ''}>${face}</button>`;
}

function loadingBody(tr: Translator, s: PopupState): Safe {
  return html`
    ${header(tr, s, 'locked')}
    <section class="lock" data-testid="loading" data-panel>
      <span class="spinner" role="progressbar" aria-label="${tr.text('loading_aria')}"></span>
    </section>
    ${footer(tr)}`;
}

function lockedBody(tr: Translator, s: PopupState): Safe {
  const { lock } = s;
  const setup = s.page === 'setup';
  const hint = lockHint(s);
  return html`
    ${header(tr, s, 'locked')}
    <section class="lock" data-testid="${setup ? 'setup' : 'locked'}" data-panel>
      <div class="big">${ICON.lockBig}</div>
      <div><b>${tr.html(setup ? 'setup_title' : 'lock_title')}</b><div class="hint">${tr.html(setup ? 'setup_sub' : 'lock_sub')}</div></div>
      <div class="pw ${lock.bad ? 'bad' : ''}">
        <label class="sr" for="pw-input">${tr.html(setup ? 'setup_label' : 'lock_label')}</label>
        <input id="pw-input" type="${lock.show ? 'text' : 'password'}" autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder="${tr.text(setup ? 'setup_label' : 'lock_placeholder')}" data-testid="pw-input" data-autofocus>
        <button class="icon-btn" data-act="pw-toggle" data-testid="pw-toggle" aria-pressed="${String(lock.show)}" aria-label="${tr.text(lock.show ? 'lock_hide' : 'lock_show')}" title="${tr.text(lock.show ? 'lock_hide' : 'lock_show')}">${lock.show ? ICON.eyeOff : ICON.eye}</button>
      </div>
      <div class="hint ${lock.bad ? 'bad' : ''}" data-testid="pw-hint">${tr.html(hint)}</div>
      ${
        s.stale
          ? html`<button class="btn primary" data-act="notice-retry" data-testid="notice-retry">${tr.html('common_retry')}</button>`
          : setup
            ? setupButton(tr, s)
            : lock.wipeConfirm
              ? html`<div class="row confirm wipe" data-testid="wipe-confirm">
          <p>${tr.html('wipe_title')}
            <small>${tr.html('wipe_detail')}</small></p>
          <div class="btns"><button class="btn" data-act="wipe-cancel" data-testid="wipe-cancel">${tr.html('common_cancel')}</button>
          <button class="btn danger" data-act="wipe-ok" data-testid="wipe-ok">${tr.html('wipe_ok')}</button></div></div>`
              : html`${unlockButton(tr, s)}
      <button class="btn ghost small" data-act="forgot" data-testid="forgot">${tr.html('lock_forgot')}</button>`
      }
    </section>
    ${footer(tr)}`;
}

function segment(
  tr: Translator,
  group: 'theme' | 'language',
  items: readonly (readonly [value: string, key: MessageKey, lang?: string])[],
  current: string,
): Safe {
  const buttons = items.map(
    ([value, key, lang]) =>
      html`<button data-pref="${group}" data-value="${value}" aria-pressed="${String(value === current)}" data-testid="s-${group === 'language' ? 'lang' : group}-${value}" ${lang ? raw(`lang="${esc(lang)}"`) : ''}>${tr.html(key)}</button>`,
  );
  const label = tr.text(group === 'theme' ? 'settings_theme' : 'settings_language');
  const at = Math.max(
    0,
    items.findIndex(([value]) => value === current),
  );
  return html`<div class="seg slide" data-slide="${group}" style="--n:${items.length};--i:${at}" role="group" aria-label="${label}"><span class="thumb" aria-hidden="true"></span>${buttons}</div>`;
}

function settingsBody(tr: Translator, s: PopupState): Safe {
  const { settings } = s;
  const langNow = tr.text(settings.uiLanguage === 'th' ? 'lang_name_th' : 'lang_name_en');
  return html`
    ${header(tr, s, 'settings')}
    <section class="body settings" data-panel data-testid="settings">
      ${s.notice && noticeNote(tr, s.notice, s.stale)}
      <div class="set-card" data-card="theme">
        <h2>${tr.html('settings_theme')}</h2>
        ${segment(
          tr,
          'theme',
          [
            ['system', 'settings_themeSystem'],
            ['light', 'settings_themeLight'],
            ['dark', 'settings_themeDark'],
          ],
          settings.theme,
        )}
      </div>
      <div class="set-card" data-card="lang">
        <h2>${tr.html('settings_language')}</h2>
        ${segment(
          tr,
          'language',
          [
            ['auto', 'settings_langAuto'],
            ['en', 'settings_langEn', 'en'],
            ['th', 'settings_langTh', 'th'],
          ],
          settings.language,
        )}
        <p>${tr.html('settings_langHint', { lang: langNow })}</p>
      </div>
      <div class="set-card" data-card="lock">
        <h2>${tr.html('settings_lockTitle')}</h2>
        <p>${tr.html('settings_lockDesc')}</p>
        <button class="btn" data-act="lock-now" data-testid="lock-now">${tr.html('settings_lockBtn')}</button>
      </div>
      ${
        settings.wipeConfirm
          ? html`<div class="set-card danger confirm" data-card="wipe" data-testid="settings-wipe-confirm">
            <h2>${tr.html('settings_wipeConfirmTitle')}</h2>
            <p>${tr.html('settings_wipeConfirmDetail')}</p>
            <div class="btns end"><button class="btn" data-act="s-wipe-cancel" data-testid="s-wipe-cancel">${tr.html('common_cancel')}</button>
            <button class="btn danger" data-act="s-wipe-ok" data-testid="s-wipe-ok">${tr.html('settings_wipeConfirmOk')}</button></div>
          </div>`
          : html`<div class="set-card danger" data-card="wipe">
            <h2>${tr.html('settings_wipeTitle')}</h2>
            <p>${tr.html('settings_wipeDesc')}</p>
            <button class="btn outline-danger" data-act="s-wipe" data-testid="s-wipe">${tr.html('settings_wipeBtn')}</button>
          </div>`
      }
    </section>
    ${footer(tr)}`;
}

function mainBody(tr: Translator, s: PopupState): Safe {
  const p = s.platform;
  const view = s.platforms[p];
  const list = view.accounts;
  const busy = s.switching !== null;
  const info = PLATFORM_INFO[p];

  const tabs = PLATFORM_ORDER.map(
    (k) => html`
    <button class="tab" role="tab" title="${PLATFORM_INFO[k].name}" aria-label="${PLATFORM_INFO[k].name}" aria-describedby="tab-count-${k}" aria-selected="${String(k === p)}" data-tab="${k}" data-testid="tab-${k}" ${busy ? 'disabled' : ''}>
      ${ICON[k]}<span class="label">${PLATFORM_INFO[k].name}</span><span class="count" id="tab-count-${k}">${s.platforms[k].accounts.length}</span>
    </button>`,
  );

  const parts: unknown[] = [];
  if (s.error) parts.push(errorNote(tr, s, s.error.id, s.error.code));
  if (s.notice) parts.push(noticeNote(tr, s.notice, s.stale));
  if (list.length === 0 && !s.adding) {
    parts.push(emptyView(tr, s));
  } else {
    if (list.length) {
      // the active account goes first
      const ordered = [...list].sort(
        (a, b) => Number(b.id === view.activeId) - Number(a.id === view.activeId),
      );
      parts.push(
        html`<div class="section-label"><span class="with-mark">${ICON[p]}${tr.html('list_label', { platform: info.name, n: list.length })}</span><span>${tr.html(p === 'youtube' ? 'list_hintYoutube' : 'list_hintTap')}</span></div>`,
        html`<ul class="list ${busy ? 'dim' : ''}" data-testid="account-list">${ordered.map((a) => row(tr, s, a))}</ul>`,
      );
    }
    parts.push(
      s.adding
        ? addView(tr, s, s.adding)
        : html`<button class="add" data-act="add" data-testid="add-account" ${busy || view.busy ? 'disabled' : ''}>${ICON.plus}${tr.html(onSite(s) ? 'add_here' : 'list_add')}</button>`,
    );
    if (p === 'youtube') parts.push(html`<div class="note info">${tr.html('youtube_note')}</div>`);
  }

  const toast =
    s.toast &&
    html`<div class="toast" role="status" data-testid="toast"><span class="ok">${ICON.check}</span><span class="tx"><span>${tr.html('toast_switched', { name: s.toast.name })}</span><small>${tr.html('toast_reloaded', { tabs: tr.count('tabs', s.toast.tabs) })}</small></span></div>`;

  return html`
    ${header(tr, s, 'main')}
    <nav class="tabs slide" data-slide="tabs" style="--n:${PLATFORM_ORDER.length};--i:${PLATFORM_ORDER.indexOf(p)}" role="tablist" aria-label="${tr.text('tabs_aria')}"><span class="thumb" aria-hidden="true"></span>${tabs}</nav>
    <section class="body" data-panel>${parts}</section>
    ${toast}
    ${footer(tr)}`;
}

/** Optional page metadata is text; avatars may only use locally validated raster bytes. */
function fillProfile(root: Element, rawProfile: AccountProfile | undefined): void {
  const profile = sanitizeProfile(rawProfile);
  const details = root.querySelector<HTMLElement>('.profile-details');
  if (details) {
    details.textContent = [profile?.handle, profile?.email].filter(Boolean).join(' · ');
    details.title = details.textContent;
  }
  const avatar = root.querySelector('.avatar');
  if (avatar && profile?.avatar) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = profile.avatar;
    img.addEventListener('error', () => img.remove(), { once: true });
    avatar.prepend(img);
  }
}

/** Draws the whole popup into `root`. Call it again with the next state; it replaces everything. */
export function renderPopup(root: HTMLElement, state: PopupState, tr: Translator): void {
  root.dataset.platform = state.platform;
  root.dataset.state = screenOf(state);
  const body =
    state.page === 'loading'
      ? loadingBody(tr, state)
      : state.page === 'locked' || state.page === 'setup'
        ? lockedBody(tr, state)
        : state.page === 'settings'
          ? settingsBody(tr, state)
          : mainBody(tr, state);
  // A field the person is typing in keeps its caret and selection when the screen is drawn again under them
  // (a recovery redraw while a password is half typed).
  const typing = document.activeElement;
  const kept =
    typing instanceof HTMLInputElement && root.contains(typing) && typing.id
      ? {
          id: typing.id,
          value: typing.value,
          start: typing.selectionStart,
          end: typing.selectionEnd,
          direction: typing.selectionDirection ?? undefined,
        }
      : null;
  root.innerHTML = body.value;
  // Profile values never enter the markup builder: use text/value/src properties only.
  for (const row of root.querySelectorAll<HTMLElement>('li[data-id]')) {
    const account = state.platforms[state.platform].accounts.find((a) => a.id === row.dataset.id);
    if (!account) continue;
    const name = row.querySelector('.nm');
    if (name) name.textContent = account.label;
    fillProfile(row, account.profile);
  }
  if (state.adding?.kind === 'form') {
    const input = root.querySelector<HTMLInputElement>('#add-input');
    if (input) input.value = state.adding.value;
    const preview = root.querySelector<HTMLElement>('[data-profile-preview]');
    if (preview) {
      preview.hidden = !state.adding.profile;
      const initials = preview.querySelector('.avatar');
      if (initials) initials.textContent = initialsOf(state.adding.value);
      fillProfile(preview, state.adding.profile);
    }
  }
  // stale state (the extension did not answer and nothing could be read): nothing may write until a load works
  if (state.stale) {
    for (const el of root.querySelectorAll<HTMLButtonElement>(
      'button[data-act], button[data-pref]',
    )) {
      if (el.dataset.pref || WRITE_ACTIONS.has(el.dataset.act ?? '')) el.disabled = true;
    }
  }
  // The password goes in as a property, never as an attribute: it must not show in the markup (outerHTML).
  const pw = root.querySelector<HTMLInputElement>('#pw-input');
  if (pw) pw.value = state.lock.password;
  const again = kept ? root.querySelector<HTMLInputElement>(`#${CSS.escape(kept.id)}`) : null;
  if (kept && again && again.value === kept.value && kept.start !== null && kept.end !== null) {
    again.focus();
    again.setSelectionRange(kept.start, kept.end, kept.direction);
    return;
  }
  const target = root.querySelector<HTMLInputElement>('[data-autofocus]');
  if (target) {
    target.focus();
    if (target.id === 'pw-input')
      target.setSelectionRange(target.value.length, target.value.length);
    else target.select();
  }
}

/** Moves the "Saving… / Applying…" text and bars to the next step without redrawing, so the spinner keeps turning. */
export function patchSwitchStep(root: HTMLElement, state: PopupState, tr: Translator): void {
  if (!state.switching) return;
  const rowEl = root.querySelector('.row.busy');
  if (!rowEl) return;
  const { step } = state.switching;
  const sub = rowEl.querySelector('.sub');
  if (sub) sub.textContent = stepLabel(tr, state, step);
  rowEl.querySelectorAll('.steps i').forEach((bar, i) => {
    bar.classList.toggle('done', i <= step);
  });
}

/**
 * Updates the hint lines and the password box after typing cleared an error, without redrawing the page:
 * a redraw would move the caret out of the field.
 */
export function patchHints(root: HTMLElement, state: PopupState, tr: Translator): void {
  const setHint = (testId: string, bad: boolean, ok: MessageKey, badKey: MessageKey): void => {
    const el = root.querySelector(`[data-testid="${testId}"]`);
    if (!el) return;
    el.classList.toggle('bad', bad);
    el.innerHTML = tr.html(bad ? badKey : ok).value;
  };
  if (state.editing) setHint('rename-hint', state.editing.bad, 'rename_hint', 'rename_bad');
  if (state.adding?.kind === 'form')
    setHint('add-hint', state.adding.bad, 'add_hint', 'rename_bad');
  if (state.page === 'locked' || state.page === 'setup') {
    setHint('pw-hint', state.lock.bad, 'lock_hint', lockHint(state));
    root.querySelector('.pw')?.classList.toggle('bad', state.lock.bad);
  }
}
