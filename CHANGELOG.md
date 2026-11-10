# Changelog

Notable changes are recorded here using Keep a Changelog and semantic versioning.

## [Unreleased]

### Fixed

- Keep release ZIP timestamps and checksums identical across UTC and Asia/Bangkok build environments.

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

[Unreleased]: https://github.com/M4h45amu7x/social-account-switcher/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/M4h45amu7x/social-account-switcher/releases/tag/v0.1.0
