# Social Account Switcher — v0.1.1 implementation design

> Status: v0.1.1 implementation specification with a proposed v0.2.0 TikTok design in section 13, 2026-11-10. Live account checks remain manual; this document does not claim publication or checkpoint-free operation.
> Clickable reference: `mockup/popup.html`; runner: `mockup/e2e/popup.e2e.mjs`; instructions: `mockup/README.md`. Generated captures and run logs are not versioned. Small current popup images are in `docs/images/`.
> Repository prose is English. English and Thai are supported UI languages.

## 1. Goals and scope

Switch between the user's own Facebook, Instagram and YouTube accounts from a 360 px Manifest V3 popup. Users perform website login and verification themselves. Facebook/Instagram sessions are saved locally under password encryption; YouTube stores sign-in coordinates and uses Google's multi-account sign-in navigation.

There is no extension server, account sync, analytics, login automation, remote code, runtime dependency or incognito support. This version does not export/import saved sessions. It does not provide separate Facebook/Instagram accounts in different tabs: cookies are shared within a browser profile. Messenger.com and other domains are outside the host permission list.

Distribution is a zip on GitHub Releases, installed with Chrome's Developer mode and Load unpacked. The repository is [M4h45amu7x/social-account-switcher](https://github.com/M4h45amu7x/social-account-switcher). The owner controls publication.

## 2. User flow

### 2.1 First open and adding an account

On first open, a missing vault always leads to master-password setup, including when the user intends to use only YouTube. The popup validates the password before sending it; the worker validates it again. Once set up, users sign in on a website themselves, choose its platform and press **Add the account I'm logged in to**. The probe reports an ID tail, not a profile name or photo. The user supplies a label of 1–40 characters. Duplicate identities are refused; **Update session** refreshes an existing entry after a new login.

Which platform tab the popup opens on (v0.1.1, `src/popup/start.ts`): the platform of the active tab in the current window, else the tab the person picked last (the `platform` key in the popup's `localStorage`, written only when they click a tab), else Facebook. The popup reads the active tab's URL with `tabs.query({ active: true, currentWindow: true })`. Chrome fills in `url` only for hosts in the extension's host permissions, so no `tabs` or `activeTab` permission is needed and other sites stay invisible. `platformOfUrl` in `src/lib/sites.ts` matches the site's domain and its subdomains and nothing else (`facebook.com.evil.test`, `notfacebook.com` and `youtube.com@evil.test` are not matches). A unit test keeps the manifest host permissions and the tab patterns equal to that list, so a new platform is one more entry there and the matcher does not change. The popup waits at most 150 ms for the answer before its first draw, so it never slides from one tab to another on its own; a late or failed answer falls back to the last pick. When the popup is over a supported site, the empty list and the add button skip **Open facebook.com** and say **Add the account on this tab**. After the list loads, `account.probe` names the saved account logged in there (`accountId`), and that row shows **On this tab** in place of **Active**. The popup captures the tab id from that same current-window query and sends it with contextual probe/add requests. YouTube reads only that tab, including when updating a shortcut; a missing id, closed tab or navigation away from YouTube returns not-found instead of selecting another window. Contextual Facebook/Instagram requests also check that the captured tab still belongs to the platform before reading the profile's shared cookies. A locked popup keeps the chosen tab through unlocking.

### 2.2 Switching

A locked popup requires unlocking for all platforms, including YouTube; the backend YouTube switch itself does not need the vault key. Selecting a saved row starts a request. Before replacing an unsaved Facebook/Instagram login, the popup offers to save it or switch anyway. Progress labels advance on a timer while the worker runs, rather than reporting actual completed operations. The worker's reply determines success, reloaded-tab count and the active badge.

Request deadlines belong to the popup (section 8.2). A timeout is an unknown outcome and does not cancel the worker. The popup reads state to reconcile, marks it stale if that read fails, and offers a read-only retry. It does not automatically replay a timed-out write.

### 2.3 Rename and remove

Pencil/edit and delete controls operate inline. Labels are local; empty or overlong labels are refused. Deleting an entry removes its saved data without logging the website out or deleting the website account. Enter/Esc and focus return are covered by popup tests; browser alert/confirm/prompt dialogs are not used.

### 2.4 Session errors

An expired session or identity mismatch leads to a login/update message. Complete website login yourself, then choose **Update session**. A checkpoint means the website requires a manual security check; the extension does not bypass it. A checkpoint result can leave the target account active pending that check. Rollback is attempted for relevant failed cookie switches, not guaranteed for every possible browser failure.

### 2.5 Lock and wipe

**Lock now** deletes the unlocked key and worker cache. **Forgot password** deletes the vault and Facebook/Instagram entries while retaining YouTube shortcuts, preferences and any quarantine records; an unreadable store is removed whole. **Settings → Wipe all data** removes the entire local store. Both confirmed wipes clear the key, unlock-attempt record and journals, and are refused while a platform is busy. The popup returns to setup when the vault is absent. See `PRIVACY.md` for storage and retention limits.

### 2.6 Settings

Theme choices are System / Light / Dark. Language choices are Auto / English / Thai. Settings also offers Lock now and Wipe all data. Confirmation is inline.

## 3. Switching implementation

### 3.0 Facebook/Instagram shared cookie switch

`src/background/switcher.ts` implements these steps through injected ports:

0. Take the platform's in-worker busy lock before the first await.
1. Read the target and its encrypted saved cookies; reject missing, locked or fully expired data. Snapshot the current non-device cookies. Refuse an unsaved current identity unless explicitly forced.
2. Encrypt the snapshot, then write the platform journal in `storage.session` with source/target IDs and start time. The backup exists before the journal is written.
3. If the current identity is saved, encrypt and save its latest session.
4. Remove the platform's non-device cookies.
5. Restore the target cookies, preserving cookie attributes and partition keys. Skip expired cookies and omit `domain` for host-only cookies.
6. Reload matching platform tabs.
7. Wait for a reloaded tab, up to the tab-load timeout, then check for a checkpoint and read the identity cookie. A mismatch marks the target expired and attempts to restore the previous snapshot. A checkpoint marks the target accordingly and requires user action.
8. Clear the journal once the browser is in a known state. Release the busy lock when the operation settles.

`journal.ts` attempts leftover-journal recovery on worker startup and after unlocking. Recovery uses the same platform lock; a locked key defers it, and an unreadable backup is dropped. A browser API that never settles can block both switch completion and recovery. There is no overall worker deadline.

Device cookies are excluded by the explicit platform lists below. Other cookies of those domains are captured; this is not a claim that all future website cookies will remain compatible. `lib/cookies.ts` preserves partitioning and handles expired/host-only cookies. Tests exercise `getAll({domain, partitionKey: {}})` in bundled Chromium; every intermediate version from the declared Chrome 119 minimum has not been tested.

### 3.1 Facebook

`background/platforms/facebook.ts`: domain `facebook.com`, identity `c_user`, device exclusions `datr`, `sb`, `locale`, `wd`, `dpr`. Matching `/checkpoint/` and `/challenge/` paths require user action. Login destination is `https://www.facebook.com/login/`. Other Facebook-related domains are not managed.

### 3.2 Instagram

`background/platforms/instagram.ts`: domain `instagram.com`, identity `ds_user_id`, device exclusions `mid`, `ig_did`, `ig_nrcb`, `datr`. Checkpoint/challenge and `/accounts/suspended` paths require user action. Login destination is `https://www.instagram.com/accounts/login/`. Session and CSRF cookies are captured together unless excluded by the device list.

### 3.3 YouTube: Google multi-account sign-in

`background/platforms/youtube.ts` never swaps Google/YouTube cookies. Through the scripting port it reads only `SESSION_INDEX` and `DELEGATED_SESSION_ID` from `ytcfg` in a YouTube page's MAIN world. It validates the index and optional page ID, then stores them with the user-supplied label and local account metadata.

Switching selects an active YouTube tab if one exists, otherwise the first YouTube tab, otherwise creates one. It navigates to:

```text
https://www.youtube.com/signin?action_handle_signin=true&authuser=<N>&pageid=<P>&next=<path>
```

The optional pageid is omitted when absent. `safeNext` accepts a bounded YouTube path/query/fragment, rejecting external/protocol-relative, backslash, control-character and excessive encoding inputs to `/`. Navigation waits for loading/completion after the update/create anchor, then verifies the resulting `ytcfg`. Other YouTube tabs are reloaded; closed tabs are tolerated. Google-domain URLs are hidden without a Google host permission, so a destination that is not visibly YouTube cannot be verified as signed in.

This navigation coordination has a known race when the user opens another video in the same tab just before sign-in completes. A still-valid saved account can be reported expired. Google logout may also shift account indexes. Use **Update session** after signing in to the intended account. Local redirect tests do not establish live Google or Brand Account behavior, or effects on other Google tabs; manual check 24 remains necessary.

### 3.4 Recovery and concurrency boundaries

Facebook and Instagram have separate platform locks and separate journals. A store mutex serializes read/modify/write updates. YouTube also has a busy guard in the router. Service worker restart resets in-worker busy state while Chrome's session storage can retain the key and recovery journal. Browser restart or extension reload clears session storage, so cross-restart rollback is not promised.

## 4. Permissions

The source of truth is `src/manifest.json`, constrained by `scripts/permissions.ts` and the permission table in `PRIVACY.md`.

| Permission | Purpose |
|---|---|
| `cookies` | Read/remove/set Facebook and Instagram cookies through the cookie port. |
| `storage` | Local store and session key/journals/unlock-attempt state. No sync storage. |
| `scripting` | Read the two YouTube sign-in coordinates in MAIN world. |
| `*://*.facebook.com/*` | Facebook cookie access and tab identification/reloads. |
| `*://*.instagram.com/*` | Instagram cookie access and tab identification/reloads. |
| `*://*.youtube.com/*` | YouTube scripting and tab identification/navigation/reloads. |

There is no Google-domain permission, all-sites permission, content script, externally-connectable entry or network interception. Host permissions suffice for the relevant tab queries; there is no `tabs` permission. The MV3 default CSP applies. `incognito` is `not_allowed`. Vite supplies the manifest version from package.json and targets the declared Chrome 119 minimum.

## 5. Data model and retention

`lib/store.ts` defines `StoreV1`, stored under `store` in `storage.local`: schema version, accounts, active ID by platform, settings, vault and optional `quarantine`. Account metadata includes label/initials/internal ID/platform/user ID or YouTube coordinates/status and timestamps. Metadata and settings are plaintext.

The vault contains KDF parameters, salt, IV, ciphertext and an encrypted password-check value. Its decrypted `SessionMap` maps saved entry IDs to cookie arrays and capture times. Each journal (`journal.facebook`/`journal.instagram`) contains encrypted backup cookies plus plaintext IDs, platform and start time. `storage.session.vaultKey` holds the raw key as base64. `unlockFailures` holds wrong-attempt count and time. The popup caches only `theme` in its own localStorage for first paint.

Loading defaults unknown settings, retains invalid/duplicate account records unchanged in quarantine, and refuses unknown schemas or malformed vaults without silently overwriting them. Forgot-password wipe preserves quarantine; all-data wipe removes it. See `PRIVACY.md` for the complete data inventory and deletion behavior.

## 6. Security and threat model

1. Session cookies can grant account access. User login, 2FA and platform checks remain the user's responsibility.
2. `lib/vault.ts` creates PBKDF2-SHA-256 vaults with 600,000 iterations, a random 16-byte salt and AES-GCM-256. Every vault write has a fresh 12-byte IV. Unlock uses validated stored KDF parameters. The password must contain at least ten Unicode code points and cannot be a simple repeat or run. That rule does not guarantee password entropy.
3. Anyone with a copied vault can guess passwords offline; the UI delay does not protect that copy. No quantitative cracking-time guarantee is made. There is no password recovery.
4. The raw unlocked key is stored in memory-backed `storage.session`, never in the local vault. A non-extractable imported working key is cached in the worker. Lock clears the cache and session key. This does not protect an already-unlocked browser from local inspection or malware.
5. After five wrong unlocks, further attempts are delayed by 30 seconds using session-state counters. Successful unlock and wipe clear those counters.
6. The worker validates request shapes and accepts messages only from this extension's own pages. Session storage access is restricted to trusted extension contexts. Labels and substitutions are escaped before rendering; message markup is constrained.
7. No independent upload requests, remote code, fonts or runtime dependencies are part of the extension. Browser navigation and website reloads still send normal site traffic and cookies; YouTube coordinates appear in its sign-in URL. Static lint/zip checks and request-observing tests do not constitute proof against every possible indirect network path.
8. The master password is excluded from HTML markup and cleared from popup state when setup/unlock is sent. The input's DOM property can retain it until the next redraw. Disabling the password field while waiting is not implemented yet and is not scheduled for a specific release. See the security-hardening item in [known issues](known-issues.md).

## 7. Limits and known issues

The maintained list is [known-issues.md](known-issues.md): YouTube navigation races/index shifts, a stuck browser API retaining worker busy state, timer-driven progress labels, simulated-site coverage and browser/installation evidence limits. Logout, server revocation, website changes and risk checks can invalidate stored sessions. Reloading tabs can lose unsaved website drafts. Removing a local entry does not sign the website out. Backups and OS/browser inspection are outside the encryption guarantee.

## 8. Architecture and verification

### 8.1 Entries and modules

Vite builds the popup and MV3 service worker, copying local public assets. The worker entry wires adapters, key hardening, router and journal recovery. The popup is composed of a pure reducer/view, application/DOM layer and bridge that maps effects to worker requests. Tests have separate fixture entries that are excluded from the production package.

### 8.2 Ports, results and deadlines

Only `src/background/chrome-adapter.ts` and `src/popup/runtime.ts` access the browser global. Other modules receive interfaces from `lib/ports.ts`. Router messages are schema/sender checked and return a Result; popup responses are validated and error codes are mapped to localized messages. Crypto and DOM modules use their platform APIs directly where appropriate; ports isolate browser-extension APIs.

`lib/timing.ts` defines:

| Constant | Value | Boundary |
|---|---|---|
| `TAB_LOAD_TIMEOUT_MS` | 15,000 ms | Worker tab-load wait only. |
| `READ_DEADLINE_MS` | 5,000 ms | Popup read/probe/tab-count wait. |
| `WRITE_DEADLINE_MS` | 10,000 ms | Popup write/setup/unlock wait. |
| `SWITCH_DEADLINE_MS` | 20,000 ms | Popup switch wait: tab-load wait plus 5,000 ms margin. |

These are not an abort mechanism. There is no overall worker deadline for storage, cookie, tab or verification APIs. The popup treats a timed-out mutation as an unknown outcome, reads state, and distinguishes recovered state from stale/unreadable state. Stale state disables writes and keeps a read-only retry path. Switch step labels are driven by `bridge.ts` timers, not worker progress events.

### 8.3 Tests and manual checks

unit (`bun test` + `tests/fakes/chrome.ts`; configured coverage threshold is 90% for both lines and functions)
1. `snapshot` drops device cookies by each platform's denylist and never touches another domain.
2. `restore` leaves `domain` off host-only cookies, skips expired ones (all expired → `all_expired`), keeps `partitionKey`, and sets `sameSite` correctly.
3. `clear` builds the right url (`https`/`http` by secure + domain + path) and removes everything, partitioned cookies included.
4. `vault`: encrypt then decrypt gives the same data · a wrong password gives `wrong_password` · iv never repeats over 1,000 rounds · the ciphertext contains no cookie value in plain text · `validatePassword` refuses < 10 characters, repeats and runs · `importSessionKey` returns a key with `extractable === false`.
4b. `keyring`: the key is written to `storage.session` only (the fake `storage.local` must hold no key with the key's value) · after a simulated worker restart (cache cleared) `getKey` still returns a key · after `lock` it returns null · the journal backup holds no plain cookie.
5. `switcher`: the order is snapshot → journal → save → clear → restore → reload → verify · a press during a switch gives `busy` · FB and IG can run together · the journal is written after the snapshot exists (a crash between steps 1 and 2 must leave no journal that points at a missing backup).
6. `switcher`: a verification mismatch puts the backup back and sets status `expired` · a checkpoint URL gives `checkpoint` · the busy lock is released when the operation settles. A browser API that never settles can keep it held (section 7).
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
19. No independent HTTP(S) request originates from the worker or popup (watch `context.on('request')` and tell worker/popup requests apart) and no dialog opens.
20. Popup screenshots of every state in both languages and both themes (`en`/`th` × `light`/`dark`), compared with the live local mockup. Layout check in the same run: in every state and language nothing is cut off or sticks out of the 360 px popup.
21. Reduced motion (`reducedMotion: 'reduce'`): switch, tab change, theme change, delete and the toast leave `document.getAnimations()` empty, including while the spinner is shown.
22. The first-paint theme: with a saved Dark theme and a light OS, the dark attribute is set before `<body>` exists (no light flash).

> **Result of card B6:** tests 15 to 19, 21 and 22 run in `tests/e2e/fake-sites.spec.ts`, one Chromium for the whole file, through the shared server in `tests/e2e/https-sites.ts` (the YouTube test of 3.3 uses it too). The fake sites in `tests/e2e/fake-social.ts` model the selected cookie and navigation rules; they are not evidence of real Meta behavior. A session the server no longer knows gets its identity and session cookies deleted on the next load, so verify (3.0 step 7) finds no identity cookie and puts the previous account back. A checkpoint page sends anyone who is not under check back to `/`. Device cookies `datr` and `mid` are set once per browser, while `sb` and `ig_did` are set again at each login, so a switch that swapped them would show. Test 19 sorts requests into worker, popup and site pages, and the server lists every host it was asked for. Test 20 is card B5a's `popup-states.spec.ts`, which compares every state with the same state of `mockup/popup.html` instead of with stored snapshots.

Manual checks before publishing (test accounts only; the user must do these or prepare the accounts)
23. Use two owned test accounts each for Facebook and Instagram and switch repeatedly. Record any checkpoint or invalidation; no checkpoint-free behavior is guaranteed.
24. YouTube: `signin?action_handle_signin=true&authuser=&pageid=` works for a Brand Account, and Gmail in another tab does not change account.
25. Check that the reviewed Thai text is the text shipped in `public/_locales/th/messages.json`.
26. Download/extract the GitHub release zip, use Chrome Developer mode and the native Load unpacked folder picker, then open its popup.
27. Check the first unchanged GitHub-hosted CI run, including browser installation with system dependencies. The shared development host requires sudo for that step.
28. Exercise lock, both confirmed wipe actions and expired-session recovery with owned test accounts. Never attach real cookies or passwords to reports.

### 8.4 Delivery boundaries

B1–B6 provide the shell, core storage/crypto, platform adapters, router, popup wiring and local fake-site E2E. B7a supplies icons/screenshots/GitHub documentation. B7b reconciles privacy/design/known issues and removes generated evidence from the tracked tree. Final integration, tag creation and owner handoff remain lead responsibilities. Test-account and hosted-runner checks are not inferred from local passing tests.

## 9. Repository and release

### 9.1 Tools

Use the exact Bun version pinned in package.json (1.4.4 for this version). Vite, strict TypeScript, Biome, Bun unit tests and Playwright are development dependencies. There are no runtime dependencies. The lockfile and exact dependency versions are committed; `bun outdated` must have no entries at integration.

### 9.2 Build

`vite.config.ts` builds the popup and service worker for Chrome 119. `dist/manifest.json` gets the package version. Production excludes the E2E fixture and development source maps; packaging checks inspect the result.

### 9.3 Dependency maintenance

Review updates and rerun the complete gates before integration. Workflow actions are pinned by commit. Dependabot is configured for maintenance; latest-version status is checked at the time of verification rather than promised indefinitely.

### 9.4 TypeScript

Strict project and test typechecks run before bundling. Types describe ports, messages, settings, platform records and Results; runtime validation is still required for stored data and incoming messages.

### 9.5 Lint and API boundaries

Biome and `scripts/check-chrome-access.ts` enforce browser-global restrictions and reject direct network calls. Exact supplied brand files are excluded from formatting/lint mutation. Generated files, docs and the historical mockup are excluded where configured. Boundary fixtures test rejected syntax as well as accepted adapter access.

### 9.6 Commands

`bun install --frozen-lockfile`; `bun run check` (typecheck, lint, unit coverage, build, permissions); `bunx playwright install chromium`; `bun run e2e`; `bun run zip`; `bun outdated`. CI installs browser system dependencies with `bunx playwright install --with-deps chromium`; this requires appropriate host installation authority. Unit coverage thresholds are 90% lines and functions. E2E runs one worker against unpacked extension builds and local fixtures. `SHOTS=1` opts into the separate wired screenshot cases.

### 9.7 GitHub release zip

`scripts/zip.ts` checks the manifest permission allow-list, the permission table in `PRIVACY.md` and the manifest/package version match. It rejects source maps and code matching its forbidden patterns for remote scripts/imports, dynamic evaluation and direct network APIs. It does not check that required locale files exist. It sorts archive entries and fixes local calendar timestamp fields to 2000-01-01 00:00:00, producing `release/social-account-switcher-v<version>.zip` and its SHA-256 file with the manifest at archive root. Unchanged builds under `TZ=UTC` and `TZ=Asia/Bangkok` must produce the same checksum; a subprocess unit test covers both timezone encodings.

### 9.8 Workflows

`ci.yml` runs on main pushes and pull requests with read-only permissions: frozen install, typecheck, lint, unit coverage, build, permission check, browser install with dependencies, full E2E, zip and artifact upload. Failure retains browser reports. `release.yml` runs on `v*` tags, checks that the tag equals the package version, runs the gates and uses its job-scoped contents-write permission to attach zip and checksum to a GitHub Release. Publication requires an authorized tag/push; preparing files does not publish them.

### 9.9 Documentation and assets

README covers the popup image, GitHub zip/manual installation or build, three use steps, risks, known issues/manual checks, development/layout, adding a language and release procedure. PRIVACY describes actual local data handling; SECURITY provides private reporting guidance. CHANGELOG follows Keep a Changelog and SemVer. Release links point to the public GitHub repository.

The extension icon composes the unchanged Facebook, Instagram and YouTube SVGs supplied from thesvg.org. Six color/mono originals and source dates/hashes are kept in `public/brands/`; marks belong to Meta Platforms or Google and are excluded from MIT. The project is not affiliated with them. `assets/icon.svg` places the originals without changing paths, colors or aspect ratios. `bun run icons` uses Chromium to render 16/32/48/128 px PNGs and a light/dark preview; Chromium is required for the Instagram gradient. `bun run screenshots` captures fictional popup data with HTTP(S) blocked. Its encryption footer omission is disclosed in README because metadata is plaintext.

Only the referenced mockup HTML, README and runner remain tracked. Generated screenshots, GIFs and logs are ignored. Removing them reduces the current tracked tree; it does not rewrite historical Git objects.

### 9.10 Security and publication rules

No credentials, real account cookies, certificates, runtime secrets or remote services belong in the repo. A permission change must update the manifest, allow-list and privacy table together. Recommended repository protections include required CI and private vulnerability reporting. The owner controls repository creation, remote push and distribution.

## 10. Internationalization

`public/_locales/{en,th}/messages.json` supplies manifest messages and popup catalogs. Auto follows browser language, falling back to English; Settings can override it. Catalog keys and placeholders must match. Substitution text is escaped before the supported emphasis markup is applied. Locale tests enforce these rules. System fonts and wrapping support the 360 px layout.

To add a language, copy the English catalog, translate values without changing keys/placeholders, extend the language type, resolver/catalog and Settings options, then run locale, layout and full CI checks. A locale directory alone does not add a Settings choice. No new Thai prose is introduced by B7b.

## 11. Theme

System follows `prefers-color-scheme`; explicit Light/Dark sets `data-theme`. Preferences live in the local store. The popup mirrors theme into localStorage so the synchronous packaged `theme-boot.js` can apply it before the stylesheet. The stored preference wins when asynchronous state arrives. A missing/stale cache may initially paint the system or previous theme before reconciliation. Theme changes use Circle Reveal when supported; reduced-motion/no-support behavior is tested.

## 12. Motion

`popup/motion.ts`, controller actions and CSS implement theme reveal, tab/panel transitions, list changes, status changes, inline expansion, page changes and toasts with View Transitions and CSS. Timings are centralized; overlapping transitions are settled rather than leaving a stale owner. With reduced motion, transitions are skipped and spinner animations stop. Without View Transitions support, DOM updates still happen. These animations do not measure worker progress. The local mockup is a visual reference, not a live platform simulation.

## 13. TikTok proposal for v0.2.0

This section is a design proposal, not shipped TikTok support. Sections 1–12 describe v0.1.1 unless noted. No TikTok source, host permission, catalog entry or brand asset is added by this design card. The implementation cards below must update those sections and the privacy inventory together. Public-source checks and an anonymous browser visit were made on 2026-11-10; no real account was logged in, and no existing browser profile or another person's cookies were used.

### 13.1 Switching method and decision

Choose **cookie swap with encrypted snapshots and a per-platform journal**, extending the Facebook/Instagram path. This preserves the local-only architecture and can reuse attribute-preserving restore, busy locking and rollback. TikTok needs its own identity probe and a session-cookie allow-list; copying the Facebook adapter with a different `idCookie` is insufficient.

The alternative is navigating TikTok's own account switcher. No stable, documented account-selection URL comparable to YouTube's sign-in coordinates was verified. Automating a private UI would depend on selectors and account state. This does not establish that TikTok has no built-in account switching; the owner should compare the signed-in web UI during manual checks. [TikTok Login Kit](https://developers.tiktok.com/docs/en/login-kit-web) authorizes an application through OAuth and server-side token handling. It does not document switching the browser's TikTok website session and does not fit this extension's architecture.

Cookie swapping can fail when a session is bound to a device, revoked, rotated or challenged. Rollback restores local cookies; it cannot undo server-side invalidation. Before enabling the feature for release, the owner must test two owned accounts in a disposable browser profile: add/update both, alternate switches with ordinary navigation between them, restart the worker/browser, log one account out, and complete any manual challenge. Verify the current identity and preservation of device cookies without saving cookie values to logs. No real-account test is authorized by this card.

### 13.2 Cookie boundary and evidence

[TikTok's Cookies Policy](https://www.tiktok.com/legal/page/global/cookie-policy/en), under Functionality and customisation, identifies `sid_tt` as remembering login state. Its Safety and security section identifies `ttwid` and `security_verification_ticket` as security cookies. These are primary-source examples, not an exhaustive session schema. The anonymous visit confirmed the presence of `ttwid`, `msToken`, `tt_csrf_token` and `tt_chain_token` without login. Anonymous presence is evidence against treating them as a reliable account ID; it does not by itself establish every cookie's purpose.

| Group | Proposed names on `.tiktok.com` and its permitted HTTPS subdomains | Treatment and confidence |
|---|---|---|
| Session credentials | `sid_tt` | Capture/clear/restore as an encrypted session member. Login-state purpose is documented by TikTok; sufficiency for switching is unverified. |
| Candidate companion credentials | `sessionid`, `sessionid_ss`, `sid_guard`, `sid_ucp_v1`, `ssid_ucp_v1` | Candidate names for owner verification, not a confirmed required set. Admit a name to the session allow-list only after comparing the owner's two accounts and a logout/rotation case. No claim is made that every region emits these names. |
| Candidate account markers | `uid_tt`, `uid_tt_ss` | Candidate encrypted snapshot members, pending the same check. Do not interpret their values as a numeric user ID or use them alone to report success. |
| Browser/security state | `ttwid`, `msToken`, `security_verification_ticket`, `s_v_web_id`, `odin_tt`, `tt_chain_token`, `tt_csrf_token`, `passport_csrf_token`, `passport_csrf_token_default`, `x-web-secsdk-uid`, `gd_random` | Preserve by default; never import from a saved account. Only `ttwid` and `security_verification_ticket` have the policy classification above. The rest are a conservative preserve set, not verified anti-bot classifications. CSRF coupling to login is an open question; if preservation breaks switching, stop for a reviewed rule change rather than clearing more cookies. |
| Preferences, routing and multi-account state | `default_lang`, `locale`, `tiktok_webapp_theme`, `tiktok_webapp_theme_source`, `store-idc`, `tt-target-idc`, `tt-target-idc-sign`, `multi_sids`, all unknown names | Preserve. Routing and remembered-account behavior are unverified; do not use a deny-list that captures every new cookie. |

The candidate names are explicit design hypotheses, not observations of an authenticated session or sourced statements of TikTok's internal contract. This card cannot verify that set without crossing the no-login boundary. `sid_tt` is the only session name documented by the primary source checked here; no complete switching set is verified. Implementation/release acceptance requires owner confirmation of the companion set. A synthetic fixture only tests the chosen model.

Introduce a TikTok-specific session selection rule used consistently by snapshot, clear, restore, pre-switch save and journal recovery. Existing Facebook/Instagram filtering stays unchanged. Preserve host-only, domain/path, expiry, Secure, HttpOnly, SameSite and partition keys. Restrict restore to allowed names/domains and HTTPS; preserve all unlisted cookies, including multiple `msToken` variants. If the session set is empty or fully expired, refuse the switch. Do not record secret values in evidence, telemetry or error messages.

### 13.3 Read-only identity probe and expiry

Use injected `TabsApi`/`ScriptingApi` through the existing adapter, with `executeScript({ world: 'MAIN' })` in the top frame of an open HTTPS TikTok tab. Read existing page state or authenticated navigation elements only. Do not invoke a site function, submit a form, intercept traffic, call an endpoint or introduce `fetch`, XHR or another request from the extension. The page may make its own normal traffic.

The anonymous visit found `#__UNIVERSAL_DATA_FOR_REHYDRATION__`, a visible login control, and content-author IDs inside the feed. **A video author's ID is not the viewer's identity.** Do not use generic `author`, `/@handle` links, a viewed profile or an arbitrary `userInfo` record as the current account. A possible authenticated app-context/current-user store is an unverified selector/schema; an implementer must establish an explicit current-viewer field with the owner before enabling a success result. Read only a bounded object and return a validated stable account ID plus a signed-in/logged-out/challenge/unknown discriminator. Discard names, avatars, feed data and all unrelated state inside the page. Treat handles as mutable and never use them as the sole stable key.

`account.probe` must remain read-only: no new tab, reload, storage write or cookie change. With no suitable tab, return `no_tiktok_tab`; with an unrecognized page/state, return `tiktok_probe_unavailable`. Return a null identity only for a positively recognized logged-out state. Both cases must avoid labelling a saved session expired. A challenge takes precedence over a login prompt or missing data. Validate hostname/path and selector evidence; tentative challenge routes such as `/captcha` or `/verify` require manual confirmation, and a generic modal alone is insufficient.

Extend the cookie-platform contract with an injected current-identity probe used by add/update, unsaved-current detection and post-reload verification. The shared switcher currently reads `idCookie` directly at its pre-switch and verification stages; both stages need the hook. Facebook/Instagram retain their cookie-ID behavior. Store TikTok's verified stable viewer ID as plaintext `platformUserId`, with the user's label, while cookies remain encrypted. A missing identity cookie alone is not proof of server revocation.

After restoring and loading a TikTok page, compare its verified viewer ID with the saved target. A recognized logout or a different viewer yields `not_signed_in`/expired and attempted rollback; unknown state yields a probe error without marking the account expired. A challenge yields `checkpoint` and manual action. Keep popup unknown-outcome reconciliation and the existing worker deadline limitation. Save the server's latest rotated target snapshot after successful identity verification, and save the departing current session immediately before replacement. On an ambiguous or failed verification, do not overwrite a good saved snapshot with unverified cookies. Account identity and cookie state can race across tabs; use the platform lock, a before/after viewer check for capture, and fail closed on disagreement.

### 13.4 Permissions, update behavior and storage changes

Propose one new host pattern: `https://*.tiktok.com/*`, covering the apex and HTTPS subdomains needed for domain cookies, tab queries/reloads and the page reader. Keep the existing `cookies`, `storage` and `scripting` permissions. Do not add HTTP TikTok access, `tabs`, `<all_urls>`, TikTok CDN/advertising domains, webRequest or content scripts. If the owner finds a required authentication host outside this boundary, stop and review that requirement.

[Chrome's permission warning guidance](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings) says a warning-bearing permission increase can disable an installed extension pending acceptance. [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) includes host-pattern changes among warning triggers. Those packaged-update rules do not justify claiming the same prompt for a Load unpacked reload. [Chrome's older unpacked guidance](https://developer.chrome.com/docs/extensions/mv2/permission-warnings) explicitly says unpacked loads do not show permission warnings; it is historical MV2 guidance, not a verified current MV3 update result.

This project distributes unpacked folders through GitHub. Document the upgrade as replacing extracted files and reloading the same directory at `chrome://extensions`, then reviewing TikTok access in Details/Site access. Whether the current Chrome build disables it or prompts on that reload remains a manual acceptance check; do not promise either outcome from documentation alone. Test an existing v0.1.0 profile with fictional saved entries before/after upgrade, record Chrome version and actual consent UI, confirm granted access before any cookie write, and preserve the old data on denial/missing access. Test a new Load unpacked separately. Do not uninstall merely to upgrade.

The implementation must change manifest and `scripts/permissions.ts` together. Update `PRIVACY.md`'s cookies row to include TikTok, scripting row to include the minimal viewer reader, and add the new host row explaining cookie access, tab reloads and identity reading. Expand the encrypted-cookie data row, plaintext identity/status row and `journal.tiktok` inventory. Forgot-password wipe must remove TikTok entries/vault sessions while retaining YouTube; both wipes must clear its journal, lock and recovery state. Add a default `active.tiktok: null` when reading old v1 stores, preserve old accounts/quarantine and reject malformed TikTok entries without losing data. Test upgrade and wipe scopes. Encryption, session-key handling, local retention and absence of an extension backend/analytics remain unchanged. Website reload requests remain disclosed.

### 13.5 Rotating-session fixture and E2E acceptance

Add a local fake HTTPS TikTok host using fictional accounts and isolated test certificates. Extend the fixture harness's resolver, host routing and extension test manifest; CI must never visit the live site. The fixture must issue a new session generation **on every ordinary authenticated document load**, including reloads, not only on login. The next generation must resolve to the same stable viewer ID; invalid generations cannot impersonate another user. Define an explicit previous-token grace rule for concurrent loads and a strict invalidation mode, then test both. Serve a minimal viewer-state script and authenticated navigation separately from feed-author/profile data, so the reader can be tested against misleading content.

Acceptance includes two accounts alternating at least five times with normal navigation between switches; assertions on token-generation changes and server acceptance; the saved latest target and departing-session snapshot; device/security cookies unchanged; host-only/partitioned attributes; all TikTok tabs reloaded and unrelated tabs untouched; false viewer/author/profile traps; missing/malformed state; no-tab and denied-host errors. Revoke a saved session server-side, distinguish explicit logout from unknown page state, and verify rollback where the backup is still valid. Also invalidate the backup and assert a reported recovery failure with the journal retained, rather than a false recovery success.

Provide separate checkpoint/captcha controls that leave the operation in a visible manual-action state without automation. Test worker restart/journal recovery, busy concurrency, duplicate identity, lock/unlock, both wipe scopes, v0.1.0 migration, English/Thai layout and absence of independent extension requests. A client-only token change or a fixture accepting every stale token does not prove rotation support. This new fixture closes the TikTok rotation coverage gap; the existing Facebook/Instagram fixtures and their documented limit remain unchanged.

### 13.6 Risks and owner validation

TikTok may bind sessions to device/security state and require CAPTCHA, 2FA, re-login or additional checks after a swap. Preserving browser cookies can make a saved credential unusable; importing those cookies could damage other sessions, so automatic broadening is prohibited. Server rotation/revocation can make both target and rollback snapshots stale. Restrictions, temporary locks or account bans are possible; no claim is made about their frequency or avoidance. The owner must review TikTok's applicable terms and use disposable owned test accounts before deciding whether to ship.

A successful synthetic test proves behavior against the local model. It does not prove live TikTok compatibility, an authenticated viewer schema, complete cookie classification, regional routing, stable challenge selectors or safety from account enforcement. The owner must validate those items and update the confirmed set without sharing cookies/passwords. No CAPTCHA bypass, stealth patching, fingerprint spoofing, automated login or anti-bot evasion is proposed. All TikTok tabs in one profile share the switched session; unsaved page drafts can be lost. Existing popup timeouts and worker busy limitations continue to apply.

### 13.7 Logo sources and licence check

The [theSVG TikTok page](https://thesvg.org/icon/tiktok) embeds an ImageObject licence link to [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) for its default and mono variants. Both files were downloaded for hashing on 2026-11-10; the implementation card will copy the unmodified SVGs into `public/brands/` and add the date, source URLs and hashes to `public/brands/SOURCES.md`. They are not installed by this design card.

| Future file | Source URL | SHA-256 of downloaded bytes |
|---|---|---|
| `tiktok.svg` | https://thesvg.org/icons/tiktok/default.svg | `3e014b901b0de29d50e0b15c99fc563a21a8e538f2271fef8c9e404d3926d07b` |
| `tiktok-mono.svg` | https://thesvg.org/icons/tiktok/mono.svg | `6f54ac8d325faacea8935bdc44cbed60206a6b408641799e5fea1cba7c1a0af7` |

The licence declaration applies to the supplied drawing, not trademark rights or endorsement. TikTok's mark remains its owner's property, outside this project's MIT licence; update brand documentation and non-affiliation text. Recheck hashes/licence if upstream bytes change. Check for scripts, event handlers and external references before packaging; preserve geometry, colours and proportions. Verify the colour and mono marks at popup sizes in light/dark themes. The existing three-mark toolbar icon can remain for v0.2.0; changing it is a separate owner decision.

### 13.8 Catalog keys for Thai review

Draft English values for the lead to send to kru-thai; no Thai translation is added on this card. Add both catalogs together after approval and keep placeholder parity. Existing generic Add, Update session, checkpoint, expiry, lock, delete and switch messages can be reused with `TikTok` as the platform substitution.

| New key | English draft | Use |
|---|---|---|
| `platform_tiktok` | TikTok | Platform selector accessible name and account-list heading substitution. |
| `tiktok_note` | TikTok sessions are saved on this device. Switching changes the account in all TikTok tabs in this browser profile. | Account-list note. |
| `tiktok_risk` | TikTok may ask you to sign in again or complete a security check. Switching cannot prevent account restrictions. | Pre-save risk text. |
| `err_no_tiktok_tab` | Open tiktok.com in a tab, then try again. | Read-only probe has no suitable tab. |
| `err_tiktok_probe_unavailable` | The current TikTok account could not be verified. Open TikTok, check the signed-in account, then try again. | Unknown state, never an expiry claim. |
| `err_tiktok_permission` | Allow this extension to access TikTok in Chrome's extension settings, then try again. | Missing/withheld host access. |

All six keys have no placeholders. Update the existing extension description and any three-platform/wipe wording in both catalogs to include TikTok; submit the affected existing keys with their final English wording in the UI card. Do not append Thai text by machine translation. Check four-platform navigation, long Thai labels, narrow layouts and screen-reader names with locale parity tests.

### 13.9 Proposed implementation cards and dependencies

These are proposals for the lead to create; this design does not create or implement them. Each card needs fail-before-pass evidence, its own bounded commit, independent QC and the current integration base.

| Card | Single deliverable | Acceptance and dependency |
|---|---|---|
| T1: TikTok backend session lifecycle | Adapter, verified viewer probe, session allow-list, shared-switcher probe hook and store/journal integration, with unit tests. | Depends on owner confirmation of authenticated viewer fields and companion-cookie set. Test no-network read-only probe, domain/name boundaries, rotation resnapshot, unknown vs logout vs checkpoint, rollback, migration and wipes; preserve FB/IG/YT behavior, coverage ≥90%, check passes. Permission allow-list and PRIVACY inventory changes land atomically here with the new host; no popup feature enabled yet. |
| T2: TikTok rotation E2E | Local rotating TikTok fixture and browser scenarios from 13.5. | Depends on T1. Demonstrate fresh server generations on normal requests, five alternating switches, strict revocation/invalid-backup handling, misleading author IDs, checkpoints, isolation and no independent requests. E2E runs without live TikTok; close all browsers/servers. |
| T3: TikTok popup and reviewed language/assets | Enable the fourth platform, approved catalogs and unchanged sourced logos. | Depends on T1 + T2 and kru-thai approval. Wire new error results and permission guidance, add source hashes/trademark notices, check four-platform keyboard/Thai/theme layouts with screenshots and E2E. No live credentials in screenshots. |
| T4: v0.2.0 release documentation and verification | Reconcile documentation with the composed implementation. | Depends on T1–T3 and owner manual-account/upgrade observations. Re-audit PRIVACY against code, refresh README/known issues/design/CHANGELOG, record unsupported cases and exact version. Full CI/E2E/outdated gates and equal UTC/Bangkok package hashes; prepare GitHub zip/checksum. Tag/push/publication need separate authorization. |

The source/permission/privacy contract lands with T1, while T4 audits the final composition. Until the owner confirms the authenticated cookie/probe contract, T1 can develop against fakes but cannot claim live compatibility or enable an unverified success path.
