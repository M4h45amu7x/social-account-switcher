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
- Release tooling: a permission allow-list check and a deterministic Chrome Web Store zip with its SHA-256.
- GitHub Actions for CI and tagged releases, plus Dependabot.
- README, privacy policy, security policy and MIT license.
