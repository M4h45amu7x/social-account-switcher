# Spec: Chrome extension to switch Facebook / Instagram / YouTube accounts

> Status: design v2 (cards t-504 and t-513). The extension code is being built in cards B1 to B7 (section 8.4).
> Clickable mockup: `mockup/popup.html` · screenshots of every state, in both languages and both themes: `mockup/shots/` · GIFs: `mockup/media/` · e2e: `mockup/e2e/` (how to run it and the variables it needs: `mockup/README.md`)
> Everything in this repository is written in English. Thai exists only as a UI language (section 10).

30-second summary
- FB / IG: switching swaps the session cookies of that site (device cookies stay). Sessions are stored on the device, encrypted with a master password of at least 10 characters.
- YouTube: no cookie swap. It uses Google's own multi-account feature (`authuser` / `pageid`), because the login cookies live on google.com and swapping them would also change the account in Gmail.
- Permissions: `cookies`, `storage`, `scripting`, plus three host patterns (no google.com). No server, nothing leaves the device, no website password is stored.
- UI: English and Thai (more can be added), theme System / Light / Dark, and small animations built on the View Transitions API (sections 10, 11, 12). No UI library, no runtime dependency.
- Build: Bun, Vite, TypeScript strict, Biome, `bun test` + Playwright, GitHub Actions, a zip for the Web Store, newest version of every dependency. Seven cards (section 8.4).

---

## 1. Goals and scope

Goal: someone with several Facebook, Instagram or YouTube accounts switches between them in one click from a popup, without logging out and back in. All data stays on the user's machine.

| In scope (v1) | Out of scope |
|---|---|
| 3 platforms: Facebook, Instagram, YouTube, one tab each | Other platforms (TikTok, X, Messenger.com, Threads) |
| The user logs in by hand, then presses "Add the account I'm logged in to" | Storing passwords, auto-filling logins, getting past 2FA |
| Switch, rename, remove, refresh an expired session | Fetching profile pictures or real names from the platform (we use the name the user types, plus initials) |
| Lock the data with a master password (WebCrypto) | A server, sync between machines, analytics, sending data off the device |
| UI in English and Thai, 360 px wide popup, light and dark theme, short animations | Several accounts open side by side in different tabs (that is what Chrome Profiles are for) |
| Manifest V3 | Export / import (later, because it amounts to moving passwords around) |

A limit worth knowing: **one browser can be on only one account per platform at a time**. Cookies belong to the whole Chrome profile, so after a switch every tab of that platform changes (the extension reloads them).

---

## 2. User flow

### 2.1 Add an account
1. The user opens facebook.com / instagram.com / youtube.com and logs in as usual, 2FA included.
2. They open the popup, stay on that platform's tab and press "Add the account I'm logged in to".
3. The extension checks for a real session (FB: `c_user`, IG: `ds_user_id`, YT: the Google session index). If this account is already in the list it says so and offers to update the session instead.
4. A name field opens inline (default such as "Facebook 3"). The user saves.
5. The first time an FB/IG account is saved, the user sets the master password (section 6). The new account becomes the active one.

### 2.2 Switch
1. Open the popup, pick the platform, press the row of the target account.
2. If the data is locked (FB/IG), the master password comes first.
3. The row shows progress in steps (save the current session, apply the new one, reload N tabs). The other controls of that platform are disabled so nothing can be pressed twice.
4. On success a toast says "Switched to '…'" with "Reloaded N tabs", and the "Active" badge moves to the new row.
5. On failure an error bar stays on screen with a way forward (2.5).

### 2.3 Rename
Press the pencil. The name becomes an input in the same row. Enter or Save keeps it, Esc or Cancel drops it. An empty name is refused, 40 characters at most. Only the local name changes; nothing is sent to the platform.

### 2.4 Remove
Press the trash can. The row turns into a red confirmation box inside the popup: "Remove '…' from the list? The saved session is erased from this device. Your account on the platform is not deleted." with [Cancel] [Delete].
**Never use the browser's `alert` / `confirm`.** Removing the active account is allowed; it only deletes the local copy and does not log the user out.

### 2.5 Not logged in, or the session is unusable
- No accounts yet: an empty page with three steps (open the site, log in yourself, press Add) and an "Open facebook.com" button.
- Add pressed while not logged in: an inline message: "No Facebook login found. Open facebook.com, log in in that tab, then press Add again."
- The session expired, or the server logged it out, after a switch: an error bar, "The session for '…' has expired", with [Open login page] [Update session]. The user logs in to that account by hand and presses "Update session" to store the new session over the old one. The row carries a "Log in again" badge until then.
- The current session is not saved: before switching, an inline warning: "The account you're using now isn't saved. If you switch, you'll be logged out of it." with [Save first] [Switch anyway].
- After "Forgot password?": any earlier "wrong password" message disappears when the wipe confirmation opens (it would be stale there).

### 2.6 Settings
The gear icon in the popup header opens a Settings page (it slides in, section 12). It holds four things: Theme (System / Light / Dark), Language (Auto / English / ไทย), Lock now, and Wipe all data (an inline confirmation, then every saved session and shortcut is deleted). Settings are described in sections 10 and 11.

---

## 3. How switching works (per platform)

### 3.0 The core shared by FB and IG (cookie swap)

```
switch(platform, targetId):
  0. Take the busy lock for this platform (blocks double presses).
  1. snapshot = cookies.getAll({ domain }), keep only the "session cookies" (not device cookies).
  2. Encrypt the snapshot and write the journal { platform, fromId, toId, backup } to storage.session.
     (The journal is written AFTER the snapshot, because the backup is the snapshot.)
  3. If the snapshot belongs to an account in the list, save it over the stored one (the latest session wins).
  4. Remove every session cookie of that domain (cookies.remove one by one, with a url built from secure + domain + path).
  5. Decrypt the target account's cookies and cookies.set them one by one.
     (A host-only cookie must not get a domain field; cookies whose expirationDate has passed are skipped.)
  6. tabs.query({ url: host pattern }) and tabs.reload on every tab.
  7. Verify: wait for the first tab to finish loading, then read the identity cookie again.
     It matches targetId: success. Missing or someone else: mark the account expired, put the backup back, report an error.
  8. Delete the journal and release the busy lock.
  If the service worker dies halfway (MV3 may stop it at any time): on wake-up, a leftover journal means "put the backup back".
```

Why device cookies are not swapped: platforms use cookies such as `datr` and `mid` to remember "this machine has been seen before". If they changed on every switch, each switch would look like a login from a new machine and checkpoints would appear more often. So the rule is "keep every cookie except the device-cookie list" (a denylist) instead of naming the session cookies. Session cookie names can change without notice; device cookies change much less.

The extension makes no network calls of its own. Verification reads cookies after the tab reloads. It never sends a request to the platform.

### 3.1 Facebook

| Topic | Detail |
|---|---|
| Domain | `.facebook.com` (including `www.`, `web.`, `m.`), host pattern `*://*.facebook.com/*` |
| Identity cookie | `c_user` = user ID (used to match accounts) |
| Main session cookies | `c_user`, `xs` (the key one, httpOnly), `fr`, `presence`, `spin`, `usida` and so on. Every cookie not on the denylist is kept. |
| Device cookies (not swapped) | `datr`, `sb`, `locale`, `wd`, `dpr` |
| Built-in switching | Facebook can switch between pages or profiles tied to one account (no extension needed for that) and keeps "remembered accounts" on the login page. Separate personal accounts usually need the password again and a logout first. |
| Why the extension still helps | It switches truly separate personal accounts in one click, with no logout (a Facebook logout destroys the stored session too) and no password or 2FA typing. |

Watch out: messenger.com uses separate cookies (out of scope; a Messenger tab left open stays on the old account). Do not press "Log out" on facebook.com if you want to keep the stored session (the empty page and a tooltip say so).

### 3.2 Instagram

| Topic | Detail |
|---|---|
| Domain | `.instagram.com`, host pattern `*://*.instagram.com/*` |
| Identity cookie | `ds_user_id` = user ID |
| Main session cookies | `sessionid` (the key one, httpOnly), `ds_user_id`, `csrftoken`, `rur`, `shbid`, `shbts` |
| Device cookies (not swapped) | `mid`, `ig_did`, `ig_nrcb`, `datr` |
| Built-in switching | The Instagram web app can switch accounts and hold several. Accounts linked in Accounts Center switch without a password. Unlinked ones usually need a fresh login, and remembered accounts on the web drop out more often than in the app. |
| Why the extension still helps | It switches accounts you do not want to link in Accounts Center (for example client accounts that must stay separate) in one click, with the same UI as FB and YT. |

Watch out: a `csrftoken` that does not match the `sessionid` breaks the first request, so the two must always be swapped together (the denylist already guarantees it).

### 3.3 YouTube. Decision: use Google multi-login, do not swap cookies

Why swapping cookies fails on YouTube: a YouTube login is a Google login. The main cookies (`SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, `__Secure-1PSID`, `__Secure-3PSID`, `__Secure-1PSIDTS` and others) live on `.google.com` and on `accounts.google.com` (`LSID`, `__Host-GAPS`). YouTube gets a second copy on `.youtube.com` (including `LOGIN_INFO`).

| | A) cookie swap like FB/IG | B) Google multi-login (chosen) |
|---|---|---|
| Permission | Needs `*.google.com` + `*.youtube.com` (+ `accounts.google.com`) | Only `*.youtube.com` |
| Effect on other services | Yes. Open Gmail, Drive, Calendar or Meet tabs change account or get logged out. | None. Google does the switching, and every account is already logged in together. |
| Stability | Low. Chrome binds Google sessions to the device (Device Bound Session Credentials, and `__Secure-1PSIDTS` keeps rotating), so stored cookies go stale fast, and Google detects replayed cookies and forces a new login. | High. It is an official Google feature. |
| Security risk | We would store cookies for the whole Google account (equal to the Gmail password) on disk. | We store no Google secret at all. |
| Limit | None | Every account must stay logged in inside one browser profile (up to about 10). The first account (authuser=0) remains the default for other Google services. |

Why B: with A, changing the YouTube channel would also change the Gmail account the user is working in, which they do not expect and which can be dangerous. It needs the broadest cookie permission we could ask for, and it breaks easily because of DBSC. B gives the same result in one click, holds no secret and asks for less.

How B works:
- Add: the user chooses the account or channel on YouTube themselves (profile menu, Switch account), then presses "Add". The extension reads the page's `ytcfg` (`SESSION_INDEX` = authuser, `DELEGATED_SESSION_ID` = the pageid of a Brand Account or channel) with `scripting.executeScript({ world: 'MAIN' })` on an open youtube.com tab, and stores just those two numbers plus the name the user gave.
- Switch: point the active YouTube tab (or a new one if there is none) at
  `https://www.youtube.com/signin?action_handle_signin=true&authuser=<N>&pageid=<P>&next=<original path>`
  (drop `pageid` for a personal account), then reload the other YouTube tabs. A tab that was closed in the meantime is skipped; the switch still counts, and `reloadedTabs` is the number that reloaded.
- `next` is the tab's path, query and fragment. It becomes `/` when it is longer than 2,048 characters, when it is not a plain path (`//`, `\`, control characters), or when it is still percent-encoded after 3 rounds of decoding. The cost stays linear whatever a web page puts in the URL.
- Waiting for the load: verify reads only the page that the switch's own navigation loaded. Chrome puts `url` in `tabs.onUpdated` only when the committed URL differs from the last one it reported, and never for a host the extension has no permission for (Google's login page), so URLs can't identify the navigation. The anchor is the moment `tabs.update()`/`create()` resolves (before the navigation commits, with `pendingUrl` set): the first loading → complete of that tab after it is the switch's navigation. If a visible URL on another path shows up in between (the user clicked a link), the wait goes on until its 15-second timeout and ends in `api_error`. A `complete` with no loading after the anchor belongs to the old page and is ignored. Only the path is compared, because YouTube may add query parameters on the way back. Checked in Chromium against a local server with real 302s (`tests/e2e/youtube-nav.spec.ts`).
- Verify: read `ytcfg` again after loading. If the tab is no longer visibly on YouTube (Google's login page shows up as a hidden URL), or authuser or pageid do not match, that account has dropped out of Google: `not_signed_in`, and the error says "Google account N isn't logged in. Add it in Google first."
- Edge case: if the user logs one Google account out, the authuser numbers of the others shift. We cannot keep a masked email to detect that (we pull no personal data), so we verify after each switch and, on a mismatch, ask the user to press "Update" again. The exact `signin?…pageid` URL must be confirmed once more when the code is written (manual check 24 in 8.3).

### 3.4 Edge cases (every platform that swaps cookies)

| Case | Symptom | Handling |
|---|---|---|
| Session expired | The stored cookie's `expirationDate` has passed, or the platform deletes the cookie on load | Check expiry before switching. If it has passed, do not try; report the error right away. After loading, verify (step 7). |
| Logged out on the server | Password change, "log out of all devices", logout on the web | The cookies go in but the server rejects them. Step 7 catches it, the account gets "Log in again", and the previous account's backup is put back. The user is not logged out of either. |
| 2FA / checkpoint | After a switch the platform sends the user to a checkpoint or identity check | Count the switch as done, but the user must finish it ("The platform wants to verify you. Finish it in the tab, then press Update session."). We never try to get past it. |
| Many tabs open | An old tab holds the previous account's state (a draft post, for example) | Reload every tab of that domain. If more than one tab is open, the popup says "Reloading 3 tabs" beforehand. A tab in the middle of typing cannot be detected reliably, so a draft may be lost, and the FAQ says so. |
| Double press / two platforms at once | Race | One lock per platform (FB and IG can switch at the same time because their domains do not overlap). |
| Service worker stopped midway | Half-applied cookies | Journal in `storage.session`. On the next start the backup is put back. |
| Incognito | Separate cookie store | Not supported in v1 (`incognito: "not_allowed"`). |
| Partitioned cookies (CHIPS) | `getAll` leaves them out unless a partitionKey is given | Use `getAll({ domain, partitionKey: {} })` to get every partition (the reason for `minimum_chrome_version`; the behaviour of `{}` must be proven in card B2), and keep the partitionKey when setting. |

> **Result of card B2 (Chromium 158 via Playwright, `tests/e2e/cookies.spec.ts`):** `getAll({ domain, partitionKey: {} })` returns unpartitioned and partitioned cookies in one call, so the two-call fallback isn't needed. `remove()` needs the cookie's `partitionKey`: without it Chrome resolves anyway and the partitioned cookie stays. Chrome 130+ also reports `partitionKey.hasCrossSiteAncestor`, which is saved and set back unchanged. Versions between the minimum (119) and the one Playwright ships were not tested; the spec checks this again on every e2e run.

---

## 4. Permissions

```json
{
  "manifest_version": 3,
  "name": "__MSG_extName__",
  "short_name": "__MSG_extShortName__",
  "description": "__MSG_extDescription__",
  "version": "<from package.json at build time>",
  "default_locale": "en",
  "minimum_chrome_version": "119",
  "action": {
    "default_popup": "popup/index.html",
    "default_title": "__MSG_actionTitle__",
    "default_icon": { "16": "icons/16.png", "32": "icons/32.png" }
  },
  "background": { "service_worker": "service-worker.js", "type": "module" },
  "icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" },
  "permissions": ["cookies", "storage", "scripting"],
  "host_permissions": [
    "*://*.facebook.com/*",
    "*://*.instagram.com/*",
    "*://*.youtube.com/*"
  ],
  "incognito": "not_allowed"
}
```
This is what card B1 built (`src/manifest.json`). The strings come from `public/_locales/{en,th}/messages.json` through `__MSG_…__` (section 10). `version` is written into `dist/manifest.json` by a small Vite plugin. There is no `content_security_policy` entry: the MV3 default already forbids remote scripts and `eval`.

`minimum_chrome_version` is 119 in B1. Card B2 must confirm it against the real behaviour of `cookies.getAll({ partitionKey: {} })`, and raise it if that needs a newer Chrome. The popup's motion code (section 12) uses View Transitions, which Chrome has had since 111, so 119 is enough; `view-transition-class` (Chrome 125) is an enhancement, not a requirement.

| Permission | What it is for | Why it is needed |
|---|---|---|
| `cookies` | Read / remove / set the FB and IG cookies | The heart of switching. It can only reach the domains in host_permissions. |
| `storage` | `storage.local` holds the account list, settings and the encrypted data (never the key). `storage.session` (memory) holds the unlocked key (raw, base64) and the journal. | There is nowhere else to keep them. `storage.sync` is not used: it would upload to Google's cloud, which breaks "data stays on the device". |
| `scripting` | Read `ytcfg` (authuser / pageid) on a YouTube page | YouTube only. No permanent content script. |
| host `*.facebook.com`, `*.instagram.com` | Lets `cookies` reach the domain, and lets `tabs.query({url})` find tabs to reload | Limited to those two domains. |
| host `*.youtube.com` | `scripting`, and finding or navigating YouTube tabs | `*.google.com` is not requested, because we chose B. |

Deliberately not requested: `tabs` (host_permissions are enough to query tabs of the three domains), `<all_urls>`, `webRequest`, `alarms`, `identity`, `unlimitedStorage`, `storage.sync`. No remote code, no `externally_connectable`. Theme, language and animation need no permission.

---

## 5. Data model

`chrome.storage.local` (on disk)

```ts
type Platform = 'facebook' | 'instagram' | 'youtube';
type ThemePref = 'system' | 'light' | 'dark';
type LanguagePref = 'auto' | 'en' | 'th';

interface StoreV1 {
  schemaVersion: 1;
  accounts: Account[];                       // metadata, not secret, shown even while locked
  active: Record<Platform, string | null>;   // accountId currently in use
  vault: Vault | null;                       // null = no master password yet / no FB or IG account yet
  settings: Settings;                        // not secret, readable while locked (sections 10 and 11)
  quarantine?: unknown[];                    // accounts that failed validation on load, kept as they were
}

interface Settings {
  theme: ThemePref;          // default 'system'
  language: LanguagePref;    // default 'auto'
}

interface Account {
  id: string;                 // the extension's own uuid
  platform: Platform;
  label: string;              // the name the user chose, 1 to 40 characters
  initials: string;           // computed from label, shown in the circle
  platformUserId?: string;    // FB c_user / IG ds_user_id (used to match and to stop duplicates)
  youtube?: { authuser: number; pageid?: string };   // YouTube only, no cookies
  status: 'ok' | 'expired' | 'checkpoint';
  createdAt: number;
  lastUsedAt: number | null;
  sessionCapturedAt: number | null;
}

interface Vault {             // one encrypted blob
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number /* 600000 today */; salt: string /*b64 16B*/ };
  iv: string;                 // b64 12B, new random value on every write
  ciphertext: string;         // AES-GCM( JSON<SessionMap> )
  check: string;              // AES-GCM of a constant, to tell a wrong password from a right one without decrypting the whole blob
}
```

`settings` is created with its defaults the first time the store is read. It is plain data: no migration is needed because v1 has not shipped. An unknown value in `theme` or `language` is treated as the default.

Loading checks every account. One that is malformed (wrong platform, bad label, missing user ID, a second copy of an ID) does not stop the rest from loading: it moves to `quarantine` unchanged, and the next save keeps it there, so nothing is deleted without the user knowing. `state.get` reports how many there are. A vault that is present but malformed makes the whole load fail instead, because replacing it would destroy the saved sessions. `unlock` derives with the `iterations` stored in the vault, so a later version can raise the count without breaking old vaults; a count below 600,000 or above 10,000,000, or another hash, is refused as `unsupported_vault`.

Inside the vault (after decryption)

```ts
type SessionMap = Record<string /*accountId*/, {
  capturedAt: number;
  cookies: Array<{
    name: string; value: string; domain: string; path: string;
    hostOnly: boolean; secure: boolean; httpOnly: boolean;
    sameSite: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
    expirationDate?: number;  // missing = session cookie
    partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean };  // the flag exists from Chrome 130; kept as Chrome reports it so the cookie goes back into the same partition
  }>;
}>;
```

`chrome.storage.session` (browser memory, not written to disk, gone when Chrome closes or when the extension is reloaded, updated or disabled, values must be JSON)

```ts
interface SessionArea {
  vaultKey?: string;          // raw AES-256 key as base64 (32 bytes). Present = unlocked.
  // One journal per platform, so Facebook and Instagram can switch at the same time.
  'journal.facebook'?: Journal;
  'journal.instagram'?: Journal;
  unlockFailures?: { count: number; lastAt: number };   // wrong master passwords since the last unlock (section 6, point 5)
}

interface Journal {
  platform: 'facebook' | 'instagram';
  fromId: string | null;      // the saved account the browser was on, if any
  toId: string;
  backup: string;             // sealCookies(): IV + AES-GCM of the cookies from before the switch
  startedAt: number;
}
```
- The access level stays `TRUSTED_CONTEXTS` (the default: content scripts cannot read it), and the service worker calls `setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` again at start so nobody changes it.
- **The key never goes into `storage.local`, IndexedDB or any file on disk.** `storage.session` is the only place.
- The journal `backup` is encrypted with the same key (the journal never holds plain cookies).

`localStorage` of the popup page (a cache, not a store). One key, `theme`, mirrors `settings.theme` so `public/theme-boot.js` can read it synchronously before the first paint (section 11). `storage.local` stays the source of truth. If they disagree when the popup loads, `storage.local` wins and the cache is rewritten. It holds nothing secret and the extension works if it is empty or cleared.

---

## 6. Security

Reasoning: FB/IG session cookies are worth as much as the password plus 2FA. Whoever gets them can use the account at once. Our copy in `storage.local` (a plain LevelDB file) is weaker than the cookie Chrome keeps itself (Chrome encrypts that with the system keyring), so **encryption is mandatory**.

Proposed design: master password + WebCrypto
1. The first time an FB/IG account is added, the user sets a master password of at least 10 characters (a phrase of four or more words is recommended, for example "orange cat river lunch bell"). There is **no PIN option**; the reason is in the numbers table below. The field has a show/hide button. We do not check against a list of popular passwords (that needs a dependency or a big list), but we refuse a password that is one repeated character or a run of digits.
2. `PBKDF2(password, random 16 B salt, 600,000 rounds, SHA-256)`, then `deriveKey` into an AES-GCM 256-bit key, extractable (used once at unlock, to export it).
3. All sessions are encrypted as one blob (`Vault`) with a 12 B iv that is new on every write.
4. Key life cycle (an MV3 service worker is stopped when idle, so variables inside it can vanish at any time):
   - Unlock: derive (extractable), `exportKey('raw')`, base64, store in `storage.session.vaultKey`, then drop the extractable key straight away.
   - Use (every time the worker needs to decrypt or encrypt): read `vaultKey`, `importKey('raw', …, extractable: false, ['encrypt','decrypt'])` to get a non-extractable `CryptoKey`, used in the worker's memory (it may be cached in a variable until the worker is stopped).
   - Lock: delete `vaultKey` and clear the cache. Closing Chrome wipes `storage.session`, so that locks it automatically.
   - Result: one unlock lasts until Chrome closes, the extension is reloaded, updated or disabled, or the user presses Lock now, even if the worker is stopped and woken many times.
5. After 5 wrong passwords there is a 30-second delay per attempt. To be straight about it: **this delay lives inside the extension, so it only stops someone guessing at the keyboard. It does nothing against offline guessing on a stolen copy of `storage.local`.** The only things that slow offline guessing are the password length and the PBKDF2 round count.

YouTube holds no secret (only authuser / pageid), so switching it needs no unlock.

Offline guessing numbers (if the file is stolen)

Assumption: hashcat mode 10900 (PBKDF2-HMAC-SHA256) on a GTX 1080 Ti (a 2017 card) is about 1.47 MH/s at 999 rounds (source: published hashcat benchmarks for the 1080 Ti, for example techearl.com/hashcat-benchmarks-nvidia-geforce-gtx-1080-ti). At 600,000 rounds that is about 2,450 guesses per second per card. A real attacker may have newer or several cards, so the table adds a case that is 10 times faster (about 24,500 per second). The times are for trying every candidate; on average the password is found after half of that.

| Password | Candidates | One 1080 Ti | 10 times faster |
|---|---|---|---|
| 6-digit PIN | 10^6 | about 7 minutes (408 s) | about 41 s |
| Word list / popular passwords | about 10^9 | about 4.7 days | about 11 hours |
| 10 random characters, a to z only | 26^10 ≈ 1.4×10^14 | about 1,800 years | about 180 years |
| 10 random characters, a to z and 0 to 9 | 36^10 ≈ 3.7×10^15 | about 47,000 years | about 4,700 years |
| 4 random words from a 7,776-word list | 7776^4 ≈ 3.7×10^15 | about 47,000 years | about 4,700 years |

(Calculation: candidates ÷ guesses per second, for example `10^6 / 2450 ≈ 408 s`.)

| Trade-off | Effect |
|---|---|
| Require 10+ characters instead of a PIN | A longer thing to type once a day (when Chrome starts). In return: a 6-digit PIN falls in minutes if the file leaks, which hands over the FB/IG accounts. |
| People rarely pick random passwords | The "years" above only hold for truly random passwords. A password made of words or common patterns lands on the "about 10^9" row (hours to days). So the UI recommends a multi-word phrase, and README and PRIVACY say this plainly. |
| Forgotten master password | It cannot be recovered (there is no server). Use "Wipe all data", then log in and add the accounts again. The accounts on the platforms are fine; they only need a new login. |
| The raw key sits in `storage.session` while unlocked | It lives in browser memory only (never on disk), and the extension's own contexts can read it. Accepted, because it is the only way "unlock once" works with a service worker that stops often. Malware that can read Chrome's memory can already steal Chrome's own cookies directly. |
| Metadata (account names) is not encrypted | The list shows even while locked, which is easier to use. A name the user chose is not secret at the level of a cookie. |
| Settings (theme, language) are not encrypted | They hold nothing sensitive and the lock screen needs them. |

Rules the real code must never break: no `fetch` / `XMLHttpRequest` to anywhere except what a web page loads itself · never log a cookie value to the console · the default extension CSP (no `unsafe-eval`, no external scripts, no fonts from the network) · no analytics. The popup also has no inline script or style attribute that needs `unsafe-inline`: the first-paint theme script is a separate file (section 11).

---

## 7. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Platform policy. Meta forbids automated access to its services and account sharing. | Medium | Account limited or suspended | The extension only puts back the user's own cookies, obtained by a manual login on the same machine. It sends no requests of its own. It says plainly that it is for your own accounts and not a tool for sharing accounts. |
| Chrome Web Store. An extension that handles cookies must explain privacy clearly. | Medium | Review fails | The privacy policy says "data stays on the device, nothing leaves", asks for the fewest permissions, and has no remote code. |
| Checkpoints / forced re-login | Medium to high (new accounts, frequent switching) | The user has to verify, which costs time | Device cookies are not swapped (denylist). No rapid cycling. A checkpoint is detected and reported, never bypassed. |
| Session revoked (password change, logout everywhere, logout on the web, expiry after about 90 days) | High over time | Switching fails, a new login is needed | Verify every time, put the backup back, and offer "Update session". The latest session is saved over the old one on every switch away (step 3), so it stays fresh. |
| The platform renames cookies or binds sessions to the device (DBSC) | Medium (Google already did, Meta may follow) | The swap mechanism stops working | The denylist copes with new names. YouTube does not swap anyway. Code is split per platform (`platforms/*.ts`) so one can be switched off alone. |
| Data leaks from the machine | Low | Accounts taken over | Mandatory encryption (section 6). |
| The user thinks other tabs still show the old account | Medium | A post goes out under the wrong account | Reload every tab, a toast names the new account, and an initials badge on the extension icon (v1.1). |
| A motion or theme bug makes the popup unusable | Low | The user cannot switch | Animation is an enhancement: with no support, or with reduced motion, the DOM just changes (section 12). Theme falls back to System. Neither blocks any action. |

---

## 8. Real file layout, module contracts, tests and cards

> The user builds this for real right after QC passes and will publish it to a git repo. This section and section 9 must be enough to build from without making new decisions. Card B1 (t-512) has already built the skeleton; names below match it.

### 8.1 File layout (new repo, suggested name `social-account-switcher`)

```
social-account-switcher/
├─ src/
│  ├─ manifest.json            # written by hand (section 4); version is overwritten from package.json at build
│  ├─ background/
│  │  ├─ service-worker.ts     # entry: register onMessage, onStartup → recoverJournal()
│  │  ├─ chrome-adapter.ts     # one of the TWO files allowed to touch the `chrome` global
│  │  ├─ router.ts             # checks sender and shape of every message, answers with a Result
│  │  ├─ store-access.ts       # serialized read-modify-write of the store (editStore / patchStore)
│  │  ├─ switcher.ts           # switchAccount(), steps 0 to 8 of 3.0, a lock per platform
│  │  ├─ journal.ts            # write / clear / recover in storage.session
│  │  ├─ keyring.ts            # key in storage.session (export raw ↔ import non-extractable)
│  │  └─ platforms/
│  │     ├─ index.ts           # COOKIE_PLATFORMS: facebook + instagram
│  │     ├─ types.ts           # interfaces CookiePlatform / YoutubePlatform
│  │     ├─ facebook.ts
│  │     ├─ instagram.ts
│  │     └─ youtube.ts
│  ├─ lib/
│  │  ├─ ports.ts              # interfaces for every browser API we use (CookiesApi, LocalStorageApi, TabsApi, I18nApi, …)
│  │  ├─ cookies.ts            # snapshot / clear / restore, no state
│  │  ├─ vault.ts              # PBKDF2 + AES-GCM
│  │  ├─ store.ts              # schema v1, migrate(), account CRUD, settings
│  │  ├─ messages.ts           # popup ⇄ service worker message types (discriminated union)
│  │  ├─ mutex.ts              # runs async jobs one at a time (store writes)
│  │  └─ result.ts             # type Result<T, E>, never throw across a message boundary
│  └─ popup/
│     ├─ index.html  popup.css # taken from mockup/popup.html (same CSS tokens, theme tokens and motion tokens)
│     ├─ main.ts               # mounts the popup, asks the worker for state.get and sends every effect through bridge.ts (B5b)
│     ├─ app.ts                # glue: state ⇄ reducer ⇄ DOM, wraps each redraw in a view transition
│     ├─ controller.ts         # pure reducer (state, action) → next state + motion mode + effects for the worker
│     ├─ state.ts              # the popup's own view types (PopupState, AccountView) and screenOf()
│     ├─ view.ts               # pure render functions (state → DOM), testable with happy-dom
│     ├─ html.ts               # escaping html`` builder: the one place that decides what is markup
│     ├─ samples.ts            # sample data (the mockup's fake accounts) for tests and the e2e page only
│     ├─ e2e/                  # e2e page that opens the real code on a sample state (built only by tests/e2e/vite.e2e.config.ts)
│     ├─ runtime.ts            # the other file allowed to touch `chrome` (i18n + manifest version pass-throughs)
│     ├─ i18n.ts               # t(), language resolution, plural and [[bold]] helpers (section 10)
│     ├─ theme.ts              # apply / save the theme, keep the first-paint cache (section 11)
│     └─ motion.ts             # transition(mode, update), circleReveal(), reduced-motion check (section 12)
├─ public/
│  ├─ _locales/en/messages.json   _locales/th/messages.json   # the single source of every UI string
│  ├─ theme-boot.js                                            # 10 lines, classic script, applies the cached theme before first paint
│  └─ icons/16.png 32.png 48.png 128.png
├─ tests/
│  ├─ fakes/chrome.ts          # in-memory fake of chrome.cookies / storage / tabs / scripting / i18n
│  ├─ setup.ts                 # bun test preload (registers happy-dom for the view tests)
│  ├─ lint-fixtures/           # good and bad samples that prove the Biome guardrails still fire
│  ├─ unit/*.test.ts           # bun test (locales.test.ts already exists from B1)
│  └─ e2e/
│     ├─ fixtures.ts           # launchPersistentContext + --load-extension
│     ├─ fake-sites/server.ts  # https localhost imitating FB/IG (sets and checks cookies)
│     └─ *.spec.ts
├─ scripts/
│  ├─ zip.ts                   # builds the Web Store zip (9.7)
│  ├─ check-permissions.ts     # manifest must match the allow-list
│  ├─ permissions.ts           # the allow-list + checkManifest / checkPrivacyPolicy
│  └─ check-chrome-access.ts   # second guard: `chrome` may appear only in the two adapter files (chrome-access.ts holds the logic)
├─ .github/workflows/ci.yml  release.yml   .github/dependabot.yml
├─ docs/design.md  docs/store-listing.md
├─ README.md  PRIVACY.md  LICENSE  CHANGELOG.md  SECURITY.md
├─ package.json  bun.lock  bunfig.toml  tsconfig.json  vite.config.ts  playwright.config.ts
├─ biome.json  .editorconfig  .gitignore
```

### 8.2 Module contracts (write it this way)

```ts
// lib/result.ts
export type Result<T, E extends string = string> = { ok: true; value: T } | { ok: false; error: E };

// lib/ports.ts: every browser API the logic needs, as an interface.
// Every async method is typed as returning a Promise so Biome's noFloatingPromises can see a missing `await`.
export interface I18nApi {
  getMessage(key: string, substitutions?: string[]): string;
  getUILanguage(): string;            // chrome.i18n.getUILanguage()
}
// (SessionStorageApi, LifecycleApi exist from B1; B2 and later add CookiesApi, LocalStorageApi, TabsApi, ScriptingApi)

// background/platforms/types.ts
export interface CookiePlatform {
  id: 'facebook' | 'instagram';
  label: string;                         // 'Facebook'
  cookieDomain: string;                  // 'facebook.com'
  tabPatterns: string[];                 // ['*://*.facebook.com/*']
  idCookie: string;                      // 'c_user' | 'ds_user_id'
  deviceCookies: ReadonlySet<string>;    // the denylist from 3.1 / 3.2
  loginUrl: string;
  isCheckpointUrl(url: string): boolean; // /checkpoint/, /challenge/
}

// lib/cookies.ts: every function takes the cookies port as a parameter (injectable in tests)
export function snapshot(api: CookiesApi, p: CookiePlatform): Promise<StoredCookie[]>;
export function clear(api: CookiesApi, p: CookiePlatform): Promise<number>;        // returns how many were removed
export function restore(api: CookiesApi, cookies: StoredCookie[], now: number): Promise<Result<number, 'all_expired'>>;
export function currentUserId(api: CookiesApi, p: CookiePlatform): Promise<string | null>;

// lib/vault.ts: the working key is always non-extractable; the extractable one lives only inside unlock/createVault
export function validatePassword(pw: string): Result<void, 'too_short' | 'too_simple'>;   // ≥ 10 chars, not one repeated char or a run
export function createVault(pw: string, data: SessionMap): Promise<{ vault: Vault; rawKeyB64: string }>;
export function unlock(pw: string, vault: Vault): Promise<Result<string /* rawKeyB64 */, 'wrong_password'>>;
export function importSessionKey(rawKeyB64: string): Promise<CryptoKey>;  // importKey(raw, extractable=false)
export function readVault(key: CryptoKey, vault: Vault): Promise<SessionMap>;
export function writeVault(key: CryptoKey, vault: Vault, data: SessionMap): Promise<Vault>; // new iv every time

// background/keyring.ts: the only place that touches storage.session.vaultKey
export function storeKey(session: StorageArea, rawKeyB64: string): Promise<void>;
export function getKey(session: StorageArea): Promise<CryptoKey | null>;  // null = locked; cached in a variable until the worker stops
export function lock(session: StorageArea): Promise<void>;

// background/switcher.ts
export type SwitchError = 'locked' | 'busy' | 'expired' | 'checkpoint' | 'not_found' | 'unsaved_current';
export function switchAccount(deps: Deps, platform: Platform, accountId: string,
  opts?: { force?: boolean }): Promise<Result<{ reloadedTabs: number }, SwitchError>>;

// popup/i18n.ts (section 10)
export type MessageKey = keyof typeof import('../../public/_locales/en/messages.json');
export function resolveLanguage(pref: LanguagePref, uiLanguage: string): 'en' | 'th';
export function createTranslator(lang: 'en' | 'th'): Translator;   // text(key, params) · html(key, params) · count('tabs', n)
// both catalogs are imported at build time (resolveJsonModule), so a language picked in Settings works without a fetch

// popup/theme.ts (section 11)
export function applyTheme(root: HTMLElement, pref: ThemePref): void;      // sets or removes data-theme
export function writeThemeCache(cache: ThemeCache | null, pref: ThemePref): void;  // localStorage mirror under the key `theme`, for first paint
export function reconcileTheme(root: HTMLElement, cache: ThemeCache | null, stored: ThemePref): ThemePref;  // the stored setting wins

// popup/motion.ts (section 12)
export type MotionMode = 'theme' | 'tab' | 'list' | 'status' | 'expand' | 'page' | 'toast' | 'lang' | 'none';
export function runTransition(mode: MotionMode, update: () => void, opts?: { dir?: 1 | -1 }): ViewTransition | null;
export function circleReveal(x: number, y: number, update: () => void): ViewTransition | null;

// lib/messages.ts: the popup may send only these types, and the worker always answers with a Result
export type Request =
  | { type: 'state.get' }
  | { type: 'vault.unlock'; password: string } | { type: 'vault.lock' } | { type: 'vault.setup'; password: string }
  | { type: 'vault.wipe'; scope?: 'sessions' | 'all' }   // `all` (default) = "Wipe all data"; `sessions` = "Forgot password": the YouTube shortcuts stay (they hold no session). Both are confirmed inline in the popup
  | { type: 'settings.set'; theme?: ThemePref; language?: LanguagePref }
  | { type: 'account.probe'; platform: Platform }   // who is logged in now, saves nothing: { tail: string | null }
  | { type: 'account.addCurrent'; platform: Platform; label: string }
  | { type: 'account.updateSession'; accountId: string }
  | { type: 'account.rename'; accountId: string; label: string }
  | { type: 'account.remove'; accountId: string }
  | { type: 'account.switch'; accountId: string; force?: boolean };
```

Errors (B5b): every answer is a `Result<_, ErrorCode>`, and `ERROR_CODES` in `lib/messages.ts` lists every code the worker can answer with. The router's return type is that union, so a code that is not listed fails the typecheck. The popup maps each code to a message with `Record<ErrorKey, MessageKey>` (`popup/errors.ts`, `ErrorKey` = `ErrorCode | 'unknown'`), so a listed code without a message fails it too, and both catalogs need the text (`locales.test.ts`). The popup never shows a raw code. A code it does not know, an answer that is not a Result, or a port that cannot be reached all become `unknown`: a generic message with a "Try again" button, and the busy state is released. `popup/bridge.ts` holds the mapping effect → Request → action and receives its functions (`send`, `openTab`, `countTabs`, `later`), so it holds no `chrome`; `popup/runtime.ts` provides the real ones.

First run (B5b): with no vault the popup opens on a setup page (a master password, the same rule as the worker: 10 characters, no repeat or run). The popup warns before sending; the worker's `validatePassword` is the real check. After a wipe the popup returns to setup.

Code rules:
- Every function in `lib/` and `switcher.ts` takes its dependencies (the ports, `now()`, `crypto`) as parameters, so it can be tested without mocking globals.
- Only two files may use the `chrome` global: `src/background/chrome-adapter.ts` and `src/popup/runtime.ts`. They are thin pass-throughs. Biome (`noRestrictedGlobals`, section 9.5) and `scripts/check-chrome-access.ts` both enforce it.
- The worker checks `sender.id === chrome.runtime.id` and the shape of each message before acting. The popup never touches `chrome.cookies` directly.
- `window`, `self`, `globalThis`, `frames`, `parent` and `top` are banned in `src/` too, so the motion and theme code uses `document` and `matchMedia` directly.

### 8.3 Tests that must pass

unit (`bun test` + `tests/fakes/chrome.ts`, coverage of `lib/` and `background/` ≥ 90% of lines)
1. `snapshot` drops device cookies by each platform's denylist and never touches another domain.
2. `restore` leaves `domain` off host-only cookies, skips expired ones (all expired → `all_expired`), keeps `partitionKey`, and sets `sameSite` correctly.
3. `clear` builds the right url (`https`/`http` by secure + domain + path) and removes everything, partitioned cookies included.
4. `vault`: encrypt then decrypt gives the same data · a wrong password gives `wrong_password` · iv never repeats over 1,000 rounds · the ciphertext contains no cookie value in plain text · `validatePassword` refuses < 10 characters, repeats and runs · `importSessionKey` returns a key with `extractable === false`.
4b. `keyring`: the key is written to `storage.session` only (the fake `storage.local` must hold no key with the key's value) · after a simulated worker restart (cache cleared) `getKey` still returns a key · after `lock` it returns null · the journal backup holds no plain cookie.
5. `switcher`: the order is snapshot → journal → save → clear → restore → reload → verify · a press during a switch gives `busy` · FB and IG can run together · the journal is written after the snapshot exists (a crash between steps 1 and 2 must leave no journal that points at a missing backup).
6. `switcher`: a verification mismatch puts the backup back and sets status `expired` · a checkpoint URL gives `checkpoint` · the busy lock is released on every exit path.
7. A leftover journal: on worker start, roll back and clear the journal.
8. `youtube`: the URL is right with and without pageid · `next` keeps the original path · encoding is right.
9. `store`: adding a duplicate (same platformUserId) gives `duplicate` · an empty name or one over 40 characters is refused · migrating from an unknown schema deletes nothing · `settings` gets its defaults and an invalid `theme` / `language` falls back to the default.
10. `messages`: a malformed message, or a sender that is not the extension, is refused.
11. `popup/view.ts`: renders every state in happy-dom (empty / accounts / switching / success / error / rename / delete confirm / locked / settings / settings wipe confirm), once per language.
12. `popup/i18n.ts`: `resolveLanguage('auto', 'th-TH')` gives `th`, `'en-GB'` gives `en`, and an unknown language gives `en` · a placeholder is substituted and HTML-escaped · `[[x]]` becomes bold only after escaping · plural picks the right key · a missing key in `th` falls back to `en` · `locales.test.ts` (from B1) keeps the two files in step: same keys, same placeholders.
13. `popup/theme.ts`: `applyTheme('system')` removes `data-theme`, `'dark'` sets it · `cacheTheme` writes the one key · an unreadable storage (throws) does not throw out of the function.
14. `popup/motion.ts`: with `prefers-reduced-motion: reduce`, `document.startViewTransition` is never called and `update` runs once, at once · with no `startViewTransition`, `update` runs once · a second transition started during the first leaves exactly one `data-vt` owner and never leaves `data-vt` set after both finish · `circleReveal` animates a `clip-path` that starts at `circle(0px at x y)`.

e2e (Playwright Chromium + the unpacked extension from `dist/`)
15. Fake `www.facebook.com` / `www.instagram.com` map to https localhost (`--host-resolver-rules` + a self-signed cert made at test time + `ignoreHTTPSErrors`). The page shows the user taken from the cookie. Add 2 accounts, switch back and forth 5 times, the page shows the right person each time.
16. The fake server revokes a session: the popup shows the error and the previous account still works.
17. Every tab of the domain reloads, and no tab of another domain is touched.
18. Lock, enter the master password, switch · a wrong password shows an inline error · stop the service worker (`chrome://serviceworker-internals` or CDP) and switching still works without asking again.
19. No request leaves the extension (watch `context.on('request')` and tell worker/popup requests apart) and no dialog opens.
20. Popup screenshots of every state in both languages and both themes (`en`/`th` × `light`/`dark`), compared with snapshots. Layout check in the same run: in every state and language nothing is cut off or sticks out of the 360 px popup.
21. Reduced motion (`reducedMotion: 'reduce'`): switch, tab change, theme change, delete and the toast leave `document.getAnimations()` empty, including while the spinner is shown.
22. The first-paint theme: with a saved Dark theme and a light OS, the dark attribute is set before `<body>` exists (no light flash).

Manual checks before publishing (test accounts only; the user must do these or prepare the accounts)
23. 2 FB accounts and 2 IG accounts, 10 switches in a day: no checkpoint.
24. YouTube: `signin?action_handle_signin=true&authuser=&pageid=` works for a Brand Account, and Gmail in another tab does not change account.
25. Thai review: every Thai string was reviewed by a Thai language reviewer and the reviewed text is what is in `th/messages.json`.

### 8.4 Proposed card split for the real build

| Card | Work | Done when | Waits for |
|---|---|---|---|
| B1 repo skeleton + CI (done in t-512) | Everything in section 9 (Bun, strict tsconfig, Biome, bun test, Playwright skeleton, workflows, zip, README/PRIVACY/LICENSE) + manifest + empty service worker and popup + `_locales/{en,th}` skeleton and its parity test | `bun run check` passes, `bun outdated` is empty, CI is green, `bun run zip` gives a file that loads unpacked | none |
| B2 core lib | `cookies.ts`, `vault.ts`, `keyring.ts`, `store.ts` (with `settings`), `result.ts`, `fakes/chrome.ts` | Tests 1 to 4b and 9 pass, with coverage · prove with a real Chrome (Playwright Chromium) that `cookies.getAll({ domain, partitionKey: {} })` returns both partitioned and unpartitioned cookies (the official docs do not say what `{}` does); if it does not, call twice (no partitionKey, then with a topLevelSite) and merge | B1 |
| B3 FB/IG switching | `switcher.ts`, `journal.ts`, `facebook.ts`, `instagram.ts`, `messages.ts`, service worker | Tests 5 to 7 and 10 pass | B2 |
| B4 YouTube | `youtube.ts` (ytcfg + URL) | Test 8 passes | B1 (can run alongside B2/B3) |
| B5 real popup | Lift the mockup into `popup/`: `view.ts`, `main.ts`, `i18n.ts`, `theme.ts`, `motion.ts`, `theme-boot.js`, the Settings page, the final `th/messages.json` text, wired to `messages.ts` | Tests 11 to 14 pass, and the screenshots match the mockup in both languages and both themes · B5 takes the whole of sections 10, 11 and 12 | B3, B4 |
| B6 e2e | Fake sites + specs 15 to 22 | e2e is green in CI | B5 |
| B7 publish prep | Icons, `store-listing.md` (English and Thai), store images, CHANGELOG, tag `v0.1.0` → release zip | release.yml attaches the zip · the user does manual checks 23 to 25 | B6 + the user |

Each card is one branch `card/t-xxx` and one PR. Every card must pass `bun run check` and have an empty `bun outdated` before it goes to QC.

---

## 9. A repo ready to publish (best practice)

> The user decided on: Bun (package manager, script runner, unit tests), Biome (lint + format), and the newest version of every dependency. This document writes no version numbers on purpose, except in the "as built in B1" note below. Card B1 installed with `bun add -d <name>` (no version means the latest) and then required `bun outdated` to be empty.

### 9.1 Tools (summary)

| Job | Choice | Short reason |
|---|---|---|
| Package manager + scripts | Bun: `bun install`, `bun run`, lockfile `bun.lock` (text, readable diffs) | The user's choice · fast · one tool for install, run and test |
| Build | Vite (run through `bun run` / `bunx --bun vite`) | See 9.2 |
| Language | TypeScript strict, checked with `tsc --noEmit` (Bun and Vite only strip types) | |
| Lint + format | Biome alone (`biome.json`) | The user's choice · replaces ESLint + Prettier · one dependency, no plugin chain |
| Unit tests | `bun test` + `happy-dom` (view tests only) | The user's choice · has mocks, coverage and `crypto.subtle` built in, so no reason to use another runner |
| e2e | `@playwright/test`, run with `bunx playwright test` | Loads an unpacked extension in Chromium. (Puppeteer can too, but Playwright brings a test runner, fixtures, traces and a report, so nothing has to be assembled.) A justified exception: Playwright's test runner is officially supported on Node, so `bunx` runs it by its shebang (Node) and we do not pass `--bun` (GitHub runners already have Node). |
| zip | `scripts/zip.ts`, run with `bun`, using `fflate` | No dependence on the system `zip`; the result is the same on every machine |
| CI | GitHub Actions + `oven-sh/setup-bun` | The user's choice |

As built in B1 (newest at the time, for reference only): TypeScript 7.0.2 (the native compiler, still invoked as `tsc`), Vite 8.3.7, Biome 2.6.6, Bun 1.4.4 (recorded in `packageManager`), Playwright 1.65.0, happy-dom 21.0.4, fflate 0.8.3. Later cards must not copy these numbers; they ask the registry for the latest again.

### 9.2 Framework: plain Vite + TypeScript (no WXT)

| | WXT | Plain Vite + TS (chosen) |
|---|---|---|
| manifest | Generated from config and entry files | Written by hand in `src/manifest.json`. A reviewer (and the Chrome Web Store) sees the permissions directly in the repo. |
| dependencies | The framework + auto-imports + several module layers | `vite` alone on the build side |
| dev loop | HMR and automatic extension reload | `vite build --watch` + press reload in `chrome://extensions` (one popup page and one worker file are small enough) |
| zip / several browsers | `wxt zip`, Firefox/Safari built in | Our own zip script · v1 targets Chrome only |
| way out | n/a | WXT is built on Vite, so moving to it later leaves `lib/` and `background/` untouched |

Reasoning: this extension holds session cookies (worth a password), so every build dependency is supply chain we must trust, and fewer is better. There are two entries (worker and popup) and no permanent content script, so WXT's main benefits (HMR, several browsers, automatic manifest) do not pay off, and a hand-written manifest is easier to audit. `Bun.build` alone would also work, but Vite handles the HTML entry, CSS and browser targets more clearly, and it is the same road as WXT if we move later. Move to WXT when Firefox/Edge support or several UI pages arrive.

`vite.config.ts` as built in B1 (Vite 8 bundles with Rolldown, so the option is `build.rolldownOptions`, not `rollupOptions`): `root: 'src'`, `build.rolldownOptions.input = { popup: 'src/popup/index.html', 'service-worker': 'src/background/service-worker.ts' }`, `output.entryFileNames: '[name].js'`, `build.target: 'chrome119'` (kept in step with `minimum_chrome_version`), `sourcemap` only in development mode, `modulePreload: false` (no polyfill is injected), and `publicDir: 'public'` so `_locales/`, `theme-boot.js` and `icons/` are copied as they are. The popup is emitted at `dist/popup/index.html`. A small plugin emits `src/manifest.json` into `dist/` with `version` taken from package.json.

### 9.3 Dependencies: the newest of every one

- runtime dependencies = 0. The code that ships inside the extension is only ours. This is also why transition-kit (or any UI or animation library) is not used (section 12.5).
- Allowed devDependencies: `typescript`, `vite`, `@biomejs/biome`, `@types/chrome`, `@types/bun`, `happy-dom`, `@happy-dom/global-registrator`, `@playwright/test`, `fflate`. A new one needs its reason written in the PR.
- Install with `bun add -d <name>` and no version, which gives the latest on the day. `bun.lock` is always committed. CI uses `bun install --frozen-lockfile`.
- The Bun version itself: put `"packageManager": "bun@<latest on the day>"` in package.json and let CI read it with `bun-version-file`, so the developer's machine and CI match. Confirmed in B1: `oven-sh/setup-bun` v2.2.0 reads `package.json`, takes `packageManager.split("bun@")[1]`, and falls back to `engines.bun`, so no workaround file (`.bun-version`) is needed.
- Every GitHub Action is pinned by the commit SHA of its latest release on the day (the tag name goes in a comment after it).
- The gate before every card: `bun outdated` must show nothing (it is one of the "done when" items).
- After that, updates come from Dependabot (`package-ecosystem: bun` + `github-actions`, weekly, grouped PRs). `bun outdated` is not a blocking step in CI, because someone else's new release would turn CI red while our code did not change.
- Caution with "always newest": a new major can change APIs and config (for example the `biome.json` schema, or Vite 8's switch from Rollup to Rolldown). Card B1 wrote every config from the documentation of the version it actually got, not from memory.

### 9.4 TypeScript

`tsconfig.json` as built in B1 (extension code): `"target": "ES2022"`, `"lib": ["ES2023", "DOM", "DOM.Iterable"]`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"types": ["chrome", "vite/client"]`, `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"noImplicitOverride": true`, `"noImplicitReturns": true`, `"noFallthroughCasesInSwitch": true`, `"noUnusedLocals": true`, `"noUnusedParameters": true`, `"verbatimModuleSyntax": true`, `"isolatedModules": true`, `"resolveJsonModule": true` (the popup imports both `messages.json` files), `"skipLibCheck": true`, `"noEmit": true`, `include: ["src"]`.

`tests/tsconfig.json` extends it and sets `"types": ["chrome", "bun"]`. It is separate so Bun's types never leak into extension code (there is no `Bun.*` in Chrome).
`"typecheck": "tsc -p tsconfig.json && tsc -p tests/tsconfig.json"`

### 9.5 Biome (lint + format)

- `biome.json`: `recommended` preset + formatter (`indentStyle: space`, `lineWidth: 100`, single quotes) + `organizeImports`. The markdown formatter is turned off (it would rewrite this document). Files skipped: `dist/`, `release/`, `coverage/`, `playwright-report/`, `test-results/`, `tests/lint-fixtures/`, `docs/`, `mockup/`.
- The policy "no sending data out, no dialogs" is enforced by `noRestrictedGlobals` for `src/`: it denies `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `alert`, `confirm`, `prompt`, `Bun`, and also `chrome`, `globalThis`, `self`, `window`, `frames`, `parent`, `top`. The rule only matches the bare name (`globalThis.fetch(...)` slips through), which is why the list also bans the objects you would reach it through, and why `scripts/zip.ts` scans `dist/` again (9.7). The two adapter files (`src/background/chrome-adapter.ts`, `src/popup/runtime.ts`) have an override that allows `chrome` and keeps the rest. `tests/lint-fixtures/{good,bad}` prove the rules still fire.
- `noConsole` except `warn` and `error` · `noExplicitAny` is an error · `noFloatingPromises` and `noMisusedPromises` are on as errors (in Biome 2.x they sit in the `nursery` group; Chrome API code is async everywhere and a forgotten `await` leaves half-applied cookies). Biome does not infer return types from `@types/chrome`, which is why all browser access goes through the typed ports in `src/lib/ports.ts`.
- CI runs `biome ci .` (lint and format check, changes nothing); a developer runs `biome check --write .`.
- No git hooks (fewer things to install). CI is the real gate, and the README tells people to run `bun run check` before committing.

### 9.6 Scripts and test config

```json
{
  "scripts": {
    "dev": "vite build --watch --mode development",
    "build": "vite build",
    "typecheck": "tsc -p tsconfig.json && tsc -p tests/tsconfig.json",
    "lint": "biome ci . && bun scripts/check-chrome-access.ts",
    "fix": "biome check --write .",
    "test": "bun test tests/unit",
    "e2e": "playwright test",
    "perm:check": "bun scripts/check-permissions.ts",
    "zip": "bun run build && bun scripts/zip.ts",
    "check": "bun run typecheck && bun run lint && bun run test && bun run build && bun run perm:check"
  }
}
```

`bunfig.toml`:
```toml
[install]
exact = true                 # bun add writes exact versions, no ^, so package.json and bun.lock always agree

[test]
preload = ["./tests/setup.ts"]       # happy-dom GlobalRegistrator.register() for the view tests
coverage = true
coverageThreshold = { lines = 0.9, functions = 0.9 }
coverageSkipTestFiles = true
coverageReporter = ["text", "lcov"]
coverageDir = "coverage"
```
(Entries that only wire things together, such as `popup/main.ts` and `service-worker.ts`, are not counted. If the installed Bun can set an ignore pattern, use it; if not, keep those files as thin as possible.)

unit: `tests/fakes/chrome.ts` is written by us: an in-memory cookie store that follows the hostOnly / secure / path / partitionKey / expiry rules, `storage.local/session`, `tabs.query/reload/update`, `scripting.executeScript` returning a configured value, and `i18n.getMessage/getUILanguage`. It replaces an off-the-shelf mock library (most are no longer maintained, and a mock without the rules cannot catch cookie bugs). Every function takes its dependencies as parameters (8.2), so `mock()` from `bun:test` is used only where a spy on call order is wanted.

e2e: the fixture is `chromium.launchPersistentContext(tmpDir, { channel: 'chromium', args: ['--disable-extensions-except=<dist>', '--load-extension=<dist>', '--host-resolver-rules=MAP www.facebook.com 127.0.0.1:<port>, MAP www.instagram.com 127.0.0.1:<port>'], ignoreHTTPSErrors: true })`. Find the extension id from `context.serviceWorkers()`, then open `chrome-extension://<id>/popup/index.html` as a page. Use the Chromium that Playwright installs (branded Chrome no longer allows loading an extension by flag). The self-signed cert is made at run time. The real sites are never touched in CI.

### 9.7 Zip script for the Chrome Web Store

`scripts/check-permissions.ts`: `dist/manifest.json` must carry permissions and host_permissions that exactly match the allow-list (`cookies`, `storage`, `scripting` + the 3 hosts of section 4). Anything extra or missing fails. `PRIVACY.md` must mention every permission too (`checkPrivacyPolicy`).

`scripts/zip.ts`
1. Run the permission check and confirm `version` in the manifest equals package.json.
2. Check `dist/`: no `*.map`, no `<script src="http…">` or `import("http…")`, no `eval(` / `new Function(`, no `fetch(` / `sendBeacon` / `XMLHttpRequest` / `WebSocket(` that slipped through (the second gate after Biome), and `_locales/en/messages.json` and `_locales/th/messages.json` are present.
3. Zip the contents of `dist/` (manifest at the zip root) to `release/social-account-switcher-v<version>.zip`, deterministic (sorted names, fixed file times), and print the SHA-256 (also written to a `.sha256` file).

### 9.8 GitHub Actions

`ci.yml`: on `push` (main) and `pull_request`:
```yaml
permissions: { contents: read }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@<sha>            # pin the SHA of the latest release; persist-credentials: false
      - uses: oven-sh/setup-bun@<sha>
        with: { bun-version-file: package.json }   # reads packageManager: "bun@x.y.z" (confirmed from the setup-bun v2.2.0 source in B1)
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run lint
      - run: bun run test
      - run: bun run build
      - run: bun run perm:check
      - run: bunx playwright install --with-deps chromium
      - run: bun run e2e
      - run: bun scripts/zip.ts
      - uses: actions/upload-artifact@<sha>
        with: { name: extension-zip, path: "release/*.zip\nrelease/*.sha256", retention-days: 14, if-no-files-found: error }
      - if: failure()
        uses: actions/upload-artifact@<sha>
        with: { name: playwright-report, path: "playwright-report/\ntest-results/", retention-days: 7 }
```
`release.yml`: on a `v*` tag it runs the same steps and attaches the zip and its SHA-256 to a GitHub Release (`permissions: contents: write` for that job only). Uploading to the Chrome Web Store is done by hand in v1 (no store token in the repo). `.github/dependabot.yml` follows 9.3.

### 9.9 Documents and files that must exist

| File | Content |
|---|---|
| `README.md` | What it does (a popup picture), install from the store or load unpacked from the release zip, the 3-step use, the short limits and risks (section 7), development (`bun install`, `bun run dev`, `bun run check`), the file layout, how to release, how to add a language (section 10.7) |
| `PRIVACY.md` | The extension reads cookies of 3 domains: what it stores (section 5), where (only the user's machine), how it is encrypted, and that the strength depends on the master password (a short form of the numbers table in section 6) and that the delay after wrong attempts does not stop guessing from a stolen file, no sending out, no server, no analytics, no selling or sharing, what each permission is for, how to delete all data (Settings, Wipe all data), a contact. It is used as the privacy-policy URL on the store page. |
| `LICENSE` | MIT (year + the repo owner's name; card B1 asks the user which name to use) |
| `SECURITY.md` | Report vulnerabilities through GitHub private vulnerability reporting |
| `CHANGELOG.md` | Keep a Changelog + SemVer |
| `docs/store-listing.md` | Store page text (English and Thai), the reason for each permission (the store's justification field), and the single purpose: "Switch between the Facebook, Instagram and YouTube accounts the user has logged in to themselves" |
| `.gitignore` | `node_modules/ dist/ release/ coverage/ playwright-report/ test-results/ *.pem .env*`. No secrets or build files in the repo (the e2e cert is made at run time). |
| `.editorconfig` | utf-8, LF, 2 spaces |

### 9.10 Repo security rules

- Zero runtime dependencies · no code, fonts or images loaded from outside (MV3 and the Web Store already forbid remote code) · fonts are the system's.
- Adding a permission means editing 3 places together: the manifest, the allow-list in `scripts/permissions.ts`, and `PRIVACY.md`. Forget one and CI fails.
- Suggested GitHub settings: branch protection on `main` (CI must pass), secret scanning, Dependabot alerts.
- Nothing is pushed to a remote in this card. The user creates the destination repo and pushes it themselves.

---

## 10. Internationalization (i18n)

### 10.1 What the user gets
The popup is in English (the default) or Thai. Settings has a Language control with three choices: Auto (follow the browser), English, ไทย. The choice is saved and applies at once, with no reload. More languages can be added later by adding a folder (10.7).

### 10.2 One source of strings
Every user-facing string lives in `public/_locales/<lang>/messages.json`, in Chrome's standard format. There is no other table. The same files serve three readers:
- `manifest.json` uses `__MSG_extName__`, `__MSG_extShortName__`, `__MSG_extDescription__`, `__MSG_actionTitle__`. Chrome resolves these itself, in the browser's UI language, and `default_locale` is `en`. The in-popup Language setting cannot change them. That is a limit of the platform and is acceptable: they are the extension's name and tooltip.
- The popup imports both JSON files at build time (`resolveJsonModule`, a normal `import`), so a language switch needs no `fetch`, no network and no permission. It cannot rely on `chrome.i18n.getMessage`, which always answers in the browser language and would ignore the user's choice.
- The Chrome Web Store reads the same folders for the localized listing.

### 10.3 Key and message rules
- Keys use only letters, digits and `_` (Chrome requires it), in `camelCase`/`snake_case` groups such as `list_label`, `error_title`, `settings_theme`. (The mockup writes them with dots, `list.label`, for readability; the real key replaces each dot with `_`. B5a generated `public/_locales/{en,th}/messages.json` from the mockup's tables that way: 109 keys per language, with the mockup's seed names and its "Mockup password" hint left out. The real lock hint is `lock_hint`.)
- Each entry has a `message` and a `description` for translators, as B1 already does. Placeholders use Chrome's form: `"message": "Switched to $NAME$"` with `"placeholders": { "name": { "content": "$1" } }`. Both languages must declare the same placeholders; `tests/unit/locales.test.ts` checks it, together with the same key set.
- Plurals: Chrome messages have no plural syntax. A count word has two keys (`tabs_one`, `tabs_other`, built in B5a) and `i18n.ts` picks one with `Intl.PluralRules(lang)`. Thai has one form, so both keys can hold the same text.
- Emphasis: a message may wrap a word in `[[…]]`. `i18n.ts` escapes all parameters and the text first, then turns `[[x]]` into `<b>x</b>`, so a user-typed name can never inject markup. No other markup is allowed in messages.
- User-typed data (account names) is never translated and is always escaped.

### 10.4 Choosing the language
`resolveLanguage(pref, uiLanguage)`: `'en'` and `'th'` are returned as they are. For `'auto'`, take the primary subtag of `chrome.i18n.getUILanguage()` (`th-TH` → `th`); if the language has a folder, use it, else `en`. The result sets `<html lang>` so screen readers, hyphenation and the font stack follow it. A missing key in a non-English file falls back to the English text (and the test in 8.3 makes that case fail CI, so it should never ship).

Storage: `settings.language` in `storage.local` (section 5).

### 10.5 Writing quality
- English text is plain and direct: short sentences, the verb the user would say, no filler and no marketing words. Every English string is run through the `humanizer` skill before it is committed.
- Thai text is written the way a Thai speaker would say it. Product words people already say in English stay in English (`session`, `cookie`, `login`, `Google`, `Facebook`, `Instagram`, `YouTube`, `Chrome`, `extension`). Every Thai string is reviewed by the project's Thai language reviewer (`kru-thai`) before it goes into `th/messages.json`, and the reviewed text is what ships (manual check 25).
- Thai text has no spaces between words, so every text box must be able to break a long line anywhere (`overflow-wrap: anywhere`), and Thai needs more line height (the mockup uses 1.55).

### 10.6 Fonts and layout
No web fonts (section 9.10). The CSS has two stacks: `system-ui` for English, and a Thai stack (`"IBM Plex Sans Thai", "Noto Sans Thai", "Sukhumvit Set", "Leelawadee UI", Tahoma, system-ui`) applied with `:lang(th)`. The 360 px popup must show every state in both languages without cutting or overflowing text. The e2e (test 20) measures this in every state, so a longer translation cannot ship by accident. Account name and sub-line wrap instead of being cut, except the account name, which ends with an ellipsis only when it is longer than the row.

### 10.7 Adding a language
1. Copy `public/_locales/en` to `public/_locales/<code>` and translate the `message` fields.
2. Add the code to the `Language` union and to `resolveLanguage`, and add its button to Settings (the name of a language is always written in that language).
3. `locales.test.ts` must pass (same keys and placeholders). Add the language to the screenshot loop in the e2e.

---

## 11. Theme

### 11.1 Behavior
Three choices in Settings: System (default), Light, Dark. System follows `prefers-color-scheme` live, so if the OS switches at sunset the popup follows. The choice is stored in `settings.theme`. The change is shown with a Circle Reveal (12.2).

### 11.2 Tokens
Every colour is a CSS custom property on `:root` (`--bg`, `--surface`, `--surface-2`, `--text`, `--text-2`, `--line`, `--focus`, `--ok`, `--err`, `--warn`, and the platform colours with a soft variant). There are no hard-coded colours in components, so a new page (an options page, say) gets both themes by importing the same `popup.css` tokens.
- Light = the `:root` values.
- Dark = the same names under `:root[data-theme="dark"]`, and under `@media (prefers-color-scheme: dark)` for `:root:not([data-theme="light"])`. So System needs no JavaScript at all: with no `data-theme` attribute, the media query decides.
- `color-scheme: light` / `dark` is set with the tokens so form controls and scrollbars follow, and the page has `<meta name="color-scheme" content="light dark">`.
- Contrast: body text, secondary text, the footer and section labels must reach 4.5:1 in both themes (the e2e computes it).

### 11.3 No wrong-colour flash on open
The popup must never paint light for a moment and then turn dark. `storage.local` is asynchronous, so it cannot be read before the first paint. The fix is a synchronous cache:
1. `public/theme-boot.js` is a tiny classic script (about 10 lines, no imports) referenced from `<head>` of `popup/index.html` before the stylesheet: it reads `localStorage.getItem('theme')` inside a `try`, and if the value is `light` or `dark` it sets `data-theme` on `<html>`. It has to be a separate file: an inline script is blocked by the MV3 content security policy. It sits in `public/`, so Vite copies it untouched (no hashing, no module wrapper), and it runs before the body is parsed.
2. `theme.ts` writes the same value into `localStorage` every time the user changes the theme, and once at load when it finds `storage.local` disagrees (so the source of truth always wins).
3. If the cache is empty (first run, or the user cleared site data), the popup paints in System mode, which is right for most people, and then applies the stored theme. That is the only case with a possible flash, and it happens once.
4. e2e test 22 checks the attribute is set before `<body>` exists.

### 11.4 Changing the theme
`setTheme(value, clickEvent)`: update `settings.theme` through the worker message, write the cache, then run `circleReveal(x, y, () => applyTheme(...))` (12.2). With reduced motion, or with no View Transitions, the theme just changes. The Settings buttons use `aria-pressed`.

---

## 12. Motion

### 12.1 Principles
Motion tells the user what just happened (a row moved, a switch finished) and never makes them wait. Rules:
- Short. Nothing is longer than 600 ms, and nothing blocks input: the transition layer has `pointer-events: none`, so a click during an animation goes straight to the live page.
- One set of tokens (below). No component hard-codes a duration or easing.
- Enhancement only. If the browser has no View Transitions, or the user asked for reduced motion, the DOM changes at once and every function still works. Nothing depends on an animation finishing.
- Platform APIs, no library (12.5): `document.startViewTransition`, `view-transition-name`, `view-transition-class`, and CSS keyframes.

Tokens (CSS custom properties on `:root`; one multiplier, `--motion-scale`, lets the recorder slow everything down for GIFs and defaults to 1):

| Token | Value | Used for |
|---|---|---|
| `--dur-fast` | 120 ms | cross-fades inside a morph |
| `--dur-base` | 240 ms | default group move, fades, slide out |
| `--dur-slow` | 420 ms | pill glide, pop in, expand, slide in, toast in |
| `--dur-reveal` | 560 ms | Circle Reveal |
| `--ease-out` | `cubic-bezier(.22, 1, .36, 1)` | things arriving |
| `--ease-in-out` | `cubic-bezier(.65, 0, .35, 1)` | things leaving or resizing |

### 12.2 How it is wired
`motion.ts` exports `transition(mode, update, { dir })`. It does five things: skip the animation (just run `update()`) when `document.startViewTransition` is missing or `matchMedia('(prefers-reduced-motion: reduce)')` matches · set `data-vt="<mode>"` on `<html>` and `--vt-dir` (1 or -1) · put a `view-transition-name` and `view-transition-class` on the elements that should move on this transition (names are set on the old DOM before the call and on the new DOM inside the update callback, so both snapshots carry them) · call `document.startViewTransition(update)` · clear `data-vt` and `data-vt-busy` when `finished` settles (only if no newer transition took over; a newer one skips the older one, and the rejected `ready` / `finished` promises are caught so nothing is logged as an error).

Elements get names only in the modes that need them, because an element with a name is lifted into its own layer and would otherwise animate on unrelated updates. The default root cross-fade is turned off (`::view-transition-old(root), ::view-transition-new(root) { animation: none }`), so everything that is not named just changes.

### 12.3 The six transitions

| # | Where | Mode | What moves | Duration / easing | How |
|---|---|---|---|---|---|
| 1 | Theme change | `theme` | Circle Reveal: the new theme grows as a circle from the point that was clicked | `--dur-reveal`, `--ease-out` | The new root snapshot is animated in JS with `root.animate({ clipPath: ['circle(0px at x y)', 'circle(r at x y)'] }, { pseudoElement: '::view-transition-new(root)' })`. `r` is the distance from the click to the farthest corner. |
| 2 | Platform tabs | `tab` | The selected-tab pill glides to the new tab, and the panel slides sideways (direction follows the tab order) | pill `--dur-slow`; panel out `--dur-base`, in `--dur-slow` | The pill is its own element with `view-transition-name: pill`; the panel has `panel`. Keyframes `vt-slide-out` / `vt-slide-in` use `translateX(calc(var(--vt-dir) * 28px))` and opacity. |
| 3 | Account list | `list` | Add: the new row pops in (scale .92 → 1, fade). Remove: the row fades out. The others glide into their new place (this also covers the active account moving to the top). | pop `--dur-slow`; fade `--dur-base`; glide `--dur-base` | Each row is named `row-<id>` with class `row`. A row that exists only in the new snapshot matches `::view-transition-new(.row):only-child` (pop in); only in the old one, `::view-transition-old(.row):only-child` (fade out). The group animation does the glide. |
| 4 | Switch status (row slot and Unlock button) | `status` | Morph idle → loading → success or error: the right-hand slot of a row changes from the pencil and trash, to a spinner, to a green check (or a red cross), and the box resizes while the faces cross-fade. The Unlock button does the same: label → spinner "Unlocking…" → "Unlocked" (or "Try again" in red). | group `--dur-slow` `--ease-in-out`; cross-fade `--dur-base` | The slot is named `slot-<id>` (class `slot`), the button `sbtn`. The steps of a switch change the label and the progress bars in place (no re-render), so the spinner keeps turning smoothly. |
| 5 | Rename editor, delete confirmation, add form, error bar, wipe confirmation, Settings page | `expand` and `page` | The row or card expands and collapses in place. The Settings page and the lock screen slide in from the side (forward) and out (back). | expand `--dur-slow`; slide as in 2 | Rows and Settings cards keep their name while their content changes (`expand`); the panel slides (`page`). |
| 6 | Toast | any | The toast slides up into view and slides down out | in `--dur-slow`; out `--dur-base` | Named `toast`; arriving matches `::view-transition-new(toast):only-child`, leaving `::view-transition-old(toast):only-child`. |

A language change uses mode `lang`, a short cross-fade of the whole popup (`--dur-base`), so the text does not jump. Hover and focus colours use plain CSS `transition` with `--dur-fast`.

### 12.4 Reduced motion and no support
- `prefers-reduced-motion: reduce`: `transition()` does not call `startViewTransition` at all. The change is immediate, including the theme (no circle). The CSS also sets `animation: none !important` on every view-transition pseudo-element as a second guard. The spinner stops turning and becomes a still ring, and the label ("Switching…") still says what is happening. A short fade (≤ 120 ms) would be acceptable by the rule, but v1 uses none, so `document.getAnimations()` is empty and testable (e2e test 21).
- No View Transitions API: `update()` runs directly and nothing throws (a test deletes the API and runs every flow). A browser that has the API but not `view-transition-class` (before Chrome 125) loses the pop-in and fade-out specifics and gets the default cross-fade for those rows, which is still correct.
- A transition never changes focus. The popup stays `aria-live="polite"`, so the new state is announced once it appears.

### 12.5 Why transition-kit is not used
The brief pointed to transition-kit.space for ideas. It is a React 19 + shadcn + Tailwind kit. Using it here would mean a UI framework and a CSS toolchain inside an extension that has exactly two entries and a rule of zero runtime dependencies (9.3 and 9.10), where every added package is code we have to trust next to session cookies. It also declares no license, so we have no permission to copy its code. We took the ideas only (Circle Reveal, animated list, status button, sliding tabs) and built each one directly on the platform's View Transitions API and CSS, with a small amount of code. The result is checked in `mockup/popup.html`, recorded in `mockup/media/*.gif`, and tested by `mockup/e2e/popup.e2e.mjs`.
