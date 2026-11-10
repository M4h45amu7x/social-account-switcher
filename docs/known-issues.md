# Known issues in v0.2.0

## YouTube navigation during sign-in

If you open another video in the same tab shortly before YouTube sign-in finishes, verification can inspect the wrong navigation and report an expired session even though the saved account is still signed in. Sign in to the intended account, choose **Update session**, and switch again without navigating that tab until it finishes. Account indexes can also shift after a Google logout.

Automated YouTube tests use local redirects and fake `ytcfg` values. Real Google accounts, Brand Accounts and effects on other Google tabs require the [manual checks](design.md#83-tests-and-manual-checks).

## A browser API that never answers can leave a platform busy

The popup stops waiting after its request deadline and tries to read the worker's state. A timeout means the outcome is unknown; it does not cancel the worker or prove that the previous session was restored. If a browser API never settles, the worker has no overall switch deadline and that platform can remain busy until its service worker stops.

Do not repeatedly submit the same switch. Use **Try again** to refresh the state when offered. If it remains busy, stop the extension's service worker and reopen the popup. Recovery is attempted from the in-memory journal. Reloading/disabling the whole extension or restarting the browser clears that journal and the unlocked key, so recovery across those actions is not guaranteed.

## Switch steps are timed labels

The popup advances its step labels on a timer while the worker runs. They are not live measurements of cookie writes, tab loads or verification. The final success or error comes from the worker's reply, or the popup reports a timeout and refreshes its state.

## Simulated websites do not prove live-platform compatibility

The Facebook and Instagram E2E sites are local models. They issue session cookies at login and do not rotate them during normal page loads or reloads. They exercise explicit session revocation, checkpoints, tab reloads and rollback, but do not reproduce Meta's servers or account-risk decisions. These tests do not establish compatibility with session rotation or invalidation on the real websites. A passing test does not guarantee that a real switch will avoid a checkpoint or remain compatible after a website change. Use your own test accounts for the manual checks before relying on the extension.

## TikTok needs live-account validation

TikTok is enabled in the popup. On 2026-11-10 the owner confirmed that the signed-in hydration app-context user contains `uid`, `uniqueId` and `nickName` as strings, and `avatarUri` as an array. No values were recorded. Numeric UID contents and validation bounds, avatar array member types, logout/challenge shapes and the selected cookie boundary remain unconfirmed. Local rotating-session fixtures test the implementation against a model; they do not establish live-site compatibility. An unrecognized page state can prevent Add, Update session or switching. See the [candidate reader and cookie policy](design.md#13-tiktok-implementation-for-v020).

TikTok may require a new login, CAPTCHA, 2FA or another security check after switching. Device binding, session rotation or revocation can invalidate both a saved session and its rollback snapshot. Switching changes the shared account in every TikTok tab in that browser profile and reloads those tabs; unsaved drafts can be lost. Use owned test accounts for the manual checks and report failures without sharing cookie values or credentials.

## Profile fields and avatars are optional

The profile readers use candidate page fields that websites can change or stop exposing. Missing, malformed, stale or mismatched data is discarded. Add and Update session can still save a valid session without profile metadata. Update replaces metadata, so unavailable fields and photos can disappear; it preserves custom names and refreshes automatic names.

The extension reads pixels only from an image already loaded in the page, or accepts bounded embedded image data. It does not fetch an avatar URL. Images from a CDN on another origin often cannot be read because of canvas security rules, so the popup shows initials. Invalid or undecodable images also use initials. See [profile sources](profile-sources.md) for field candidates and image limits.

## Security hardening: password field while a request is pending

Submitting a valid setup or unlock request clears the password from popup state. The input can still briefly hold it in its DOM property while the request is pending, until the next popup redraw. The password is absent from HTML markup and is cleared for every result, including success, failure and timeout. Disabling the password field while waiting is not implemented yet and is not scheduled for a specific release.

## Browser and installation evidence

The manifest declares Chrome 119 as the minimum. Automated tests use Playwright's installed Chromium; intermediate Chrome versions have not all been tested. On the shared development host, the literal browser dependency-install step needs sudo and the native Load unpacked folder picker could not be exercised. Browser-level unpacked installation passed. The owner must check the first GitHub-hosted CI run and the native Chrome installation sequence when testing the release zip.
