# Social Account Switcher

Switch between your own Facebook, Instagram, YouTube and TikTok accounts from a Chrome extension popup. Log in on each website yourself; the extension saves a session you can return to later.

![Popup with fictional saved accounts](docs/images/popup.png)

The screenshot uses fictional accounts. This is the v0.2.0 release candidate. TikTok is enabled, but its current-account reader and switching compatibility still need owner checks with real accounts before publication.

Facebook, Instagram and TikTok sessions are encrypted on this device with a master password. YouTube uses Google's multi-account sign-in with a saved account index and optional channel ID; it does not replace Google cookies. There is no extension server, analytics or remote code. Account labels, identifiers and captured profile metadata, including names, handles, email and sanitized avatars, are stored locally without encryption. See [PRIVACY.md](PRIVACY.md) for the privacy policy and [SECURITY.md](SECURITY.md) for reporting a vulnerability.

Facebook and Instagram are trademarks of Meta Platforms, Inc.; YouTube is a trademark of Google LLC; TikTok is a trademark of its respective owner. The marks are not covered by this project’s MIT license. See [logo sources](public/brands/SOURCES.md). This project is not affiliated with, endorsed by or sponsored by Meta, Google or TikTok.

## Install

Requires Chrome 119 or newer, as declared in the manifest. Automated browser tests use Playwright's bundled Chromium.

When a release is available, download `social-account-switcher-v<version>.zip` from this repository's Releases page. Unzip it, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the folder containing `manifest.json`. Keep that folder in place.

To try the development version, follow the build steps below and load `dist/` instead.

### Upgrade from v0.1.x

Keep the existing extension folder and browser profile. Extract the v0.2.0 candidate ZIP over that same folder, then open `chrome://extensions` and choose **Reload** for Social Account Switcher. Do not remove the extension to upgrade: removing it deletes its saved data.

Open the extension's **Details** and check **Site access** for TikTok. Chrome may show a permission prompt or disable the extension after new host access; the exact behavior needs an owner check on the installed Chrome version. Confirm TikTok access before trying to save or switch a TikTok session. If access is missing, the popup shows guidance and leaves saved sessions unchanged. Verify that your existing accounts and custom labels remain after upgrading.

## Use

1. Open the popup and set a master password on first use. Sign in to an account on the website yourself, including any verification steps.
2. Open the popup on the website and choose **Add the account on this tab**. A matched profile can supply the name and a small avatar; otherwise the account keeps a fallback label and initials. Repeat for your other accounts. Rename a label whenever you want; later session updates preserve it.
3. Choose a saved account to switch. Unlock the vault when asked. Use **Update session** after signing in again if a saved session expires; use the edit or delete button beside an account to rename or remove it.

YouTube entries use accounts already signed in through Google. The popup still asks you to unlock when the vault is locked.

## Limits and risks

The owner observed TikTok's signed-in viewer field names and types. UID value constraints, avatar array contents, logout/challenge shapes and the cookie boundary still need live validation. An unrecognized state asks you to verify the account on TikTok; it does not mark a saved account expired. TikTok may require login or a manual security check, and switching cannot prevent account restrictions. Switching changes the account across all TikTok tabs in the same browser profile. See [the TikTok design and owner checks](docs/design.md#13-tiktok-implementation-for-v020).

- Saved session cookies can grant account access. Use a strong, unique master password: someone who copies your browser profile can try to guess it offline. The password is not stored, and there is no recovery. Forgot password removes saved Facebook/Instagram/TikTok sessions; Settings offers a separate wipe of all saved entries.
- Logging out on a website can invalidate its saved session. A platform may also require another login or a checkpoint. Complete those steps yourself, then update the saved session.
- Removing a saved entry does not log that account out of the website. Lock the vault when you finish, and protect your browser profile and device.
- YouTube account indexes can change after logout. Switching checks the resulting account and reports a mismatch. If another YouTube navigation completes just before sign-in finishes, verification can report an expired session; sign in again and choose **Update session**.
- Use accounts you own and follow each platform's terms. This extension does not bypass login, two-factor authentication or platform restrictions. Real-account YouTube behavior still needs the manual release checks in the [design](docs/design.md).

## Known issues and manual checks

Read [known issues](docs/known-issues.md) before switching: YouTube navigation can cause a false expired-session result, a browser API that never answers can leave the worker busy, and the displayed steps follow a timer. Facebook/Instagram browser tests use local models. TikTok tests use a local rotating-session fixture and a candidate viewer schema; they do not verify the live site.

With your own test accounts, complete the [manual checklist](docs/design.md#83-tests-and-manual-checks), including native **Load unpacked** installation and upgrade, live Facebook/Instagram, YouTube and TikTok checks, and GitHub-hosted CI. On each platform, add an account, check the captured name/avatar, rename it and switch back. Test **Update session** during expired-session recovery when that button is offered, and confirm your custom name survives. If the button is unavailable, record that check as untested. With two TikTok accounts, switch back and forth three times, restart Chrome and switch again. Record any login or security-check request; never send cookie values. Automated tests do not replace those checks.

## Develop

Install the Bun version pinned by `packageManager` in `package.json`, then run:

```bash
bun install --frozen-lockfile
bun run build
bun run check
bunx playwright install chromium
bun run e2e
```

Load `dist/` as an unpacked extension. `bun run dev` rebuilds it as files change; reload the extension after a build.

| Command | Purpose |
|---|---|
| `bun run check` | Strict TypeScript, lint and browser API boundaries, unit tests with coverage, build and permission checks |
| `bun run e2e` | Browser tests using an unpacked extension and local fixtures |
| `bun run icons` | Render the composite SVG to 16, 32, 48 and 128 px PNGs and a light/dark preview |
| `bun run screenshots` | Render sample popup screenshots without contacting platform websites |
| `bun run zip` | Build and check a deterministic release zip and SHA-256 file |
| `bun outdated` | Check dependency freshness; it should have no entries before integration |

The image scripts use the existing Playwright Chromium installation. README images show fictional data from the popup test fixture. The generic encryption footer is omitted because account metadata is unencrypted. They are illustrative screenshots, not evidence of a live account switch.

### Project layout

```text
assets/icon.svg             composite icon referencing the supplied platform marks
src/background/            service worker, platform switching and browser adapter
src/lib/                   storage, encryption, messages and browser API interfaces
src/popup/                 popup UI and runtime adapter
public/_locales/{en,th}/    English and Thai messages
public/icons/              generated extension icons
tests/unit/                unit tests and coverage
tests/e2e/                 unpacked-extension browser tests and popup fixtures
scripts/                   checks, image generation and release packaging
docs/design.md             design, threat model and manual release checks
docs/images/               generated popup screenshots and icon preview
```

Browser APIs enter through interfaces in `src/lib/ports.ts`. Only the background and popup adapters access the browser global. Lint and packaging checks reject direct network calls and remote code; reviewers must also inspect changes because static checks cannot detect every indirect call. No runtime dependencies ship with the extension.

### Add a language

Copy `public/_locales/en/messages.json` into a new locale directory and translate the message values, preserving keys and placeholders. Add the locale to the `Language` type and language resolver/catalog, and add its choice to the popup settings. Run the locale key/placeholder tests, the full checks and browser tests. Extend the screenshot script if images in that language are needed; adding a directory alone does not add a settings choice.

## Release

1. Finish the manual release checks in [docs/design.md](docs/design.md), including live account verification and privacy review. Update `version` in `package.json` and move the relevant changelog entries into a versioned section.
2. Run the CI checks and `bun run zip`. Inspect the zip, its icons and the unpacked popup.
3. Commit, tag `v<version>` and push the tag. The Release workflow checks the tag/version match, runs checks and attaches the zip and checksum to a repository release.
4. Share the GitHub Release zip and checksum. Distribution is through GitHub Releases.

## License

[MIT](LICENSE)
