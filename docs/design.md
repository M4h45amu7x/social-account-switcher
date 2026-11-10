# Social Account Switcher v0.2.0 implementation design

> Status: v0.2.0 release candidate, 2026-11-10. T1 through T3 are implemented and TikTok is enabled in the four-platform popup. Live TikTok account checks remain required before release; preparing this candidate does not publish it or establish checkpoint-free operation.
> Clickable reference: `mockup/popup.html`; runner: `mockup/e2e/popup.e2e.mjs`; instructions: `mockup/README.md`. Generated captures and run logs are not versioned. Small current popup images are in `docs/images/`.
> Repository prose is English. English and Thai are supported UI languages.

## 1. Goals and scope

Switch between the user's own Facebook, Instagram, YouTube and TikTok accounts from a 360 px Manifest V3 popup. Users perform website login and verification themselves. Facebook/Instagram/TikTok sessions are saved locally under password encryption; YouTube stores sign-in coordinates and uses Google's multi-account sign-in navigation.

There is no extension server, account sync, analytics, login automation, remote code, runtime dependency or incognito support. This version does not export/import saved sessions. It does not provide separate Facebook/Instagram/TikTok accounts in different tabs: cookies are shared within a browser profile. Messenger.com and other domains are outside the host permission list.

Distribution is a zip on GitHub Releases, installed with Chrome's Developer mode and Load unpacked. The repository is [M4h45amu7x/social-account-switcher](https://github.com/M4h45amu7x/social-account-switcher). The owner controls publication.

## 2. User flow

### 2.1 First open and adding an account

On first open, a missing vault always leads to master-password setup, including when the user intends to use only YouTube. The popup validates the password before sending it; the worker validates it again. Once set up, users sign in on a website themselves, choose its platform and press **Add the account I'm logged in to**. The probe returns an ID tail and optional profile name, handle, email and avatar from the captured tab. A captured display name prefills the account label; otherwise the popup uses its platform/ID fallback. Users can edit the 1 to 40 character label before saving. Duplicate identities are refused; **Update session** refreshes an existing entry after a new login. Profile capture is optional: unavailable metadata does not block a valid session save. See [profile sources](profile-sources.md) for the candidate fields and capture limits.

Which platform tab the popup opens on (v0.1.1, `src/popup/start.ts`): the platform of the active tab in the current window, else the tab the person picked last (the `platform` key in the popup's `localStorage`, written only when they click a tab), else Facebook. The popup reads the active tab's URL with `tabs.query({ active: true, currentWindow: true })`. Chrome fills in `url` only for hosts in the extension's host permissions, so no `tabs` or `activeTab` permission is needed and other sites stay invisible. `platformOfUrl` in `src/lib/sites.ts` matches the site's domain and its subdomains and nothing else (`facebook.com.evil.test`, `notfacebook.com` and `youtube.com@evil.test` are not matches). A unit test keeps popup tab patterns aligned with the host permission list. TikTok matches only HTTPS URLs on tiktok.com and its subdomains. The popup waits at most 150 ms for the answer before its first draw, so it never slides from one tab to another on its own; a late or failed answer falls back to the last pick. When the popup is over a supported site, the empty list and the add button skip **Open facebook.com** and say **Add the account on this tab**. After the list loads, `account.probe` names the saved account logged in there (`accountId`), and that row shows **On this tab** in place of **Active**. The popup captures the tab id from that same current-window query and sends it with contextual probe/add requests. YouTube and TikTok read only that tab, including when updating an entry; a missing id, closed tab or navigation away from the platform returns not-found instead of selecting another window. Contextual Facebook/Instagram requests also check that the captured tab still belongs to the platform before reading the profile's shared cookies. A locked popup keeps the chosen tab through unlocking.

### 2.2 Switching

A locked popup requires unlocking for all platforms, including YouTube; the backend YouTube switch itself does not need the vault key. Selecting a saved row starts a request. Before replacing an unsaved Facebook/Instagram/TikTok login, the popup offers to save it or switch anyway. Progress labels advance on a timer while the worker runs, rather than reporting actual completed operations. The worker's reply determines success, reloaded-tab count and the active badge.

Request deadlines belong to the popup (section 8.2). A timeout is an unknown outcome and does not cancel the worker. The popup reads state to reconcile, marks it stale if that read fails, and offers a read-only retry. It does not automatically replay a timed-out write.

### 2.3 Rename and remove

Pencil/edit and delete controls operate inline. Labels are local; empty or overlong labels are refused. Rename, even to the same text, makes a label custom. Update replaces profile metadata and clears unavailable fields, refreshes automatic labels and preserves custom or legacy labels. Deleting an entry removes its saved data without logging the website out or deleting the website account. Enter/Esc and focus return are covered by popup tests; browser alert/confirm/prompt dialogs are not used.

### 2.4 Session errors

An expired session or identity mismatch leads to a login/update message. Complete website login yourself, then choose **Update session**. A checkpoint means the website requires a manual security check; the extension does not bypass it. A checkpoint result can leave the target account active pending that check. Rollback is attempted for relevant failed cookie switches, not guaranteed for every possible browser failure.

### 2.5 Lock and wipe

**Lock now** deletes the unlocked key and worker cache. **Forgot password** deletes the vault and Facebook/Instagram/TikTok entries and all optional profiles and quarantine while retaining YouTube shortcuts and preferences; an unreadable store is removed whole. YouTube coordinates and custom labels remain, while automatic labels reset to “YouTube”. **Settings → Wipe all data** removes the entire local store. Both confirmed wipes clear the key, unlock-attempt record and journals, and are refused while a platform is busy. The popup returns to setup when the vault is absent. See `PRIVACY.md` for storage and retention limits.

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

Facebook, Instagram and TikTok have separate platform locks and separate journals. A store mutex serializes read/modify/write updates. YouTube also has a busy guard in the router. Service worker restart resets in-worker busy state while Chrome's session storage can retain the key and recovery journal. Browser restart or extension reload clears session storage, so cross-restart rollback is not promised.

## 4. Permissions

The source of truth is `src/manifest.json`, constrained by `scripts/permissions.ts` and the permission table in `PRIVACY.md`.

| Permission | Purpose |
|---|---|
| `cookies` | Read/remove/set Facebook, Instagram and TikTok cookies through the cookie port. |
| `storage` | Local store and session key/journals/unlock-attempt state. No sync storage. |
| `scripting` | Read YouTube sign-in coordinates, the candidate TikTok viewer state and optional account profile fields on all four platforms in MAIN world. |
| `*://*.facebook.com/*` | Facebook cookie access and tab identification/reloads. |
| `*://*.instagram.com/*` | Instagram cookie access and tab identification/reloads. |
| `*://*.youtube.com/*` | YouTube scripting and tab identification/navigation/reloads. |
| `https://*.tiktok.com/*` | TikTok cookie access, viewer reading and tab identification/reloads. |

There is no Google-domain permission, all-sites permission, content script, externally-connectable entry or network interception. Host permissions suffice for the relevant tab queries; there is no `tabs` permission. The MV3 default CSP applies. `incognito` is `not_allowed`. Vite supplies the manifest version from package.json and targets the declared Chrome 119 minimum.

## 5. Data model and retention

`lib/store.ts` defines `StoreV1`, stored under `store` in `storage.local`: schema version, accounts, active ID by platform, settings, vault and optional `quarantine`. Account metadata includes label/initials/internal ID/platform/user ID or YouTube coordinates/status and timestamps, plus optional profile fields and label source. Metadata and settings are plaintext. Profile fields are sanitized on load. Avatars are bounded, decoded and re-encoded locally as PNG before saving; original image bytes and metadata are not retained. See [profile sources](profile-sources.md).

The vault contains KDF parameters, salt, IV, ciphertext and an encrypted password-check value. Its decrypted `SessionMap` maps saved entry IDs to cookie arrays and capture times. Each journal (`journal.facebook`/`journal.instagram`/`journal.tiktok`) contains encrypted backup cookies plus plaintext IDs, platform and start time. `storage.session.vaultKey` holds the raw key as base64. `unlockFailures` holds wrong-attempt count and time. The popup caches `theme` in its own localStorage for first paint and `platform` for the last manually selected tab.

Loading defaults unknown settings, retains invalid/duplicate account records unchanged in quarantine, and refuses unknown schemas or malformed vaults without silently overwriting them. Both wipes remove quarantine and optional profiles; forgot-password wipe retains YouTube shortcuts and preferences, while all-data wipe removes the store. See `PRIVACY.md` for the complete data inventory and deletion behavior.

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

The maintained list is [known-issues.md](known-issues.md): YouTube navigation races/index shifts, a stuck browser API retaining worker busy state, timer-driven progress labels, unconfirmed live TikTok schema/cookie policy, optional profile and CDN-avatar limits, simulated-site coverage and browser/installation evidence limits. Logout, server revocation, website changes and risk checks can invalidate stored sessions. Reloading tabs can lose unsaved website drafts. Removing a local entry does not sign the website out. Backups and OS/browser inspection are outside the encryption guarantee.

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
29. TikTok: save two owned test accounts and alternate between them three times, checking the visible signed-in account and every open TikTok tab. Restart the browser, unlock and switch again. Record re-login, CAPTCHA or other security checks. Confirm the candidate viewer fields and selected cookie boundary on the live site.
30. On each of the four platforms, Add over the signed-in page, inspect the captured name/handle/avatar, rename and switch. During expired-session recovery, use **Update session** when offered and confirm the custom name survives. Record that check as untested if the button is unavailable. Metadata must match the viewer; unreadable avatars should fall back to initials.
31. Upgrade an existing v0.1.x unpacked folder in place, reload at `chrome://extensions`, and review TikTok Site access. Record any consent UI and confirm saved entries remain. Check a fresh Load unpacked installation separately.

### 8.4 Delivery boundaries

B1 through B6 provide the shell, core storage/crypto, platform adapters, router, popup wiring and local fake-site E2E. B7a supplies icons/screenshots/GitHub documentation. B7b reconciles privacy/design/known issues and removes generated evidence from the tracked tree. Final integration, tag creation and owner handoff remain lead responsibilities. Test-account and hosted-runner checks are not inferred from local passing tests.

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

The extension icon composes the unchanged Facebook, Instagram and YouTube SVGs supplied from thesvg.org. Eight color/mono originals for all four platforms and source dates/hashes are kept in `public/brands/`; marks belong to Meta Platforms, Google or TikTok and are excluded from MIT. The project is not affiliated with, endorsed by or sponsored by them. `assets/icon.svg` places the originals without changing paths, colors or aspect ratios. `bun run icons` uses Chromium to render 16/32/48/128 px PNGs and a light/dark preview; Chromium is required for the Instagram gradient. `bun run screenshots` captures fictional popup data with HTTP(S) blocked. Account metadata is plaintext.

Only the referenced mockup HTML, README and runner remain tracked. Generated screenshots, GIFs and logs are ignored. Removing them reduces the current tracked tree; it does not rewrite historical Git objects.

### 9.10 Security and publication rules

No credentials, real account cookies, certificates, runtime secrets or remote services belong in the repo. A permission change must update the manifest, allow-list and privacy table together. Recommended repository protections include required CI and private vulnerability reporting. The owner controls repository creation, remote push and distribution.

## 10. Internationalization

`public/_locales/{en,th}/messages.json` supplies manifest messages and popup catalogs. Auto follows browser language, falling back to English; Settings can override it. Catalog keys and placeholders must match. Substitution text is escaped before the supported emphasis markup is applied. Locale tests enforce these rules. System fonts and wrapping support the 360 px layout.

To add a language, copy the English catalog, translate values without changing keys/placeholders, extend the language type, resolver/catalog and Settings options, then run locale, layout and full CI checks. A locale directory alone does not add a Settings choice. TikTok catalog values use the ten English/Thai messages approved through kru-thai and the lead.

## 11. Theme

System follows `prefers-color-scheme`; explicit Light/Dark sets `data-theme`. Preferences live in the local store. The popup mirrors theme into localStorage so the synchronous packaged `theme-boot.js` can apply it before the stylesheet. The stored preference wins when asynchronous state arrives. A missing/stale cache may initially paint the system or previous theme before reconciliation. Theme changes use Circle Reveal when supported; reduced-motion/no-support behavior is tested.

## 12. Motion

`popup/motion.ts`, controller actions and CSS implement theme reveal, tab/panel transitions, list changes, status changes, inline expansion, page changes and toasts with View Transitions and CSS. Timings are centralized; overlapping transitions are settled rather than leaving a stale owner. With reduced motion, transitions are skipped and spinner animations stop. Without View Transitions support, DOM updates still happen. These animations do not measure worker progress. The local mockup is a visual reference, not a live platform simulation.

## 13. TikTok implementation for v0.2.0

T1 provides the implemented cookie backend and TikTok host permission, T2 supplies local rotating-session browser tests, and T3 enables TikTok in the four-platform popup with a candidate hydration reader. T4 prepares the v0.2.0 release candidate. Owner real-account checks remain required before release; fixture results do not establish live TikTok compatibility. Public-source checks and an anonymous browser visit were made on 2026-11-10; no real account was logged in, and no existing browser profile or another person's cookies were used.

The 360 px popup gives the selected platform enough width for its full name; inactive tabs show their logo and account count. Hiding inactive names as whole words avoids the truncated names rejected by the owner while preserving all four platform choices. Every tab keeps its full tooltip and accessible name. The shared indicator follows the selected button's geometry, and arrow keys, Home and End select tabs. Reduced motion moves the indicator immediately.

### 13.1 Switching method and decision

TikTok uses cookie swaps with encrypted snapshots and a per-platform journal, extending the Facebook/Instagram path. It reuses attribute-preserving restore, busy locking and rollback, with its own identity probe and centralized cookie deny-list.

The alternative is navigating TikTok's own account switcher. No stable, documented account-selection URL comparable to YouTube's sign-in coordinates was verified. Automating a private UI would depend on selectors and account state. This does not establish that TikTok has no built-in account switching; the owner should compare the signed-in web UI during manual checks. [TikTok Login Kit](https://developers.tiktok.com/docs/en/login-kit-web) authorizes an application through OAuth and server-side token handling. It does not document switching the browser's TikTok website session and does not fit this extension's architecture.

Cookie swapping can fail when a session is bound to a device, revoked, rotated or challenged. Rollback restores local cookies; it cannot undo server-side invalidation. Before enabling the feature for release, the owner must test two owned accounts in a disposable browser profile: add/update both, alternate switches with ordinary navigation between them, restart the worker/browser, log one account out, and complete any manual challenge. Verify the current identity and preservation of device cookies without saving cookie values to logs. No real-account test is authorized by this card.

### 13.2 Cookie boundary and evidence

[TikTok's Cookies Policy](https://www.tiktok.com/legal/page/global/cookie-policy/en), under Functionality and customisation, identifies `sid_tt` as remembering login state. Its Safety and security section identifies `ttwid` and `security_verification_ticket` as security cookies. These are primary-source examples, not an exhaustive session schema. The anonymous visit confirmed the presence of `ttwid`, `msToken`, `tt_csrf_token` and `tt_chain_token` without login. Anonymous presence is evidence against treating them as a reliable account ID; it does not by itself establish every cookie's purpose.

The owner supplied cookie names observed while signed in on 2026-11-10, without values. These observations replace the companion-name hypotheses. They establish presence only: the screenshots may omit rows, and neither purpose nor a sufficient switching set was verified. No cookie values were requested or accessed. The lead selected a deny-list so an unknown login companion is included automatically. This deliberately captures some preferences and SDK state as well as credentials.

| Observed domain | Names | Treatment and reason |
|---|---|---|
| `.tiktok.com` | `ttwid`, `msToken`, `s_v_web_id`, `tt_chain_token` | Preserve all copies as browser/security state under the selected policy. Anonymous presence and names alone do not prove their exact purpose. |
| `.tiktok.com` | `odin_tt` | Preserve conservatively as possible browser/security correlation state. There is no two-account evidence supporting import from a saved account. Its device binding remains unverified. |
| `.tiktok.com` | `sid_tt`, `sessionid`, `sessionid_ss`, `sid_guard`, `sid_ucp_v1`, `ssid_ucp_v1`, `uid_tt`, `uid_tt_ss`, `cmpl_token`, `passport_auth_status`, `passport_auth_status_ss`, `tt_session_tlb_tag` | Swap in the encrypted snapshot. Only `sid_tt` has the documented login purpose above; the remaining names are observed companions with unverified roles. Never derive the viewer identity from them. |
| `.tiktok.com` | `tt_csrf_token` | Swap with the session, along with any otherwise unlisted CSRF cookies such as `passport_csrf_token`. This keeps potentially session-coupled CSRF state together. Coupling is a hypothesis requiring owner validation; CSRF values are never used as identity. |
| `.tiktok.com` | `multi_sids` | Swap without parsing it. Leaving the current remembered-account list beside a restored session could mix account-selection state. Native account-menu behavior and the consequences of replacing this list require owner testing. It is encrypted and is not an identity source. |
| `.tiktok.com` | `myCookie`, `store-country-code`, `store-country-code-src`, `store-country-sign`, `store-idc`, `tt-target-idc`, `tt-target-idc-sign` | Swap under the default rule. These names may include routing or other non-session state; their roles and regional effects remain unverified. |
| `.www.tiktok.com` | `delay_guest_mode_vid`, `fbm_1862952583919182`, `fbsr_1862952583919182`, `passport_fe_beating_status`, `tiktok_webapp_theme`, `tiktok_webapp_theme_source` | Swap under the default rule, including preferences and apparent Facebook SDK state on TikTok. Presence does not establish a required TikTok credential. |
| Host-only `www.tiktok.com` | `msToken`, `tt_ticket_guard_has_set_public_key` | Preserve. The name of the ticket-guard flag suggests a key relationship but does not prove one. Preserve same-profile state; do not read, copy, reset or generate page-storage keys. Unknown key binding can still prevent switching. |
| Host-only `www.tiktok.com` | `g_state`, `guest_mode_flag`, `last_login_method`, `last_visited_page` | Swap under the default rule, with the same uncertainty about identity versus preference/SDK state. |

`TIKTOK_EXPERIMENT.preservedCookieNames` is the single policy configuration: `ttwid`, `msToken`, `s_v_web_id`, `tt_chain_token`, `odin_tt`, `tt_ticket_guard_has_set_public_key`, `security_verification_ticket`, `x-web-secsdk-uid`, `gd_random`. The last three were not in the owner's visible list; they retain the prior conservative security policy. This is a reviewed policy decision, not a confirmed classification of TikTok internals. Both host-only and domain `msToken` copies stay untouched, as do partitioned copies of every preserved name. All other names, including future unknown names, enter the encrypted snapshot.

Snapshot, clear, scoped restore, pre-switch save and journal recovery use the same rule. Existing Facebook/Instagram filtering stays unchanged. Only TikTok domains and valid subdomain names are accepted; suffix lookalikes and URL-like forged domains are rejected. Cookie API URLs use HTTPS even for cookies without the Secure attribute; restore preserves the captured Secure attribute rather than discarding those cookies. Preserve host-only, domain/path, expiry, HttpOnly, SameSite and partition keys. Reject preserved names in a supplied snapshot or journal backup. Journal and rollback cover the entire selected set, including unknown companions and `multi_sids`. If that set is empty or fully expired, refuse the switch. Never record secret values in evidence, telemetry or errors.

### 13.3 Read-only identity probe and expiry

Use injected `TabsApi`/`ScriptingApi` through the existing adapter, with `executeScript({ world: 'MAIN' })` in the top frame of an open HTTPS TikTok tab. The implemented reader reads the candidate hydration state only; it has no navigation-element fallback. Do not invoke a site function, submit a form, intercept traffic, call an endpoint or introduce `fetch`, XHR or another request from the extension. The page may make its own normal traffic.

The anonymous visit found `#__UNIVERSAL_DATA_FOR_REHYDRATION__`, a visible login control, and content-author IDs inside the feed. **A video author's ID is not the viewer's identity.** Do not use generic `author`, `/@handle` links, a viewed profile or an arbitrary `userInfo` record as the current account. The identity reader uses the candidate `#__UNIVERSAL_DATA_FOR_REHYDRATION__` → `__DEFAULT_SCOPE__["webapp.app-context"].user` object. It accepts a string `uid` of 1 to 32 digits with no leading zero, and a `uniqueId` of 1 to 128 ASCII letters, digits, underscores or periods. The identity probe validates the handle but discards it from its result. Hydration text is limited to 1,048,576 characters before parsing. The identity reader returns only the stable ID or a logged-out/challenge/unknown state. Separately, the optional profile reader reads `nickname`, `uniqueId` and `avatar` from that same validated candidate user, with identity confirmation before saving. It has no DOM/author/visited-profile fallback. Remote avatar URLs remain inside the page; only bounded embedded image data or pixels from an already loaded image can leave it. See [profile sources](profile-sources.md). The fixture confirms this implementation contract, including misleading author records, but the owner has not confirmed that the authenticated live site uses these fields or types. Handle changes must not change account identity.

Contextual TikTok probe/add/update requests must supply a `tabId`; missing IDs fail without querying another window. The reader gets that exact tab and validates its HTTPS TikTok URL, including a check after scripting. Internal switch capture without popup context queries only an active TikTok tab in the current window and refuses to fall back elsewhere. Post-load verification continues to read the exact loaded tab.

`account.probe` must remain read-only: no new tab, reload, storage write or cookie change. With no suitable tab, return `no_tiktok_tab`; with an unrecognized page/state, return `tiktok_probe_unavailable`. Return a null identity only for a positively recognized logged-out state. Both cases must avoid labelling a saved session expired. A challenge takes precedence over a login prompt or missing data. The candidate reader checks `#captcha_container`, `#verifyEle` and `[data-e2e="captcha"]`; their meaning on the live site remains unconfirmed. A positive logged-out state requires app-context `isLogin: false` with a null or empty `user`. Other absent, malformed or conflicting fields remain unknown. The owner must confirm these assumptions; a generic modal alone is insufficient.

T1 extends the cookie-platform contract with an injected current-identity probe used by add/update, unsaved-current detection and post-reload verification. Facebook/Instagram retain their cookie-ID behavior. T3 removes the synthetic `__SAM_TIKTOK_VIEWER__` sentinel and enables the candidate hydration reader in the popup. Store TikTok's verified stable viewer ID as plaintext `platformUserId`, with the user's label, while cookies remain encrypted. A missing identity cookie alone is not proof of server revocation.

After restoring and loading a TikTok page, compare its verified viewer ID with the saved target. A recognized logout or a different viewer yields `not_signed_in`/expired and attempted rollback; unknown state yields a probe error without marking the account expired. A challenge yields `checkpoint` and manual action. Keep popup unknown-outcome reconciliation and the existing worker deadline limitation. Save the server's latest rotated target snapshot after successful identity verification, and save the departing current session immediately before replacement. On an ambiguous or failed verification, do not overwrite a good saved snapshot with unverified cookies. Account identity and cookie state can race across tabs; use the platform lock, a before/after viewer check for capture, and fail closed on disagreement.

### 13.4 Permissions, update behavior and storage changes

T1 adds one host pattern: `https://*.tiktok.com/*`, covering the apex and HTTPS subdomains needed for domain cookies, tab queries/reloads and the page reader. Keep the existing `cookies`, `storage` and `scripting` permissions. Do not add HTTP TikTok access, `tabs`, `<all_urls>`, TikTok CDN/advertising domains, webRequest or content scripts. If the owner finds a required authentication host outside this boundary, stop and review that requirement.

[Chrome's permission warning guidance](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings) says a warning-bearing permission increase can disable an installed extension pending acceptance. [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) includes host-pattern changes among warning triggers. Those packaged-update rules do not justify claiming the same prompt for a Load unpacked reload. [Chrome's older unpacked guidance](https://developer.chrome.com/docs/extensions/mv2/permission-warnings) explicitly says unpacked loads do not show permission warnings; it is historical MV2 guidance, not a verified current MV3 update result.

This project distributes unpacked folders through GitHub. Document the upgrade as replacing extracted files and reloading the same directory at `chrome://extensions`, then reviewing TikTok access in Details/Site access. Whether the current Chrome build disables it or prompts on that reload remains a manual acceptance check; do not promise either outcome from documentation alone. Test an existing v0.1.0 profile with fictional saved entries before/after upgrade, record Chrome version and actual consent UI, confirm granted access before any cookie write, and preserve the old data on denial/missing access. Test a new Load unpacked separately. Do not uninstall merely to upgrade.

T1 changes the manifest, `scripts/permissions.ts` and `PRIVACY.md` together. The cookies row includes TikTok, the scripting row describes the bounded candidate hydration reader, and the host row describes cookie and viewer access. The data inventory includes encrypted TikTok cookies, plaintext identity/status and `journal.tiktok`. Forgot-password wipe removes TikTok entries/vault sessions while retaining YouTube shortcuts; both wipes clear its journal and unlocked key, and refuse to run while a platform is busy. Old v1 stores receive a default `active.tiktok: null`; loading preserves old accounts and quarantines invalid records without silently overwriting them. Wipe scopes and migration have automated coverage. Encryption, session-key handling, local retention and absence of an extension backend/analytics remain unchanged. Website reload requests remain disclosed.

### 13.5 Rotating-session fixture and E2E acceptance

T2 implements a local fake HTTPS TikTok host using fictional accounts and isolated test certificates, with resolver, host routing and test-manifest support. CI uses this local model. The fixture issues a new session generation on every ordinary authenticated document load, including reloads, and retains the stable viewer ID. It includes a previous-token grace rule for concurrent loads and a strict invalidation mode. Viewer-state and feed-author/profile data are separate so tests can exercise misleading content.

The browser scenarios cover two accounts alternating at least five times with normal navigation between switches; assertions on token-generation changes and server acceptance; the saved latest target and departing-session snapshot; device/security cookies unchanged; host-only/partitioned attributes; all TikTok tabs reloaded and unrelated tabs untouched; false viewer/author/profile traps; missing/malformed state; no-tab and denied-host errors. They also cover server-side revocation, explicit logout versus unknown state, rollback with a valid backup, and recovery failure with an invalid backup and retained journal.

Separate checkpoint/captcha controls exercise the manual-action state. Automated coverage includes worker restart/journal recovery, busy concurrency, duplicate identity, lock/unlock, both wipe scopes, v0.1.0 migration, English/Thai layout and absence of independent extension requests. A client-only token change or a fixture accepting every stale token does not prove rotation support. This new fixture closes the TikTok rotation coverage gap; the existing Facebook/Instagram fixtures and their documented limit remain unchanged.

### 13.6 Risks and owner validation

TikTok may bind sessions to device/security state and require CAPTCHA, 2FA, re-login or additional checks after a swap. Preserving the deny-listed browser cookies can make a saved credential unusable. The default capture rule also moves unknown preferences, routing and SDK state, which may affect other account-related behavior. Changes to the preserved set require review; there is no automatic retry that clears it. Server rotation/revocation can make both target and rollback snapshots stale. Restrictions, temporary locks or account bans are possible; no claim is made about their frequency or avoidance. The owner must review TikTok's applicable terms and use disposable owned test accounts before deciding whether to ship.

A successful synthetic test proves behavior against the local model. It does not prove live TikTok compatibility, an authenticated viewer schema, complete cookie classification, regional routing, stable challenge selectors or safety from account enforcement. The owner must validate those items and update the confirmed set without sharing cookies/passwords. The extension has no CAPTCHA bypass, stealth patching, fingerprint spoofing, automated login or anti-bot evasion. All TikTok tabs in one profile share the switched session; unsaved page drafts can be lost. Existing popup timeouts and worker busy limitations continue to apply.

### 13.7 Logo sources and licence check

The [theSVG TikTok page](https://thesvg.org/icon/tiktok) embeds an ImageObject licence link to [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) for its default and mono variants. T3 copies the unmodified SVGs into `public/brands/`, with their 2026-11-10 fetch date, URLs and hashes in `public/brands/SOURCES.md`.

| File | Source URL | SHA-256 of downloaded bytes |
|---|---|---|
| `tiktok.svg` | https://thesvg.org/icons/tiktok/default.svg | `3e014b901b0de29d50e0b15c99fc563a21a8e538f2271fef8c9e404d3926d07b` |
| `tiktok-mono.svg` | https://thesvg.org/icons/tiktok/mono.svg | `6f54ac8d325faacea8935bdc44cbed60206a6b408641799e5fea1cba7c1a0af7` |

The licence declaration applies to the supplied drawing, not trademark rights or endorsement. TikTok's mark remains its owner's property, outside this project's MIT licence. This project is not affiliated with, endorsed by or sponsored by TikTok. Recheck hashes/licence if upstream bytes change. Check for scripts, event handlers and external references before packaging; preserve geometry, colours and proportions. Verify the colour and mono marks at popup sizes in light/dark themes. The existing three-mark toolbar icon remains unchanged; changing it is a separate owner decision.

### 13.8 Catalog keys and Thai approval

T3 uses the exact English values below and the Thai values approved through kru-thai and the lead. Both catalogs retain key and placeholder parity. Existing generic Add, Update session, checkpoint, expiry, lock, delete and switch messages can be reused with `TikTok` as the platform substitution.

| New key | Approved English | Use |
|---|---|---|
| `platform_tiktok` | TikTok | Platform selector accessible name and account-list heading substitution. |
| `tiktok_note` | TikTok sessions are saved on this device. Switching changes the account in all TikTok tabs in this browser profile. | Account-list note. |
| `tiktok_risk` | TikTok may ask you to sign in again or complete a security check. Switching cannot prevent account restrictions. | Pre-save risk text. |
| `err_no_tiktok_tab` | Open tiktok.com in a tab, then try again. | Read-only probe has no suitable tab. |
| `err_tiktok_probe_unavailable` | The current TikTok account could not be verified. Open TikTok, check the signed-in account, then try again. | Unknown state, never an expiry claim. |
| `err_tiktok_permission` | Allow this extension to access TikTok in Chrome's extension settings, then try again. | Missing/withheld host access. |

All six keys have no placeholders. The approved existing keys `extDescription`, `lock_sub`, `wipe_detail` and `setup_sub` now include TikTok in both catalogs. Additional error wording uses reviewed English until a Thai value is approved; no Thai text is machine-translated. Locale and layout checks cover four-platform navigation, full visible names, themes and accessible names.

### 13.9 Implementation cards and dependencies

T1, T2 and T3 are implemented in this candidate. T4 prepares release documentation and packaging; owner live-account validation remains required before publication. The table preserves the original card scopes and acceptance criteria. T1 originally kept the backend disabled; T3 subsequently enabled it in the popup.

| Card | Single deliverable | Acceptance and dependency |
|---|---|---|
| T1: TikTok backend session lifecycle | Disabled adapter, synthetic viewer probe, centralized cookie deny-list, shared-switcher probe hook and store/journal integration, with unit tests. | Developed against fakes using owner-observed cookie names; enabling live support still depends on owner confirmation of authenticated viewer fields and the selected cookie boundary. Test no-network read-only probe, domain/name boundaries, rotation resnapshot, unknown vs logout vs checkpoint, rollback, migration and wipes; preserve FB/IG/YT behavior, coverage ≥90%, check passes. Permission allow-list and PRIVACY inventory changes land atomically here with the new host; no popup feature enabled yet. |
| T2: TikTok rotation E2E | Local rotating TikTok fixture and browser scenarios from 13.5. | Depends on T1. Demonstrate fresh server generations on normal requests, five alternating switches, strict revocation/invalid-backup handling, misleading author IDs, checkpoints, isolation and no independent requests. E2E runs without live TikTok; close all browsers/servers. |
| T3: TikTok popup and reviewed language/assets | Enable the fourth platform, approved catalogs and unchanged sourced logos. | Depends on T1 + T2; the ten catalog values have kru-thai approval. Wire new error results and permission guidance, add source hashes/trademark notices, check four-platform keyboard/Thai/theme layouts with screenshots and E2E. No live credentials in screenshots. |
| T4: v0.2.0 release documentation and verification | Reconcile documentation with the composed implementation. | Depends on T1 through T3. Record outstanding owner manual-account/upgrade checks. Re-audit PRIVACY against code, refresh README/known issues/design/CHANGELOG, record unsupported cases and exact version. Full CI/E2E/outdated gates and equal UTC/Bangkok package hashes; prepare GitHub zip/checksum. Tag/push/publication need separate authorization. |

The source/permission/privacy contract was implemented through T1 and T3; T4 audits the final composition. The v0.2.0 candidate enables TikTok against the strictly validated candidate reader. Owner confirmation of the live authenticated viewer fields, challenge evidence and cookie policy remains a release requirement; fixture success alone does not satisfy it.
