# Social Account Switcher — v0.1.0 implementation design

> Status: v0.1.0 implementation and GitHub handoff specification, 2026-11-10. Live account checks remain manual; this document does not claim publication or checkpoint-free operation.
> Clickable reference: `mockup/popup.html`; runner: `mockup/e2e/popup.e2e.mjs`; instructions: `mockup/README.md`. Generated captures and run logs are not versioned. Small current popup images are in `docs/images/`.
> Repository prose is English. English and Thai are supported UI languages.

## 1. Goals and scope

Switch between the user's own Facebook, Instagram and YouTube accounts from a 360 px Manifest V3 popup. Users perform website login and verification themselves. Facebook/Instagram sessions are saved locally under password encryption; YouTube stores sign-in coordinates and uses Google's multi-account sign-in navigation.

There is no extension server, account sync, analytics, login automation, remote code, runtime dependency or incognito support. This version does not export/import saved sessions. It does not provide separate Facebook/Instagram accounts in different tabs: cookies are shared within a browser profile. Messenger.com and other domains are outside the host permission list.

Distribution is a zip on GitHub Releases, installed with Chrome's Developer mode and Load unpacked. The owner creates the destination repository and publishes it. No remote or account identity is inferred by the implementation.

## 2. User flow

### 2.1 First open and adding an account

On first open, a missing vault always leads to master-password setup, including when the user intends to use only YouTube. The popup validates the password before sending it; the worker validates it again. Once set up, users sign in on a website themselves, choose its platform and press **Add the account I'm logged in to**. The probe reports an ID tail, not a profile name or photo. The user supplies a label of 1–40 characters. Duplicate identities are refused; **Update session** refreshes an existing entry after a new login.

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
8. The master password is excluded from HTML markup and cleared from popup state when setup/unlock is sent. The input's DOM property can retain it until the next redraw; disabling the field while waiting is planned for v0.1.1. See the security-hardening item in [known issues](known-issues.md).

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

`scripts/zip.ts` checks the manifest permission allow-list, the permission table in `PRIVACY.md` and the manifest/package version match. It rejects source maps and code matching its forbidden patterns for remote scripts/imports, dynamic evaluation and direct network APIs. It does not check that required locale files exist. It sorts archive entries and fixes timestamps, producing `release/social-account-switcher-v<version>.zip` and its SHA-256 file with the manifest at archive root. Two unchanged builds must produce the same checksum.

### 9.8 Workflows

`ci.yml` runs on main pushes and pull requests with read-only permissions: frozen install, typecheck, lint, unit coverage, build, permission check, browser install with dependencies, full E2E, zip and artifact upload. Failure retains browser reports. `release.yml` runs on `v*` tags, checks that the tag equals the package version, runs the gates and uses its job-scoped contents-write permission to attach zip and checksum to a GitHub Release. Publication requires an authorized tag/push; preparing files does not publish them.

### 9.9 Documentation and assets

README covers the popup image, GitHub zip/manual installation or build, three use steps, risks, known issues/manual checks, development/layout, adding a language and release procedure. PRIVACY describes actual local data handling; SECURITY provides private reporting guidance. CHANGELOG follows Keep a Changelog and SemVer. Repository URL placeholders remain until the owner creates the destination.

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
