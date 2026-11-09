// Time limits shared by the service worker and the popup, so the popup's deadlines can be checked against
// what the worker itself waits for (tests/unit/popup-bridge.test.ts).

/** How long a switch waits for the first reloaded tab before it checks the cookies anyway (worker). */
export const TAB_LOAD_TIMEOUT_MS = 15_000;

/**
 * Extra time the popup gives the worker on top of its own longest wait. The popup's deadlines are the popup's own
 * limit on waiting, not a bound on the worker: a switch also reloads tabs, checks cookies and (YouTube) verifies the
 * account, and none of that is capped by one overall timeout. The popup deadline covers the tab-load wait; whatever
 * the worker still does after it is an unknown outcome for the popup, which reads the state and says so.
 */
export const POPUP_MARGIN_MS = 5_000;

/** Popup deadlines per request. A read (state.get, probe, tab count) is quick; a write may touch storage and crypto. */
export const READ_DEADLINE_MS = 5_000;
export const WRITE_DEADLINE_MS = 10_000;
/** account.switch: the worker's tab-load wait plus the margin. It is not a limit on the rest of the switch. */
export const SWITCH_DEADLINE_MS = TAB_LOAD_TIMEOUT_MS + POPUP_MARGIN_MS;
