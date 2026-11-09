# Security Policy

This extension handles session cookies, which are as sensitive as passwords.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub's Security > Report a vulnerability form in this repository (private vulnerability reporting).

Include:

- what an attacker can do, and what they need first (for example, local access or a malicious website)
- steps to reproduce, ideally against the latest release
- the extension version and Chrome version

We aim to reply within 7 days and to ship a fix for confirmed issues as fast as their severity calls for. You'll be credited in the release notes unless you'd rather not be.

## Supported versions

Only the latest release gets security fixes.

## In scope

- Saved sessions being read by anything other than the extension's own pages
- Data leaving the device in any way
- Weaknesses in how the vault is encrypted or how the key is handled
- Ways to make the extension request or use more permissions than it declares

## Out of scope

- Malware that already controls your computer or Chrome process, since it can read Chrome's own cookies anyway
- A weak master password chosen by the user ([design §6](docs/design.md) explains the trade-off)
- Facebook, Instagram or Google ending sessions or asking you to verify your identity again
