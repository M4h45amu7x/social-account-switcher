# Social Account Switcher

A Chrome extension (Manifest V3) for people who run more than one Facebook, Instagram or YouTube account. Pick an account in the popup and the open tabs reload as that account. You don't have to log out and back in.

> Status: early development (v0.1.0). This version is the project skeleton. It loads and shows a placeholder popup, and it can't switch accounts yet. The design and the build plan are in [`docs/design.md`](docs/design.md). A clickable mockup of the finished popup is in [`mockup/popup.html`](mockup/popup.html).

## How it will work

- Facebook and Instagram: you log in yourself, then press "Add this account". The extension saves that account's session cookies on your device, encrypted with a master password. Switching puts the saved cookies back and reloads the site's tabs.
- YouTube: the extension uses Google's built-in multi-account sign-in (`authuser`). It never touches Google cookies, so Gmail and other Google services stay on the account they're already using.
- It never stores your passwords and never fills in login forms.
- There's no server and no analytics, and no data leaves your device. See [PRIVACY.md](PRIVACY.md).

## Limits and risks

- A saved session is as good as a password. Pick a strong master password: a short one can be guessed in minutes if someone copies your browser profile (numbers in [design §6](docs/design.md)).
- Pressing "Log out" on the website kills the saved session. Switch with the extension instead.
- Platforms can ask you to verify your identity again (a checkpoint) or end saved sessions at any time. When that happens you log in again by hand.
- Facebook's and Meta's terms don't allow sharing accounts. This tool is for accounts that belong to you.

## Install

Nothing has been released yet, and the extension isn't on the Chrome Web Store. Once a release is published, download `social-account-switcher-v<version>.zip` from the GitHub Releases page and unzip it. In `chrome://extensions`, turn on Developer mode, then click Load unpacked and pick the unzipped folder.

Requires Chrome 119 or newer.

## Develop

You need [Bun](https://bun.sh). The exact version is pinned in `package.json` (`packageManager`).

```bash
bun install                     # install dev dependencies from bun.lock
bun run dev                     # rebuild dist/ on every change, then reload the extension in chrome://extensions
bun run check                   # typecheck + lint + unit tests + build + permission check (run before every commit)
bunx playwright install chromium
bun run e2e                     # load dist/ as an unpacked extension in Chromium and smoke-test it
bun run zip                     # build release/social-account-switcher-v<version>.zip (+ .sha256)
```

| Script | What it does |
|---|---|
| `typecheck` | `tsc` in strict mode, once for `src/` and once for tests/scripts |
| `lint` | `biome ci .`, which runs lint and format checks without changing files (`bun run fix` applies fixes) |
| `test` | `bun test` unit tests with a 90% line and function coverage threshold |
| `build` | Vite build into `dist/` |
| `perm:check` | fails if `dist/manifest.json` asks for any permission outside the allow-list, or if the permission table in `PRIVACY.md` doesn't list exactly the allowed permissions |
| `e2e` | Playwright tests against the built extension |
| `zip` | build, run the permission checks, search the output for source maps, remote scripts, `eval` and network calls, then write a deterministic zip and its SHA-256 |

### Project layout

```
src/manifest.json          hand-written manifest (version is filled in from package.json at build time)
src/background/            service worker
src/lib/                   pure logic, plus ports.ts: the interfaces for every browser API
src/popup/                 popup page
public/_locales/{en,th}/   UI strings (English is the default; Thai translation)
public/icons/              toolbar and store icons
tests/unit/                bun test
tests/e2e/                 Playwright with the unpacked extension
scripts/                   permission check and release zip
docs/design.md             design, threat model and build plan
mockup/                    clickable popup mockup and its screenshots
```

### Repository rules

- The extension asks for `cookies`, `storage` and `scripting`, plus host access to facebook.com, instagram.com and youtube.com. Adding a permission means editing `src/manifest.json`, `scripts/permissions.ts` and `PRIVACY.md` in the same change, or CI fails.
- Biome rejects `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `alert`, `confirm` and `prompt` in `src/`, and the zip script searches the built files for network calls, `eval` and remote scripts again. Neither check can prove that no network call exists (code like `self['fe' + 'tch']` gets past both), so reviewers still need to look.
- Only `src/background/chrome-adapter.ts` and `src/popup/runtime.ts` may use the global `chrome`. Everything else gets browser APIs as parameters typed by the interfaces in `src/lib/ports.ts`. The reason is promises: Biome's `noFloatingPromises` catches a missing `await` on a method declared in `ports.ts`, but it doesn't read return types from `@types/chrome` and misses one on `chrome.*` directly. Each adapter function is a one-line pass-through that returns Chrome's promise unchanged or only registers a listener, so the adapters have no promise to drop.
- Two checks in `bun run lint` enforce the adapter rule outside those two files:
  - Biome rejects the global names `chrome`, `globalThis`, `self`, `window`, `frames`, `parent` and `top`. That covers `chrome.x`, `globalThis.chrome`, `self['chrome']`, `const { chrome } = window` and aliases such as `const g = globalThis`. DOM code uses `document` and `matchMedia` directly.
  - `scripts/check-chrome-access.ts` strips comments and types, then fails on any remaining word `chrome`, including a `'chrome'` string. It also catches paths Biome has no rule for, such as `document.defaultView.chrome`.
  - `tests/lint-fixtures/` holds a sample of each pattern, and `tests/unit/chrome-guardrail.test.ts` checks that both tools reject every bad sample and accept the good ones.
- These checks catch honest mistakes. They are not a sandbox. A name built at runtime (`self['ch' + 'rome']`), `eval`-like code or a reference smuggled in some other way gets past them, so code review still has to look for that.
- There are no runtime dependencies and no remote code (code review checks this). Everything that ships is in this repository.
- Dependencies are kept on their latest versions: `bun outdated` should print nothing before a change is merged. Dependabot opens weekly update PRs for packages and GitHub Actions.

## Release

1. Bump `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Commit, then tag `v<version>` and push the tag.
3. The `Release` workflow runs every check, builds the zip and attaches it and its SHA-256 to a GitHub Release.
4. Upload the zip to the Chrome Web Store by hand.

## License

[MIT](LICENSE)
