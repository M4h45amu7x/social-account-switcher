# Changelog

Notable changes are recorded here using Keep a Changelog and semantic versioning.

## [Unreleased]

## [0.2.0] - 2026-11-10

### Added

- Save, update, switch, rename and remove TikTok sessions, with current-tab account badges and guidance when Chrome has not granted TikTok access. Switching affects all TikTok tabs in the browser profile and may require login or a manual security check.
- Capture matched profile names, handles and email when available on Facebook, Instagram, YouTube or TikTok. Use the display name for automatic labels on Add and Update session; keep labels you have renamed yourself. Show a small local avatar when the captured image can be validated; otherwise show initials.
- Add English and Thai TikTok messages and sourced TikTok logos. The manifest requests access to `https://*.tiktok.com/*`.

### Changed

- Show the selected platform name in full across four tabs. Inactive tabs show their logo and account count, with full names in tooltips and accessible names. Keyboard navigation and reduced-motion support remain available.
- Re-encode captured avatars locally as PNG before saving them. Profile capture makes no independent network requests; images on another origin often fall back to initials. Saved profile metadata is unencrypted and both wipe scopes remove it.

### Fixed

- Keep at least 5 px between platform logos, names and account counts in the four-tab popup.

- Wait for all reloaded TikTok tabs before saving a switched or recovered session, so delayed responses cannot leave an older session token in the vault.
- Keep unknown TikTok page states separate from expired sessions. Verify a bounded candidate viewer record instead of using content-author or profile-page identities.
- Keep adding Facebook or Instagram accounts from unrelated tabs through existing cookies, without borrowing another tab's profile information.

### Release notes

- This release candidate still needs owner checks with real accounts before publication. The owner observed TikTok's signed-in viewer field names and types; UID value constraints, avatar array contents, logout/challenge shapes and the cookie boundary remain unconfirmed. Automated browser tests use local stand-ins, including rotating TikTok sessions, rollback, worker recovery, migration and both wipe scopes.

## [0.1.2] - 2026-11-10

### Fixed

- Keep tab icons and account counts inside their buttons with wider system fonts. Long platform names shorten with an ellipsis when space runs out; the full name remains available in the tooltip and accessible name.

### Release notes

- The public v0.1.1 tag has no release package because its release checks failed on tab label overflow. Version 0.1.2 includes all changes from v0.1.1 and this fix.

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

[Unreleased]: https://github.com/M4h45amu7x/social-account-switcher/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/M4h45amu7x/social-account-switcher/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/M4h45amu7x/social-account-switcher/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/M4h45amu7x/social-account-switcher/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/M4h45amu7x/social-account-switcher/releases/tag/v0.1.0
