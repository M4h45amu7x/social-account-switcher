# Privacy Policy

_Last updated: 2026-11-09_

> Status: Social Account Switcher is in development and hasn't been released. Version 0.1.0 only shows a placeholder popup and stores no account data. This policy describes how the extension will handle data once account switching ships. This note will be removed after every statement below has been checked against the released code.

Social Account Switcher is a browser extension that lets you switch between your own Facebook, Instagram and YouTube accounts. This page explains what it stores, where, and why.

Everything the extension stores stays on your device. It has no server and no analytics, it doesn't sell or share data, and it never sends cookies or account details anywhere.

## What the extension stores

| Data | Where | Why |
|---|---|---|
| The names you give your accounts, the platform, the platform's user ID (Facebook `c_user`, Instagram `ds_user_id`), and when each account was added and last used | `chrome.storage.local` on your device | To show your account list |
| For YouTube: the Google account number (`authuser`) and channel ID (`pageid`) | `chrome.storage.local` | To switch with Google's own multi-account sign-in. No Google cookies are stored. |
| Facebook and Instagram session cookies for each saved account | `chrome.storage.local`, encrypted (AES-256-GCM, with a key derived from your master password using PBKDF2-SHA-256 and 600,000 iterations) | To switch accounts without logging in again |
| The unlocked encryption key, and a short-lived record of a switch in progress | `chrome.storage.session`, which is held in memory and never written to disk | So you only unlock once, and so an interrupted switch can be undone |

The extension never stores your Facebook, Instagram or Google passwords, and it never fills in login forms. You always log in yourself.

### When the in-memory data goes away

`chrome.storage.session` is cleared, and the extension locks again, when any of these happens:

- you close Chrome
- the extension is reloaded, updated, disabled or removed
- you press the lock button

### How strong the encryption is

Session cookies work like passwords, so the encryption is only as strong as your master password. If someone copies your browser profile, they can try passwords offline as fast as their hardware allows. The extension's delay after wrong attempts doesn't slow that down. A 10-character random password, or a phrase of four random words, would take thousands of years to guess on current hardware. A common word or a 6-digit PIN would fall in hours or minutes. Our estimates are in [docs/design.md §6](docs/design.md).

## Permissions and what each one is for

| Permission | Used for |
|---|---|
| `cookies` | Reading, removing and restoring Facebook and Instagram session cookies when you switch. Only the hosts below are reachable. |
| `storage` | Keeping the data described above on your device (`chrome.storage.local` and `chrome.storage.session`). The extension never uses `chrome.storage.sync`, so nothing is uploaded to your Google account. |
| `scripting` | Reading which Google account and channel the open YouTube page is using, so it can be saved or switched to. |
| `*://*.facebook.com/*`, `*://*.instagram.com/*`, `*://*.youtube.com/*` | Limiting cookie access to these three sites and finding their tabs to reload after a switch. No other site is accessible. |

The extension doesn't request access to google.com, to all websites, to your browsing history or to network traffic.

## What is never collected

- No analytics, telemetry, crash reporting or advertising IDs.
- No network requests made by the extension itself. Only the pages you open load content from their own sites.
- No remote code. Everything the extension runs is inside the package you installed.

## Deleting your data

- To remove one account, open the popup and press the trash icon next to it, then confirm.
- To remove everything, choose "Forgot password" and confirm the wipe, or remove the extension from `chrome://extensions`. Removing the extension deletes all of its storage.

Deleting data in the extension never deletes or changes your accounts on Facebook, Instagram or YouTube.

## Children

The extension isn't aimed at children and doesn't knowingly handle children's data.

## Changes

Any change to this policy goes into this file and [CHANGELOG.md](CHANGELOG.md). Any new permission will be listed here before a release that uses it.

## Contact

Open an issue in this repository. For security problems, see [SECURITY.md](SECURITY.md).
