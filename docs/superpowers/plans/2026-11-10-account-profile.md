# Account Profile Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. This session implements the already authorized t-593 brief.

**Goal:** Add matched, local-only account profile capture and safe popup display.
**Architecture:** Self-contained page reader plus worker validation; optional sanitized account metadata; explicit automatic/custom label provenance; UI receives bounded fields only.
**Tech Stack:** TypeScript, Bun 1.4.4, injected Chrome ports, existing DOM renderer and Playwright.
**Spec:** ../specs/2026-11-10-account-profile.md

## Global Constraints
- Base e422277; branch card/t-593; no main checkout changes or push.
- No added permissions, dependencies or extension network calls; TikTok stays disabled.
- Evidence /home/n1/Desktop/sam-worktrees/evidence/t-593/; close all owned processes.

## Review Focus
- Same-origin navigation/identity changes during extraction must discard profile (task 1/2).
- Bad data URL MIME, bytes, size or dimensions must fall back to initials (task 1/3).
- Rename-to-identical-string and legacy labels remain custom (task 2).
- Session wipe cannot retain profile in YouTube auto labels or quarantine (task 2).
- Missing page metadata or tainted canvas cannot fail account add/update (task 1/3).

## Task 1: Reader and validation
Files: src/lib/profile.ts, src/background/profile.ts; tests/unit/profile.test.ts, profile-reader.test.ts.
Interfaces: AccountProfile; sanitizeProfile(unknown): AccountProfile|undefined; readPageProfile(): unknown; readProfile({tabs,scripting}, platform, identity, tabId?): Promise<AccountProfile|undefined>.
- [x] Write per-platform JSON/DOM, mismatch, bounded text/image and exact-tab tests; observe failing assertions.
- [x] Implement bounded readers, ordered sources, PNG/JPEG/WebP magic and dimension validation, existing-image canvas fallback.
- [x] Run focused tests and record green.

## Task 2: Capture and storage
Files: src/background/router.ts, service-worker.ts; src/lib/store.ts, messages.ts; tests/fakes/harness.ts; tests/unit/profile-router.test.ts.
Interfaces: Account.profile?, labelSource?; optional addCurrent.autoLabel; profile returned by account.probe; automatic/custom label semantics.
- [x] Add failing real-router tests for probe/add/update, identity mismatch, legacy/custom labels, migration and both wipes.
- [x] Inject scripting, read and validate profiles at exact tab/identity, store only sanitized allowlisted fields, strip retained profile on session wipe.
- [x] Run focused tests and record green.

## Task 3: Popup and integration
Files: src/popup/{state,controller,bridge,view}.ts and popup.css; tests/unit/profile-popup.test.ts; tests/e2e/profile.spec.ts and profile fixture; PRIVACY.md, CHANGELOG.md, docs/profile-sources.md.
Interfaces: Add form optional profile/autoLabel; AccountView.profile?; existing request types extended compatibly.
- [x] Add failing UI/e2e tests for prefill, rename-update preservation, mismatch, literal HTML, avatars and themes.
- [x] Implement UI data propagation, textContent profile display and image fallback; update privacy and source/manual-check documentation.
- [ ] Run focused green tests, then full check/e2e, outdated, zip and perm:check. Inspect screenshots and diff; review branch; commit without push and deliver final evidence.
