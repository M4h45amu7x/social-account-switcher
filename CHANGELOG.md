# Changelog

Notable changes are recorded here using Keep a Changelog and semantic versioning.

## [Unreleased]

### Added

- Experimental TikTok session backend with a centralized cookie deny-list, read-only fixture viewer probe, verified rollback and recovery, and session wipe support. It stays disabled and hidden from the popup until the live-site contract is confirmed. The manifest now requests the `https://*.tiktok.com/*` host permission for it.

## [0.1.1] - 2026-11-10

### Added

- The popup opens on the platform of the page you are on. On a Facebook, Instagram or YouTube page it shows that platform's tab from the first frame, without sliding over from Facebook. On any other page it opens on the tab you picked last, or on Facebook the first time. No permission was added: Chrome gives the extension the address of the three sites only, and the popup uses it in memory without saving it.
- On a supported site, the add button reads **Add the account on this tab** and the empty list no longer offers to open the site again. The saved account that the site is logged in to shows an **On this tab** badge.

### Changed

- The tab bar and the Language and Theme controls in settings share one sliding indicator. It moves instantly when the system asks for reduced motion.

### Fixed

- Read and add accounts from the active tab in the popup's window, so separate YouTube windows use the account shown in that window.
- Keep release ZIP timestamps and checksums identical across UTC and Asia/Bangkok build environments.
- Keep the selected tab's name, icon and count visible while the tab bar animates. The indicator is no longer drawn in the view-transition layer on top of the label; it now slides behind the buttons.
- Show the selected tab and the selected Language and Theme option on a thumb that stands out from its track in the dark theme, with text contrast of at least 4.5:1 in both themes.
- Stop the old and the new page from showing text at the same time when you change tab or open settings. The new page now appears after the old one has faded out.

### Documentation

- Propose TikTok support for v0.2.0, including validation limits and implementation cards. TikTok support is not included yet.

## [0.1.0] - 2026-11-10

### Added

- Save and switch between your own Facebook and Instagram sessions, encrypted locally with a master password.
- Save YouTube account and channel choices and switch through Google's multi-account sign-in without replacing Google cookies. Verify the resulting account before reporting success.
- Recover the previous Facebook or Instagram session when a switch fails, including recovery after a service worker restart.
- Rename and remove saved accounts, update expired sessions, lock the vault and reset its saved data.
- English and Thai popup text, light and dark themes, account lists and status messages.
- A toolbar icon composed of the three platform marks, sample popup screenshots and GitHub installation instructions.
- A reproducible extension zip with a SHA-256 checksum for manual installation.
- End-to-end tests that switch accounts on stand-in Facebook and Instagram sites served locally, so no test touches the real sites.

### Documentation

- Document local data handling, the two wipe scopes, switch deadlines and known issues. Keep live-account and installation checks in the manual handoff checklist.

[Unreleased]: https://github.com/M4h45amu7x/social-account-switcher/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/M4h45amu7x/social-account-switcher/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/M4h45amu7x/social-account-switcher/releases/tag/v0.1.0
