# Account profile capture (t-593)

Approved scope: lead's t-593 assignment, base e422277; implementation choices below are delegated by that brief. No new permissions, dependencies or extension network calls. TikTok remains disabled.

## Data and trust

An optional Account.profile contains displayName (80 code points), handle (80), email (254), avatar (PNG/JPEG/WebP data URL, decoded <=32768 bytes and dimensions 1..64). Strings lose control/bidi formatting characters and repeated whitespace. HTML-looking strings remain literal text. Avatar MIME, base64, magic bytes and image dimensions are checked in the worker and again at storage/UI boundaries. Only those fields survive; no page object or remote URL is stored or returned to the popup.

Profile metadata lives unencrypted beside the existing account label. This allows list rendering without decrypting sessions (the current locked screen itself remains unchanged). This is personal information visible to browser-profile readers; PRIVACY states that. Existing records stay compatible. labelSource='profile' means an untouched automatic name; absent/custom means user-owned. Rename always makes it custom, including a rename to the same string. Add passes an optional autoLabel flag; the worker rereads the page and uses its fresh matched name, never trusting a popup-supplied profile. A failed profile read does not block adding a session. Update replaces profile only from the account being captured; custom labels are never overwritten.

Both wipes remove profiles: full wipe already removes the store; session wipe strips metadata from retained YouTube shortcuts, replaces auto labels with generic YouTube names/initials, and clears quarantine because it may contain copied profile data. Custom labels on retained YouTube shortcuts remain as before and are explicitly documented.

## Reader

One self-contained MAIN-world function reads the open document; it has no imports, network calls, navigation, clicks, image-source assignments or persistent writes. Only an explicit tabId is allowed for profile reads. The worker checks the expected platform URL before/after and accepts only frame zero, same URL and matching identity. No fallback to another window/tab. Existing profile-wide FB/IG session operations without tabId remain supported but cannot read a profile. Popup profile/probe requests always carry its captured current-window tabId when available. Source failures return no profile and preserve ordinary account operation.

Ordered candidate sources (all compatibility candidates, not live-authenticated claims):
- Facebook: bounded data-sjs JSON containing the CurrentUserInitialData module (USER_ID, NAME, USERNAME, PROFILE_PICTURE); fallback own `profile.php?id=...` link under nav/header with text/title and loaded image. No feed-author or visited-profile JSON.
- Instagram: `_sharedData.config.viewer` or JSON `config.viewer` (id, full_name, username, profile_pic_url); fallback nav/header link carrying data-user-id, with its own text/title and loaded image. No profile-page target user object.
- YouTube: current ytcfg SESSION_INDEX/DELEGATED_SESSION_ID bind the read; optional already present ACCOUNT_NAME/CHANNEL_HANDLE/EMAIL/AVATAR_URL config; fallback an already rendered ytd-active-account-header-renderer (#account-name, #channel-handle, #email, #avatar img). Nothing opens the account menu. Profile identity is the same sign-in coordinates as the existing probe, not a newly claimed stable Google ID.
- TikTok: the T1 synthetic __SAM_TIKTOK_VIEWER__ signed-in object gains optional displayName/username/avatar; fallback data-e2e=profile-icon carrying data-user-id. Schema remains synthetic and feature flag stays false.

A JSON identity mismatch rejects that candidate; it is never relabelled with a cookie ID. A fallback DOM candidate must supply its own identity. JSON fields take priority, DOM fills absent fields only when identities agree. Reader bounds JSON scripts and traversal, and only inspects the listed metadata shapes. Avatar may be an already embedded small data URL or pixels from a completed, decodable image already on the page; a detached canvas scales it to <=64px. Tainted/cross-origin canvas fails closed to initials. Never fetch/assign image src. Only bounded primitive metadata crosses the scripting boundary.

## UI and proof

The existing escaped HTML renderer remains for static structure. Page-derived profile text is inserted through textContent, image src only after sanitizer validation. Rows show avatar/name and handle or email, ellipsis, existing platform color and light/dark styles. Add previews profile and prefills name; any input edit permanently marks that form custom.

Test fixtures are local, synthetic, and explicitly not proof of current live website markup. Per-platform reader and sanitizer tests plus router/storage/UI tests cover mismatched IDs, same-origin navigation during read, missing/throwing readers, custom names, legacy records, wipes and malformed images. Local Chromium e2e covers add, rename/update, mismatch, literal HTML, both themes, and zero new requests during profile extraction. Full check/e2e/outdated/zip/permissions gates run with Bun1.4.4. Final evidence includes platform/field/method/manual-verification table and new/changed locale keys. No push.
