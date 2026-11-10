// Every error the worker can answer with has a message the user can read; the popup never shows a raw
// code. `Record<ErrorKey, MessageKey>` is the check: add a code to ERROR_CODES (src/lib/messages.ts) and
// this file stops compiling until the code has a message here, and the catalogs until it has text.
import type { MessageKey } from './i18n';
import type { ErrorKey } from './state';

export const ERROR_TEXT: Record<ErrorKey, MessageKey> = {
  bad_request: 'err_bad_request',
  forbidden: 'err_forbidden',
  internal: 'err_internal',
  store_unreadable: 'err_store_unreadable',
  not_found: 'err_not_found',
  invalid_label: 'err_invalid_label',
  invalid_setting: 'err_invalid_setting',
  duplicate: 'err_duplicate',
  no_vault: 'err_no_vault',
  vault_exists: 'err_vault_exists',
  locked: 'err_locked',
  wrong_password: 'lock_bad',
  too_many_attempts: 'err_too_many_attempts',
  too_short: 'err_too_short',
  too_simple: 'err_too_simple',
  unsupported_vault: 'err_unsupported_vault',
  busy: 'err_busy',
  expired: 'err_expired',
  checkpoint: 'err_checkpoint',
  unsaved_current: 'err_unsaved_current',
  wrong_account: 'err_wrong_account',
  not_logged_in: 'err_not_logged_in',
  no_youtube_tab: 'err_no_youtube_tab',
  not_signed_in: 'err_not_signed_in',
  invalid_session: 'err_invalid_session',
  invalid_tab: 'err_invalid_tab',
  api_error: 'err_api_error',
  tiktok_permission: 'err_tiktok_permission',
  tiktok_disabled: 'err_unknown',
  no_tiktok_tab: 'err_no_tiktok_tab',
  tiktok_probe_unavailable: 'err_tiktok_probe_unavailable',
  rollback_failed: 'err_rollback_failed',
  unknown: 'err_unknown',
  timeout: 'err_timeout',
  timeoutStale: 'err_timeoutStale',
  timeoutPassword: 'err_timeoutPassword',
};
