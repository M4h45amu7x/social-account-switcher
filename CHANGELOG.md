# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing has been released yet. Version 0.1.0 in `package.json` is the development version.

### Added

- Project skeleton: Manifest V3 with the minimal permissions, a placeholder popup and an empty service worker.
- English UI strings with a Thai translation (`chrome.i18n`).
- Tooling: Bun, Vite, strict TypeScript, Biome, `bun test` with coverage, and Playwright end-to-end tests against the unpacked extension.
- Lint guard that keeps the `chrome` global inside the two adapter files (Biome rules plus `scripts/check-chrome-access.ts`), tested against samples in `tests/lint-fixtures/`.
- Core library (not wired to the UI yet):
  - `src/lib/cookies.ts` saves, clears and restores one platform's session cookies. Device cookies are left alone, host-only cookies stay host-only, expired cookies are skipped, and CHIPS partitioned cookies keep their partition.
  - `src/lib/vault.ts` encrypts saved sessions with a master password (PBKDF2-SHA-256, 600,000 iterations, AES-GCM-256, a new IV on every write).
  - `src/background/keyring.ts` keeps the unlocked key in `storage.session` only.
  - `src/lib/store.ts` holds the account list (schema v1, migration, duplicate and label checks) and the theme and language settings.
  - In-memory fakes of the Chrome APIs for unit tests, and a Chromium test of the cookie behaviour the library relies on.
- Facebook and Instagram switching in the service worker (not wired to the popup yet):
  - `src/background/switcher.ts` runs the switch steps of design 3.0. One lock per platform blocks a double press while Facebook and Instagram can switch at the same time. If the platform rejects the new session, the previous cookies go back and the account is marked expired. A checkpoint page is reported and left to the user.
  - `src/background/journal.ts` keeps an encrypted backup in `storage.session` during each switch, and a new service worker puts it back if the old one stopped halfway.
  - `src/lib/messages.ts` and `src/background/router.ts` accept only this extension's own pages and well-formed messages, and always answer with a Result. After five wrong master passwords, each attempt waits 30 seconds.
  - YouTube goes through a `YoutubeSwitcher` interface until card B4's code is wired in.
- YouTube switching through Google multi-login, wired into the service worker (`src/background/platforms/youtube.ts`):
  - Adding an account reads only `authuser` and `pageid` from the open YouTube tab. Switching points that tab at Google's signin URL, reads the page again once that navigation has loaded, then reloads the other YouTube tabs.
  - Only the load of the switch's own navigation counts: the first load after `tabs.update()` resolves, unless the tab visibly went to another path. A tab that ends up on Google's login page gives `not_signed_in`, and a tab closed during the switch is skipped. A Chromium test with a local server and real redirects covers these cases.
  - `next` is limited to 2,048 characters and 3 rounds of decoding.
  - YouTube messages take the same per-platform busy lock as Facebook and Instagram.
- Release tooling: a permission allow-list check and a deterministic Chrome Web Store zip with its SHA-256.
- GitHub Actions for CI and tagged releases, plus Dependabot.
- README, privacy policy, security policy and MIT license.
